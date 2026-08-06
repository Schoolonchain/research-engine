import { createHash } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdministrationService } from "../src/admin/administration-service.js";
import { buildAdministrationApi } from "../src/admin/api.js";
import {
  AdministrativeAuthenticationError,
  AdministrativeAuthorizationError,
  AdministrativeConflictError,
  AdministrativeReauthenticationRequiredError,
} from "../src/admin/errors.js";
import type { AdministrativeContext, AdministrativeRole } from "../src/admin/model.js";
import { AdministrativeSessionService } from "../src/admin/session-service.js";
import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { ScorePolicyManager } from "../src/scoring/policy-manager.js";
import { ScoreService } from "../src/scoring/score-service.js";
import { ProposalService } from "../src/proposals/proposal-service.js";

class Executor implements DatabaseExecutor {
  public constructor(private readonly db: PGlite | Transaction) {}
  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.db.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}
class Database implements TransactionalDatabase {
  public constructor(private readonly db: PGlite) {}
  public transaction<Result>(
    operation: (tx: DatabaseExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.db.transaction((tx) => operation(new Executor(tx)));
  }
}

describe("Phase 7 administrative security", () => {
  let raw: PGlite;
  let database: Database;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length ? raw.query(sql, [...values]) : raw.exec(sql) },
      await loadMigrations(),
    );
    database = new Database(raw);
  });

  afterEach(async () => raw.close());

  async function identity(role: AdministrativeRole, subject: string): Promise<string> {
    const actor = await raw.query<{ id: string }>(
      "INSERT INTO actors (kind) VALUES ('ADMIN') RETURNING id",
    );
    const result = await raw.query<{ id: string }>(
      `INSERT INTO administrative_identities (actor_id, issuer, subject, role)
       VALUES ($1,'https://idp.example',$2,$3) RETURNING id`,
      [actor.rows[0]!.id, subject, role],
    );
    return result.rows[0]!.id;
  }

  async function context(
    role: AdministrativeRole,
    subject: string,
  ): Promise<{ context: AdministrativeContext; accessToken: string; csrfToken: string }> {
    await identity(role, subject);
    const sessions = new AdministrativeSessionService(database);
    const credentials = await sessions.issue({
      issuer: "https://idp.example",
      subject,
      authenticationMethods: ["pwd", "mfa"],
      authenticatedAt: new Date(),
    });
    return {
      context: await sessions.authenticate(
        credentials.accessToken,
        credentials.csrfToken,
        true,
      ),
      accessToken: credentials.accessToken,
      csrfToken: credentials.csrfToken,
    };
  }

  async function createEligible(
    policyAdmin: AdministrativeContext,
    suffix: string,
    activate = true,
  ): Promise<{ proposalPublicId: string; sourcePublicId: string }> {
    if (activate) {
      await new ScorePolicyManager(database).activate(policyAdmin, {
        version: 1, priorityThreshold: 0.55, progressThreshold: 0.3,
        confidenceThreshold: 0.4, minimumSupports: 3,
      }, `activate-initial-${suffix}`);
    }
    const proposal = await raw.query<{ id: string; public_id: string }>(
      `INSERT INTO proposals (title, central_question, status, support_count)
       VALUES ($1,'Is eligibility fresh?','OPEN',50) RETURNING id, public_id`,
      [`Eligible ${suffix}`],
    );
    const source = await raw.query<{ id: string; public_id: string }>(
      `INSERT INTO sources (
        proposal_id, kind, original_url, canonical_url, moderation_status
      ) VALUES ($1,'URL',$2,$3,'ACCEPTED') RETURNING id, public_id`,
      [proposal.rows[0]!.id, `https://${suffix}.example/source`,
        `https://${suffix}.example/source`],
    );
    await raw.query(
      `INSERT INTO aggregate_streams (aggregate_type, aggregate_id, current_sequence)
       VALUES ('proposal',$1,1)`, [proposal.rows[0]!.id],
    );
    for (let index = 0; index < 10; index += 1) {
      const claim = await raw.query<{ id: string }>(
        `INSERT INTO claims (proposal_id, source_id, statement, moderation_status)
         VALUES ($1,$2,$3,'ACCEPTED') RETURNING id`,
        [proposal.rows[0]!.id, source.rows[0]!.id, `Claim ${suffix}-${index}`],
      );
      for (let evidenceIndex = 0; evidenceIndex < 2; evidenceIndex += 1) {
        await raw.query(
          `INSERT INTO evidence (
            claim_id, source_id, stance, locator, moderation_status
          ) VALUES ($1,$2,'SUPPORTS',$3,'ACCEPTED')`,
          [claim.rows[0]!.id, source.rows[0]!.id,
            `${suffix}-${index}-${evidenceIndex}`],
        );
      }
    }
    const proposalPublicId = proposal.rows[0]!.public_id;
    expect((await new ScoreService(database).recalculate(proposalPublicId)).eligible).toBe(true);
    return { proposalPublicId, sourcePublicId: source.rows[0]!.public_id };
  }

  it("requires a pre-provisioned federated identity and MFA", async () => {
    const sessions = new AdministrativeSessionService(database);
    await identity("MODERATOR", "moderator");
    await expect(sessions.issue({
      issuer: "https://idp.example",
      subject: "moderator",
      authenticationMethods: ["pwd"],
      authenticatedAt: new Date(),
    })).rejects.toBeInstanceOf(AdministrativeAuthenticationError);
    await expect(sessions.issue({
      issuer: "https://idp.example",
      subject: "unknown",
      authenticationMethods: ["mfa"],
      authenticatedAt: new Date(),
    })).rejects.toBeInstanceOf(AdministrativeAuthenticationError);
  });

  it("stores only token hashes and enforces CSRF and revocation", async () => {
    const issued = await context("MODERATOR", "csrf-moderator");
    const sessions = new AdministrativeSessionService(database);
    await expect(
      sessions.authenticate(issued.accessToken, "wrong", true),
    ).rejects.toBeInstanceOf(AdministrativeAuthorizationError);
    const stored = await raw.query<{ token_hash: string; csrf_hash: string }>(
      "SELECT token_hash, csrf_hash FROM administrative_sessions",
    );
    expect(stored.rows[0]!.token_hash).toBe(
      createHash("sha256").update(issued.accessToken).digest("hex"),
    );
    expect(stored.rows[0]!.csrf_hash).not.toBe(issued.csrfToken);
    await Promise.all(Array.from({ length: 8 }, () =>
      sessions.revoke(issued.context, "revoke-session-1")));
    await expect(
      sessions.authenticate(issued.accessToken),
    ).rejects.toBeInstanceOf(AdministrativeAuthenticationError);
    const actions = await raw.query<{ action: string }>(
      "SELECT action FROM administrative_action_audit ORDER BY recorded_at, action",
    );
    expect(actions.rows.map((row) => row.action).sort()).toEqual([
      "administrative_session_issued", "administrative_session_revoked",
    ]);
    expect((await raw.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM administrative_mutation_receipts
       WHERE operation = 'revoke_session'`,
    )).rows[0]!.count).toBe(1);
  });

  it("revalidates revoked, suspended, role-changed and MFA-lost authority", async () => {
    const administration = new AdministrationService(database);
    const proposal = await raw.query<{ id: string }>(
      `INSERT INTO proposals (title, central_question)
       VALUES ('Authority','Is stale authority rejected?') RETURNING id`,
    );
    const source = await raw.query<{ public_id: string }>(
      `INSERT INTO sources (proposal_id, kind, original_url, canonical_url)
       VALUES ($1,'URL','https://authority.example','https://authority.example/')
       RETURNING public_id`, [proposal.rows[0]!.id],
    );
    for (const [subject, mutation] of [
      ["revoked", "UPDATE administrative_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1"],
      ["suspended", "UPDATE administrative_identities SET status = 'SUSPENDED' WHERE id = $1"],
      ["role-changed", "UPDATE administrative_identities SET role = 'VALIDATOR' WHERE id = $1"],
      ["mfa-lost", "UPDATE administrative_sessions SET mfa_verified = false WHERE id = $1"],
    ] as const) {
      const issued = await context("MODERATOR", subject);
      const targetId = subject === "suspended" || subject === "role-changed"
        ? issued.context.identityId : issued.context.sessionId;
      await raw.query(mutation, [targetId]);
      await expect(administration.moderate(
        issued.context, "SOURCE", source.rows[0]!.public_id, "ACCEPTED",
        `Rejected stale ${subject}`, `stale-${subject}-1`,
      )).rejects.toBeInstanceOf(AdministrativeAuthorizationError);
      if (subject === "role-changed") {
        expect((await administration.listEligible(issued.context)).items).toHaveLength(0);
      } else {
        await expect(administration.listEligible(issued.context))
          .rejects.toBeInstanceOf(AdministrativeAuthorizationError);
      }
    }
  });

  it("separates moderation role and records event, Outbox and immutable audit", async () => {
    const moderator = await context("MODERATOR", "moderation-user");
    const policyAdmin = await context("POLICY_ADMIN", "policy-user");
    const proposal = await raw.query<{ id: string }>(
      `INSERT INTO proposals (title, central_question)
       VALUES ('Moderation','Is this controlled?') RETURNING id`,
    );
    const source = await raw.query<{ public_id: string }>(
      `INSERT INTO sources (
        proposal_id, kind, original_url, canonical_url
       ) VALUES ($1,'URL','https://example.com','https://example.com/')
       RETURNING public_id`,
      [proposal.rows[0]!.id],
    );
    const administration = new AdministrationService(database);
    await expect(administration.moderate(
      policyAdmin.context, "SOURCE", source.rows[0]!.public_id,
      "ACCEPTED", "Attempted by wrong role", "moderate-wrong-role-1",
    )).rejects.toBeInstanceOf(AdministrativeAuthorizationError);
    await administration.moderate(
      moderator.context, "SOURCE", source.rows[0]!.public_id,
      "ACCEPTED", "Source meets moderation policy", "moderate-source-1",
    );
    const state = await raw.query<{
      status: string; audits: number; events: number; outbox: number; jobs: number; auth: number;
    }>(`
      SELECT (SELECT moderation_status FROM sources) AS status,
        (SELECT count(*)::int FROM administrative_action_audit
          WHERE action = 'moderation_decided') AS audits,
        (SELECT count(*)::int FROM domain_events
          WHERE event_type = 'moderation_decided') AS events,
        (SELECT count(*)::int FROM outbox_messages AS outbox
          JOIN domain_events AS event ON event.event_id = outbox.event_id
          WHERE event.event_type = 'moderation_decided') AS outbox,
        (SELECT count(*)::int FROM research_jobs) AS jobs,
        (SELECT count(*)::int FROM authorizations) AS auth
    `);
    expect(state.rows[0]).toEqual({
      status: "ACCEPTED", audits: 1, events: 1, outbox: 1, jobs: 0, auth: 0,
    });
    const semantics = await raw.query<{ payload: Record<string, unknown>; reason: string }>(
      `SELECT event.payload, audit.reason FROM domain_events AS event
       JOIN administrative_action_audit AS audit
         ON audit.correlation_id = event.correlation_id
       WHERE event.event_type = 'moderation_decided'`,
    );
    expect(semantics.rows[0]!.payload).toMatchObject({ reasonProvided: true });
    expect(semantics.rows[0]!.payload).not.toHaveProperty("reasonRecorded");
    expect(semantics.rows[0]!.reason).toBe("Source meets moderation policy");
    await expect(raw.query(
      "DELETE FROM administrative_action_audit",
    )).rejects.toThrow("append-only");
  });

  it("requires a live POLICY_ADMIN session and fresh reauthentication for activation", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "fresh-policy-user");
    const manager = new ScorePolicyManager(database);
    await manager.activate(policyAdmin.context, {
      version: 1,
      priorityThreshold: 0.5,
      progressThreshold: 0.5,
      confidenceThreshold: 0.5,
      minimumSupports: 5,
    }, "activate-policy-1");
    await raw.query(
      `UPDATE administrative_sessions
       SET authenticated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes',
         reauthenticated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       WHERE id = $1`,
      [policyAdmin.context.sessionId],
    );
    await expect(manager.activate(policyAdmin.context, {
      version: 2,
      priorityThreshold: 0.6,
      progressThreshold: 0.6,
      confidenceThreshold: 0.6,
      minimumSupports: 6,
    }, "activate-policy-2")).rejects.toBeInstanceOf(AdministrativeReauthenticationRequiredError);
    expect((await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM score_policy_activations",
    )).rows[0]!.count).toBe(1);
  });

  it("exposes an eligible review queue without creating authorization or jobs", async () => {
    const validator = await context("VALIDATOR", "validator");
    await raw.query(
      `INSERT INTO proposals (title, central_question, status)
       VALUES ('Eligible proposal','Can a validator inspect it?','ELIGIBLE')`,
    );
    const queue = await new AdministrationService(database)
      .listEligible(validator.context);
    expect(queue.items).toHaveLength(0);
    expect((await raw.query<{ authorizations: number; jobs: number }>(`
      SELECT (SELECT count(*)::int FROM authorizations) AS authorizations,
        (SELECT count(*)::int FROM research_jobs) AS jobs
    `)).rows[0]).toEqual({ authorizations: 0, jobs: 0 });
  });

  it("removes stale eligibility after moderation and reacquires it only after rescoring", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "eligibility-policy-admin");
    const moderator = await context("MODERATOR", "eligibility-moderator");
    const validator = await context("VALIDATOR", "eligibility-validator");
    const entity = await createEligible(policyAdmin.context, "moderation-freshness");
    const administration = new AdministrationService(database);
    expect((await administration.listEligible(validator.context)).items).toHaveLength(1);

    await administration.moderate(
      moderator.context, "SOURCE", entity.sourcePublicId, "REJECTED",
      "Source failed moderation", "reject-source-freshness-1",
    );
    expect((await administration.listEligible(validator.context)).items).toHaveLength(0);
    const lost = await new ScoreService(database).recalculate(entity.proposalPublicId);
    expect(lost.eligible).toBe(false);
    expect((await administration.listEligible(validator.context)).items).toHaveLength(0);

    await administration.moderate(
      moderator.context, "SOURCE", entity.sourcePublicId, "ACCEPTED",
      "Source passed renewed moderation", "accept-source-freshness-1",
    );
    const gained = await new ScoreService(database).recalculate(entity.proposalPublicId);
    expect(gained.eligible).toBe(true);
    const queue = await administration.listEligible(validator.context);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ knowledgeRevision: 2 });
  });

  it("rejects the old policy snapshot without mass-mutating proposals", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "rotation-policy-admin");
    const validator = await context("VALIDATOR", "rotation-validator");
    const entity = await createEligible(policyAdmin.context, "policy-freshness");
    const administration = new AdministrationService(database);
    const proposals = new ProposalService(database);
    const before = await administration.listEligible(validator.context);
    expect(before.items).toHaveLength(1);
    expect((await proposals.get(entity.proposalPublicId)).status).toBe("ELIGIBLE");
    const beforeState = await raw.query<{ version: number }>(
      "SELECT version FROM proposals WHERE public_id = $1", [entity.proposalPublicId],
    );

    await new ScorePolicyManager(database).activate(policyAdmin.context, {
      version: 2, priorityThreshold: 0.55, progressThreshold: 0.3,
      confidenceThreshold: 0.4, minimumSupports: 3,
    }, "activate-policy-freshness-2");
    expect((await administration.listEligible(validator.context)).items).toHaveLength(0);
    expect((await proposals.get(entity.proposalPublicId)).status).toBe("COLLECTING");
    expect((await proposals.list(undefined, 100, 0)).find(
      (item) => item.publicId === entity.proposalPublicId,
    )?.status).toBe("COLLECTING");
    const stale = await raw.query<{
      status: string; score_run_id: string; policy_set_hash: string; version: number;
    }>(
      `SELECT status, eligibility_score_run_id AS score_run_id,
        eligibility_policy_set_hash AS policy_set_hash, version
       FROM proposals WHERE public_id = $1`, [entity.proposalPublicId],
    );
    expect(stale.rows[0]).toMatchObject({
      status: "ELIGIBLE",
      score_run_id: before.items[0]!.scoreRunId,
      policy_set_hash: before.items[0]!.policySetHash,
      version: beforeState.rows[0]!.version,
    });
    expect((await raw.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_events
       WHERE event_type = 'eligibility_snapshot_invalidated'
         AND payload->>'cause' = 'score_policy_activated'`,
    )).rows[0]!.count).toBe(0);
    expect((await new ScoreService(database).recalculate(entity.proposalPublicId)).eligible)
      .toBe(true);
    const after = await administration.listEligible(validator.context);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.policySetHash).not.toBe(before.items[0]!.policySetHash);
    expect((await proposals.get(entity.proposalPublicId)).status).toBe("ELIGIBLE");
  });

  it("serializes concurrent activations into a correct previous-version chain", async () => {
    const firstAdmin = await context("POLICY_ADMIN", "chain-admin-1");
    const secondAdmin = await context("POLICY_ADMIN", "chain-admin-2");
    const manager = new ScorePolicyManager(database);
    const policy = (version: number) => ({
      version, priorityThreshold: 0.5, progressThreshold: 0.5,
      confidenceThreshold: 0.5, minimumSupports: version,
    });
    await manager.activate(firstAdmin.context, policy(1), "chain-activation-1");
    await manager.activate(firstAdmin.context, policy(1), "chain-activation-1");
    expect((await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM score_policy_activations",
    )).rows[0]!.count).toBe(1);
    await Promise.all([
      manager.activate(firstAdmin.context, policy(2), "chain-activation-2"),
      manager.activate(secondAdmin.context, policy(3), "chain-activation-3"),
    ]);
    const chain = await raw.query<{
      policy_version: number; previous_policy_version: number | null;
    }>(
      `SELECT policy_version, previous_policy_version FROM score_policy_activations
       ORDER BY activation_sequence`,
    );
    expect(chain.rows[0]).toEqual({ policy_version: 1, previous_policy_version: null });
    expect(chain.rows[1]!.previous_policy_version).toBe(1);
    expect(chain.rows[2]!.previous_policy_version).toBe(chain.rows[1]!.policy_version);
    const active = await raw.query<{ version: number }>(
      "SELECT DISTINCT version FROM score_policies WHERE status = 'ACTIVE'",
    );
    expect(active.rows[0]!.version).toBe(chain.rows[2]!.policy_version);
  });

  it("makes moderation idempotent and rejects key reuse with another request", async () => {
    const moderator = await context("MODERATOR", "idempotent-moderator");
    const proposal = await raw.query<{ id: string }>(
      `INSERT INTO proposals (title, central_question)
       VALUES ('Idempotency','Does a retry mutate twice?') RETURNING id`,
    );
    const source = await raw.query<{ public_id: string }>(
      `INSERT INTO sources (proposal_id, kind, original_url, canonical_url)
       VALUES ($1,'URL','https://idempotent.example','https://idempotent.example/')
       RETURNING public_id`, [proposal.rows[0]!.id],
    );
    const administration = new AdministrationService(database);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await administration.moderate(
        moderator.context, "SOURCE", source.rows[0]!.public_id, "ACCEPTED",
        "Accepted once", "moderation-idempotency-1",
      );
    }
    const state = await raw.query<{ version: number; revision: string; audits: number }>(`
      SELECT (SELECT version FROM sources) AS version,
        (SELECT knowledge_revision FROM proposals) AS revision,
        (SELECT count(*)::int FROM administrative_action_audit
          WHERE action = 'moderation_decided') AS audits
    `);
    expect(state.rows[0]).toEqual({ version: 2, revision: 1, audits: 1 });
    await expect(administration.moderate(
      moderator.context, "SOURCE", source.rows[0]!.public_id, "REJECTED",
      "Different request", "moderation-idempotency-1",
    )).rejects.toBeInstanceOf(AdministrativeConflictError);
  });

  it("caps active sessions and purges expired retained sessions", async () => {
    const identityId = await identity("MODERATOR", "bounded-sessions");
    await raw.query(
      `INSERT INTO administrative_sessions (
        identity_id, token_hash, csrf_hash, mfa_verified,
        authenticated_at, reauthenticated_at, expires_at
      ) VALUES ($1,$2,$3,true,CURRENT_TIMESTAMP - INTERVAL '2 days',
        CURRENT_TIMESTAMP - INTERVAL '2 days',CURRENT_TIMESTAMP - INTERVAL '25 hours')`,
      [identityId, "c".repeat(64), "d".repeat(64)],
    );
    const sessions = new AdministrativeSessionService(database);
    for (let index = 0; index < 11; index += 1) {
      await sessions.issue({
        issuer: "https://idp.example", subject: "bounded-sessions",
        authenticationMethods: ["mfa"], authenticatedAt: new Date(),
      });
    }
    const counts = await raw.query<{ active: number; expired: number }>(`
      SELECT count(*) FILTER (
          WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        )::int AS active,
        count(*) FILTER (WHERE token_hash = $1)::int AS expired
      FROM administrative_sessions`, ["c".repeat(64)],
    );
    expect(counts.rows[0]).toEqual({ active: 10, expired: 0 });
  });

  it("enforces the ten-session cap under concurrent issuance", async () => {
    await identity("MODERATOR", "concurrent-sessions");
    const sessions = new AdministrativeSessionService(database);
    await Promise.all(Array.from({ length: 16 }, () => sessions.issue({
      issuer: "https://idp.example", subject: "concurrent-sessions",
      authenticationMethods: ["mfa"], authenticatedAt: new Date(),
    })));
    const count = await raw.query<{ active: number; total: number }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP)::int AS active,
        count(*)::int AS total FROM administrative_sessions`,
    );
    expect(count.rows[0]).toEqual({ active: 10, total: 16 });
  });

  it("paginates the fresh eligible queue with an opaque cursor", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "cursor-policy-admin");
    const validator = await context("VALIDATOR", "cursor-validator");
    const one = await createEligible(policyAdmin.context, "cursor-one");
    const two = await createEligible(policyAdmin.context, "cursor-two", false);
    const three = await createEligible(policyAdmin.context, "cursor-three", false);
    await raw.query(
      `UPDATE proposals SET updated_at = '2026-01-01T00:00:00Z'
       WHERE public_id = ANY($1::uuid[])`,
      [[one.proposalPublicId, two.proposalPublicId]],
    );
    await raw.query(
      `UPDATE proposals SET updated_at = '2020-01-01T00:00:00Z'
       WHERE public_id = $1`, [three.proposalPublicId],
    );
    const administration = new AdministrationService(database);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await administration.listEligible(validator.context, 1, cursor);
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0]!.publicId);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([
      three.proposalPublicId,
      ...[one.proposalPublicId, two.proposalPublicId].sort(),
    ]);
    expect(new Set(seen).size).toBe(3);
  });

  it("uses injected IdP proof and rejects claimed roles and CSRF bypasses", async () => {
    await identity("MODERATOR", "api-moderator");
    const sessions = new AdministrativeSessionService(database);
    const app = buildAdministrationApi({
      sessions,
      administration: new AdministrationService(database),
      policies: new ScorePolicyManager(database),
      verifyFederatedIdentity: async (request) =>
        request.headers["x-test-idp-proof"] === "verified"
          ? {
              issuer: "https://idp.example",
              subject: "api-moderator",
              authenticationMethods: ["mfa"],
              authenticatedAt: new Date(),
            }
          : undefined,
    });
    expect((await app.inject({
      method: "POST",
      url: "/admin/sessions",
      payload: { role: "POLICY_ADMIN", mfaVerified: true },
    })).statusCode).toBe(401);
    const issued = await app.inject({
      method: "POST",
      url: "/admin/sessions",
      headers: { "x-test-idp-proof": "verified" },
      payload: { role: "POLICY_ADMIN" },
    });
    const credentials = issued.json<{ accessToken: string; csrfToken: string }>();
    expect(issued.statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: "/admin/score-policies/activate",
      headers: { authorization: `Bearer ${credentials.accessToken}` },
      payload: {
        version: 1, priorityThreshold: 0.5, progressThreshold: 0.5,
        confidenceThreshold: 0.5, minimumSupports: 5,
      },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/admin/score-policies/activate",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "x-csrf-token": credentials.csrfToken,
        "idempotency-key": "api-policy-activation-1",
      },
      payload: {
        version: 1, priorityThreshold: 0.5, progressThreshold: 0.5,
        confidenceThreshold: 0.5, minimumSupports: 5,
      },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: "/admin/score-policies/activate",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "x-csrf-token": credentials.csrfToken,
        "idempotency-key": "api-invalid-body-1",
      },
      payload: [],
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: "/admin/sessions",
      headers: { "x-test-idp-proof": "verified" },
      payload: { padding: "x".repeat(11_000) },
    })).statusCode).toBe(413);
    await app.close();
  });
});
