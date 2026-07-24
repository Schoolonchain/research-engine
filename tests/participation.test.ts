import { randomUUID } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { buildParticipationApi } from "../src/participation/api.js";
import {
  DuplicateSupportError,
  ParticipationConfigurationError,
  ParticipationConflictError,
  ParticipationContentionError,
  ParticipationRateLimitError,
  SupportNotFoundError,
} from "../src/participation/errors.js";
import type {
  ParticipationIdentity,
  ParticipationRatePolicy,
} from "../src/participation/model.js";
import {
  retryOnEventConcurrency,
  SupportService,
} from "../src/participation/support-service.js";
import { EventConcurrencyError } from "../src/events/event-store.js";
import type { ActorContext } from "../src/proposals/model.js";
import { ProposalService } from "../src/proposals/proposal-service.js";

const HMAC_KEY = "test-only-participation-key-32-bytes-minimum";
const KEYRING = Object.freeze([{ id: "legacy-v1", key: HMAC_KEY }]);

class PGliteExecutor implements DatabaseExecutor {
  public constructor(private readonly database: PGlite | Transaction) {}

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.database.query<Row>(sql, [...values]);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }
}

class PGliteTransactionalDatabase implements TransactionalDatabase {
  public constructor(private readonly database: PGlite) {}

