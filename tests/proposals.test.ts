import { randomUUID } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { buildProposalApi } from "../src/proposals/api.js";
import {
  ProposalConflictError,
  ProposalForbiddenError,
  ProposalNotFoundError,
} from "../src/proposals/errors.js";
import type { ActorContext } from "../src/proposals/model.js";
import { ProposalService } from "../src/proposals/proposal-service.js";

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

async function createActor(
  database: PGlite,
  role: ActorContext["role"],
): Promise<ActorContext> {
  const kind = role === "USER" ? "USER" : "ADMIN";
  const result = await database.query<{ id: string }>(
    "INSERT INTO actors (kind) VALUES ($1) RETURNING id",
    [kind],
  );
  const actorId = result.rows[0]?.id;
  if (!actorId) throw new Error("Actor insert returned no ID");
  return Object.freeze({ actorId, role });
}

describe("Proposal service and API", () => {
  let database: PGlite;
  let transactionalDatabase: PGliteTransactionalDatabase;
  let proposals: ProposalService;
  let owner: ActorContext;
  let otherUser: ActorContext;
  let moderator: ActorContext;

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
    proposals = new ProposalService(transactionalDatabase);
    owner = await createActor(database, "USER");
    otherUser = await createActor(database, "USER");
    moderator = await createActor(database, "MODERATOR");
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates and retrieves a proposal with its audit event and outbox message", async () => {
    const created = await proposals.create(owner, {
      title: "  Verifiable research question  ",
      centralQuestion: "  What does the available evidence establish?  ",
      description: "A bounded proposal.",
    });

    expect(created.title).toBe("Verifiable research question");
    expect(created.centralQuestion).toBe(
      "What does the available evidence establish?",
    );
    expect(created.status).toBe("CREATED");
    expect(created.version).toBe(1);
    expect(await proposals.get(created.publicId)).toEqual(created);

    const audit = await database.query<{
      event_type: string;
      sequence: string;
      payload: Record<string, unknown>;
      outbox_count: number;
      jobs_count: number;
    }>(
      `
        SELECT
          event.event_type,
          event.sequence,
          event.payload,
          (SELECT count(*)::int FROM outbox_messages) AS outbox_count,
          (SELECT count(*)::int FROM research_jobs) AS jobs_count
        FROM domain_events AS event
      `,
    );
    expect(audit.rows[0]?.event_type).toBe("proposal_created");
    expect(Number(audit.rows[0]?.sequence)).toBe(1);
    expect(audit.rows[0]?.payload).not.toHaveProperty("title");
    expect(audit.rows[0]?.outbox_count).toBe(1);
    expect(audit.rows[0]?.jobs_count).toBe(0);
  });

  it("enforces ownership and optimistic concurrency on updates", async () => {
    const created = await proposals.create(owner, {
      title: "Original title",
      centralQuestion: "Can only the owner modify this?",
    });

    await expect(
      proposals.update(otherUser, created.publicId, {
        expectedVersion: 1,
        title: "Unauthorized title",
      }),
    ).rejects.toBeInstanceOf(ProposalForbiddenError);

    const updated = await proposals.update(owner, created.publicId, {
      expectedVersion: 1,
      title: "Updated title",
    });
    expect(updated.title).toBe("Updated title");
    expect(updated.version).toBe(2);

    await expect(
      proposals.update(owner, created.publicId, {
        expectedVersion: 1,
        title: "Stale update",
      }),
    ).rejects.toBeInstanceOf(ProposalConflictError);

    const events = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM domain_events",
    );
    expect(events.rows[0]?.count).toBe(2);
  });

  it("opens and archives through explicit audited transitions", async () => {
    const created = await proposals.create(owner, {
      title: "Lifecycle proposal",
      centralQuestion: "Are lifecycle transitions explicit?",
    });
    const opened = await proposals.open(owner, created.publicId, {
      expectedVersion: 1,
    });
    const archived = await proposals.archive(owner, created.publicId, {
      expectedVersion: 2,
      reason: "No longer timely",
    });

    expect(opened.status).toBe("OPEN");
    expect(opened.openedAt).toBeInstanceOf(Date);
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.statusReason).toBe("No longer timely");
    expect(archived.archivedAt).toBeInstanceOf(Date);

    const events = await database.query<{
      event_type: string;
      sequence: string;
    }>(
      `
        SELECT event_type, sequence
        FROM domain_events
        ORDER BY sequence
      `,
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      "proposal_created",
      "proposal_opened",
      "proposal_archived",
    ]);
    expect(events.rows.map((event) => Number(event.sequence))).toEqual([
      1, 2, 3,
    ]);
  });

  it("hides private proposals from unauthenticated and unrelated actors", async () => {
    const privateProposal = await proposals.create(owner, {
      title: "Private draft",
      centralQuestion: "Who can see a private draft?",
      visibility: "PRIVATE",
    });
    await proposals.create(otherUser, {
      title: "Public draft",
      centralQuestion: "Should this be listed publicly?",
    });

    await expect(
      proposals.get(privateProposal.publicId),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    await expect(
      proposals.get(privateProposal.publicId, otherUser),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    expect(
      (await proposals.get(privateProposal.publicId, owner)).publicId,
    ).toBe(privateProposal.publicId);

    expect(await proposals.list(undefined, 20, 0)).toHaveLength(1);
    expect(await proposals.list(owner, 20, 0)).toHaveLength(2);
    expect(await proposals.list(moderator, 20, 0)).toHaveLength(2);
  });

  it("soft-deletes an unopened owner proposal and removes its content", async () => {
    const created = await proposals.create(owner, {
      title: "Delete me",
      centralQuestion: "Is personal content removed on deletion?",
      description: "Content to redact.",
    });

    await proposals.delete(owner, created.publicId, {
      expectedVersion: 1,
      reason: "Created by mistake",
    });

    await expect(proposals.get(created.publicId, owner)).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    );
    const row = await database.query<{
      title: string;
      central_question: string;
      description: string;
      status: string;
    }>("SELECT title, central_question, description, status FROM proposals");
    expect(row.rows[0]).toEqual({
      title: "[deleted]",
      central_question: "[deleted]",
      description: "",
      status: "DELETED",
    });
  });

  it("prevents owners deleting opened proposals but permits moderation", async () => {
    const created = await proposals.create(owner, {
      title: "Opened proposal",
      centralQuestion: "Can opened work vanish without moderation?",
    });
    const opened = await proposals.open(owner, created.publicId, {
      expectedVersion: 1,
    });

    await expect(
      proposals.delete(owner, created.publicId, {
        expectedVersion: opened.version,
        reason: "Owner deletion",
      }),
    ).rejects.toBeInstanceOf(ProposalForbiddenError);

    await proposals.delete(moderator, created.publicId, {
      expectedVersion: opened.version,
      reason: "Moderation decision",
    });
    await expect(proposals.get(created.publicId)).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    );
  });

  it("blocks deletion when research authorization history exists", async () => {
    const created = await proposals.create(owner, {
      title: "History proposal",
      centralQuestion: "Can audited research history be erased?",
    });
    const internal = await database.query<{ id: string }>(
      "SELECT id FROM proposals WHERE public_id = $1",
      [created.publicId],
    );
    await database.query(
      `
        INSERT INTO authorizations (
          proposal_id, type, status, policy_version, idempotency_key,
          max_cost_minor, currency, max_duration_seconds,
          max_calls, max_tokens, expires_at
        ) VALUES (
          $1, 'ADMIN', 'VALID', 1, $2,
          100, 'EUR', 60, 1, 100,
          CURRENT_TIMESTAMP + INTERVAL '1 hour'
        )
      `,
      [internal.rows[0]?.id, randomUUID()],
    );

    await expect(
      proposals.delete(moderator, created.publicId, {
        expectedVersion: 1,
        reason: "Attempted moderation deletion",
      }),
    ).rejects.toBeInstanceOf(ProposalConflictError);
  });

  it("exposes the bounded HTTP API without trusting actor IDs in request bodies", async () => {
    const tokens = new Map<string, ActorContext>([
      ["owner-token", owner],
      ["other-token", otherUser],
    ]);
    const application = buildProposalApi({
      proposals,
      authenticate: async (request) => {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) return undefined;
        return tokens.get(header.slice("Bearer ".length));
      },
    });

    const unauthenticated = await application.inject({
      method: "POST",
      url: "/proposals",
      payload: {
        title: "Rejected",
        centralQuestion: "Should anonymous creation be accepted?",
      },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const created = await application.inject({
      method: "POST",
      url: "/proposals",
      headers: { authorization: "Bearer owner-token" },
      payload: {
        title: "API proposal",
        centralQuestion: "Does the API enforce its identity boundary?",
        actorId: otherUser.actorId,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ publicId: string; authorActorId: string }>();
    expect(body.authorActorId).toBe(owner.actorId);

    const forbidden = await application.inject({
      method: "PATCH",
      url: `/proposals/${body.publicId}`,
      headers: { authorization: "Bearer other-token" },
      payload: { expectedVersion: 1, title: "Spoofed edit" },
    });
    expect(forbidden.statusCode).toBe(403);

    const invalid = await application.inject({
      method: "GET",
      url: "/proposals?limit=1000",
    });
    expect(invalid.statusCode).toBe(400);

    await application.close();
  });
});