  public transaction<Result>(
    operation: (transaction: DatabaseExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction((transaction) =>
      operation(new PGliteExecutor(transaction)),
    );
  }
}

async function actor(database: PGlite): Promise<ActorContext> {
  const result = await database.query<{ id: string }>(
    "INSERT INTO actors (kind) VALUES ('USER') RETURNING id",
  );
  const actorId = result.rows[0]?.id;
  if (!actorId) throw new Error("Actor insert returned no ID");
  return Object.freeze({ actorId, role: "USER" });
}

describe("Participation supports and anti-abuse", () => {
  let database: PGlite;
  let transactionalDatabase: PGliteTransactionalDatabase;
  let proposalService: ProposalService;
  let supportService: SupportService;
  let owner: ActorContext;

  beforeEach(async () => {
    database = new PGlite();
    const migrationExecutor = {
      query: async (sql: string, values: readonly unknown[] = []) =>
        values.length === 0
          ? database.exec(sql)
          : database.query(sql, [...values]),
    };
    await migrate(migrationExecutor, await loadMigrations());
    transactionalDatabase = new PGliteTransactionalDatabase(database);
    proposalService = new ProposalService(transactionalDatabase);
    supportService = new SupportService(transactionalDatabase, KEYRING);
    owner = await actor(database);
  });

  afterEach(async () => {
    await database.close();
  });

  async function openProposal(title: string) {
    const created = await proposalService.create(owner, {
      title,
      centralQuestion: `Is ${title} supported by participants?`,
    });
    return proposalService.open(owner, created.publicId, {
      expectedVersion: created.version,
    });
  }

  function identity(
    subjectId: string,
    networkSignal = "shared-network",
  ): ParticipationIdentity {
    return {
      subjectId,
      actorId: owner.actorId,
      networkSignal,
    };
  }

  it("adds support atomically without creating research work", async () => {
    const proposal = await openProposal("Atomic support");
    const result = await supportService.add(
      identity("participant-1"),
      proposal.publicId,
    );

    expect(result.supported).toBe(true);
    expect(result.supportCount).toBe(1);
    expect(result.proposalVersion).toBe(proposal.version + 1);

    const state = await database.query<{
      supports: number;
      proposal_count: number;
      support_events: number;
      jobs: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM supports WHERE status = 'ACTIVE') AS supports,
        (SELECT support_count FROM proposals) AS proposal_count,
        (
          SELECT count(*)::int FROM domain_events
          WHERE event_type = 'support_added'
        ) AS support_events,
        (SELECT count(*)::int FROM research_jobs) AS jobs
    `);
    expect(state.rows[0]).toEqual({
      supports: 1,
      proposal_count: 1,
      support_events: 1,
      jobs: 0,
    });
  });

  it("rejects duplicate support even when the network signal changes", async () => {
    const proposal = await openProposal("Duplicate resistance");
    await supportService.add(
      identity("stable-subject", "network-a"),
      proposal.publicId,
    );

    await expect(
      supportService.add(
        identity("stable-subject", "network-b"),
        proposal.publicId,
      ),
    ).rejects.toBeInstanceOf(DuplicateSupportError);

    const count = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM supports WHERE status = 'ACTIVE'",
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("allows different subjects behind one shared network", async () => {
    const proposal = await openProposal("Shared network");

    await supportService.add(
      identity("subject-a", "same-network"),
      proposal.publicId,
    );
    const second = await supportService.add(
      identity("subject-b", "same-network"),
      proposal.publicId,
    );

    expect(second.supportCount).toBe(2);
  });

  it("revokes support and permits a later fresh support", async () => {
    const proposal = await openProposal("Revocable support");
    const participant = identity("revoking-subject");

    await supportService.add(participant, proposal.publicId);
    const revoked = await supportService.revoke(
      participant,
      proposal.publicId,
    );
    expect(revoked.supported).toBe(false);
    expect(revoked.supportCount).toBe(0);

    const restored = await supportService.add(
      participant,
      proposal.publicId,
    );
    expect(restored.supportCount).toBe(1);

    const history = await database.query<{ status: string }>(
      "SELECT status FROM supports ORDER BY created_at, id",
    );
    expect(history.rows.map((row) => row.status).sort()).toEqual([
      "ACTIVE",
      "REVOKED",
    ]);
  });

  it("rejects revocation when no active support exists", async () => {
    const proposal = await openProposal("Missing support");
    await expect(
      supportService.revoke(identity("no-support"), proposal.publicId),
    ).rejects.toBeInstanceOf(SupportNotFoundError);
  });

  it("persists bounded abuse counters and signals without raw identifiers", async () => {
    const policy: ParticipationRatePolicy = {
      version: 7,
      windowSeconds: 60,
      retentionSeconds: 600,
      subjectLimit: 2,
      networkLimit: 100,
      globalLimit: 100,
    };
    const limited = new SupportService(
      transactionalDatabase,
      KEYRING,
      policy,
    );
    const proposals = await Promise.all([
      openProposal("Limit one"),
      openProposal("Limit two"),
      openProposal("Limit three"),
    ]);
    const rawSubject = "private-stable-subject";
    const rawNetwork = "private-network-signal";
    const participant = identity(rawSubject, rawNetwork);

    await limited.add(participant, proposals[0]!.publicId);
    await limited.add(participant, proposals[1]!.publicId);
    await expect(
      limited.add(participant, proposals[2]!.publicId),
    ).rejects.toBeInstanceOf(ParticipationRateLimitError);

    const signals = await database.query<{
      key_hash: string;
      policy_version: number;
      expires: boolean;
    }>(`
      SELECT
        key_hash,
        policy_version,
        expires_at > observed_at AS expires
      FROM abuse_signals
    `);
    expect(signals.rows).toHaveLength(1);
    expect(signals.rows[0]?.key_hash).not.toContain(rawSubject);
    expect(signals.rows[0]?.key_hash).not.toContain(rawNetwork);
    expect(signals.rows[0]?.key_hash).toHaveLength(64);
    expect(signals.rows[0]?.policy_version).toBe(7);
    expect(signals.rows[0]?.expires).toBe(true);

    const active = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM supports WHERE status = 'ACTIVE'",
    );
    expect(active.rows[0]?.count).toBe(2);
  });

  it("preserves deduplication and revocation across key rotation", async () => {
    const proposal = await openProposal("Rotating identity keys");
    const participant = identity("rotation-stable-subject", "rotation-network");
    const oldService = new SupportService(transactionalDatabase, KEYRING);
    await oldService.add(participant, proposal.publicId);

    const rotated = new SupportService(transactionalDatabase, [
      {
        id: "rotation-v2",
        key: "new-test-participation-key-32-bytes-minimum",
      },
      ...KEYRING,
    ]);

    await expect(
      rotated.add(participant, proposal.publicId),
    ).rejects.toBeInstanceOf(DuplicateSupportError);

    await rotated.revoke(participant, proposal.publicId);
    await rotated.add(participant, proposal.publicId);

    const rows = await database.query<{
      status: string;
      subject_key_id: string;
    }>(
      `
        SELECT status, subject_key_id
        FROM supports
        ORDER BY created_at, id
      `,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter((row) => row.status === "ACTIVE")).toEqual([
      { status: "ACTIVE", subject_key_id: "rotation-v2" },
    ]);
    expect(rows.rows.filter((row) => row.status === "REVOKED")).toHaveLength(1);

    const migrations = await database.query<{
      from_key_id: string;
      to_key_id: string;
    }>(
      `
        SELECT from_key_id, to_key_id
        FROM participation_identity_migrations
      `,
    );
    expect(migrations.rows).toEqual([
      { from_key_id: "legacy-v1", to_key_id: "rotation-v2" },
    ]);

    const usage = await database.query<{
      key_id: string;
      active_support_count: number;
    }>(
      `
        SELECT key_id, active_support_count
        FROM participation_key_registry
        ORDER BY key_id
      `,
    );
    expect(usage.rows).toEqual([
      { key_id: "legacy-v1", active_support_count: 0 },
      { key_id: "rotation-v2", active_support_count: 1 },
    ]);
  });

  it("blocks premature retirement of a key used by active supports", async () => {
    const proposal = await openProposal("Premature key retirement");
    const participant = identity("retirement-stable-subject");
    await supportService.add(participant, proposal.publicId);

    const missingLegacyKey = new SupportService(transactionalDatabase, [
      {
        id: "rotation-v2",
        key: "new-test-participation-key-32-bytes-minimum",
      },
    ]);

    await expect(missingLegacyKey.assertReady()).rejects.toThrow(
      "legacy-v1",
    );
    await expect(
      missingLegacyKey.add(participant, proposal.publicId),
    ).rejects.toBeInstanceOf(ParticipationConfigurationError);

    const state = await database.query<{
      support_count: number;
      active_rows: number;
    }>(`
      SELECT
        (SELECT support_count FROM proposals) AS support_count,
        (
          SELECT count(*)::int FROM supports WHERE status = 'ACTIVE'
        ) AS active_rows
    `);
    expect(state.rows[0]).toEqual({ support_count: 1, active_rows: 1 });
  });

  it("rejects different key material reused under an existing key ID", async () => {
    const proposal = await openProposal("Immutable key identifiers");
    const participant = identity("same-id-different-secret");
    await supportService.add(participant, proposal.publicId);

    const replacedSecret = new SupportService(transactionalDatabase, [
      {
        id: "legacy-v1",
        key: "different-participation-key-32-bytes-minimum",
      },
    ]);

    await expect(replacedSecret.assertReady()).rejects.toThrow(
      "bound to different key material",
    );
    await expect(
      replacedSecret.add(participant, proposal.publicId),
    ).rejects.toBeInstanceOf(ParticipationConfigurationError);

    const state = await database.query<{
      support_count: number;
      active_rows: number;
    }>(`
      SELECT
        (SELECT support_count FROM proposals) AS support_count,
        (
          SELECT count(*)::int FROM supports WHERE status = 'ACTIVE'
        ) AS active_rows
    `);
    expect(state.rows[0]).toEqual({ support_count: 1, active_rows: 1 });
  });

  it("does not retain a subject lock for an unavailable proposal", async () => {
    await expect(
      supportService.add(identity("invalid-proposal-subject"), randomUUID()),
    ).rejects.toBeInstanceOf(ParticipationConflictError);

    const locks = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM participation_subject_locks",
    );
    expect(locks.rows[0]?.count).toBe(0);
  });

  it("purges expired subject locks during participation", async () => {
    await database.query(
      `
        INSERT INTO participation_subject_locks (
          key_hash, created_at, last_used_at, expires_at
        )
        VALUES (
          $1,
          CURRENT_TIMESTAMP - interval '2 days',
          CURRENT_TIMESTAMP - interval '2 days',
          CURRENT_TIMESTAMP - interval '1 day'
        )
      `,
      ["f".repeat(64)],
    );
    const proposal = await openProposal("Expired lock cleanup");
    await supportService.add(identity("cleanup-subject"), proposal.publicId);

    const expired = await database.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM participation_subject_locks
        WHERE expires_at < CURRENT_TIMESTAMP
      `,
    );
    expect(expired.rows[0]?.count).toBe(0);
  });

  it("keeps rate-limit counters auditable across policy versions", async () => {
    const first = await openProposal("Policy version one");
    const second = await openProposal("Policy version two");
    const participant = identity("policy-subject", "policy-network");
    const policyOne: ParticipationRatePolicy = {
      version: 1,
      windowSeconds: 60,
      retentionSeconds: 600,
      subjectLimit: 20,
      networkLimit: 120,
      globalLimit: 2_000,
    };
    const policyTwo: ParticipationRatePolicy = {
      ...policyOne,
      version: 2,
      subjectLimit: 100,
    };

    await new SupportService(
      transactionalDatabase,
      KEYRING,
      policyOne,
    ).add(participant, first.publicId);
    await new SupportService(
      transactionalDatabase,
      KEYRING,
      policyTwo,
    ).add(participant, second.publicId);

    const counters = await database.query<{
      policy_version: number;
      limit_snapshot: number;
      count: number;
    }>(
      `
        SELECT policy_version, limit_snapshot, count
        FROM participation_rate_limits
        WHERE action = 'support_add' AND scope = 'SUBJECT'
        ORDER BY policy_version
      `,
    );
    expect(counters.rows).toEqual([
      { policy_version: 1, limit_snapshot: 20, count: 1 },
      { policy_version: 2, limit_snapshot: 100, count: 1 },
    ]);
  });

  it("supports concurrent attempts without corrupting the materialized count", async () => {
    const proposal = await openProposal("Concurrent participation");
    const results = await Promise.all([
      supportService.add(identity("concurrent-a"), proposal.publicId),
      supportService.add(identity("concurrent-b"), proposal.publicId),
    ]);

    expect(results.map((result) => result.supportCount).sort()).toEqual([1, 2]);
    const state = await database.query<{
      support_count: number;
      active: number;
      events: number;
    }>(`
      SELECT
        (SELECT support_count FROM proposals) AS support_count,
        (
          SELECT count(*)::int FROM supports WHERE status = 'ACTIVE'
        ) AS active,
        (
          SELECT count(*)::int FROM domain_events
          WHERE event_type = 'support_added'
        ) AS events
    `);
    expect(state.rows[0]).toEqual({
      support_count: 2,
      active: 2,
      events: 2,
    });
  });

  it("converts exhausted optimistic retries into explicit contention", async () => {
    let attempts = 0;
    await expect(
      retryOnEventConcurrency(
        async () => {
          attempts += 1;
          throw new EventConcurrencyError("proposal", "aggregate", 1);
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ParticipationContentionError);
    expect(attempts).toBe(3);
  });

  it("maps exhausted contention to a retryable HTTP response", async () => {
    const application = buildParticipationApi({
      supports: {
        add: async () => {
          throw new ParticipationContentionError();
        },
        revoke: async () => {
          throw new ParticipationContentionError();
        },
      },
      resolveIdentity: async () => identity("contention-subject"),
    });

    const response = await application.inject({
      method: "POST",
      url: `/proposals/${randomUUID()}/supports`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual({ error: "TEMPORARY_CONTENTION" });
    await application.close();
  });

  it("exposes a subject-resolved API and never trusts body identity", async () => {
    const proposal = await openProposal("Participation API");
    const identities = new Map<string, ParticipationIdentity>([
      ["real-token", identity("resolved-subject")],
    ]);
    const application = buildParticipationApi({
      supports: supportService,
      resolveIdentity: async (request) => {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) return undefined;
        return identities.get(header.slice("Bearer ".length));
      },
    });

    const unauthorized = await application.inject({
      method: "POST",
      url: `/proposals/${proposal.publicId}/supports`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const trapped = await application.inject({
      method: "POST",
      url: `/proposals/${proposal.publicId}/supports`,
      headers: { authorization: "Bearer real-token" },
      payload: { website: "https://bot.example" },
    });
    expect(trapped.statusCode).toBe(202);

    const added = await application.inject({
      method: "POST",
      url: `/proposals/${proposal.publicId}/supports`,
      headers: { authorization: "Bearer real-token" },
      payload: {
        subjectId: "spoofed-subject",
        networkSignal: "spoofed-network",
      },
    });
    expect(added.statusCode).toBe(201);

    const duplicate = await application.inject({
      method: "POST",
      url: `/proposals/${proposal.publicId}/supports`,
      headers: { authorization: "Bearer real-token" },
      payload: { subjectId: "another-spoof" },
    });
    expect(duplicate.statusCode).toBe(409);

    const active = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM supports WHERE status = 'ACTIVE'",
    );
    expect(active.rows[0]?.count).toBe(1);

    await application.close();
  });
});
