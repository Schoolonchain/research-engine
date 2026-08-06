import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadMigrations,
  migrate,
  type SqlExecutor,
} from "../src/db/migrations.js";

class PGliteExecutor implements SqlExecutor {
  public constructor(private readonly database: PGlite) {}

  public async query(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<unknown> {
    if (values.length === 0) {
      return this.database.exec(sql);
    }
    return this.database.query(sql, [...values]);
  }
}

describe("initial database migration", () => {
  let database: PGlite;
  let executor: PGliteExecutor;

  beforeEach(() => {
    database = new PGlite();
    executor = new PGliteExecutor(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates the complete Phase 1 schema and is idempotent", { timeout: 15_000 }, async () => {
    const migrations = await loadMigrations();

    expect(migrations).toHaveLength(20);
    await migrate(executor, migrations);
    await migrate(executor, migrations);

    const result = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const tableNames = result.rows.map((row) => row.table_name);
    expect(tableNames).toHaveLength(34);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "abuse_signals",
        "actors",
        "aggregate_event_counts",
        "aggregate_streams",
        "audit_findings",
        "audit_reports",
        "authorizations",
        "blockchain_blocks",
        "blockchain_data_sources",
        "blockchain_networks",
        "blockchain_rate_limits",
        "blockchain_transactions",
        "claims",
        "consumer_receipts",
        "data_collection_runs",
        "domain_events",
        "evidence",
        "outbox_messages",
        "participation_rate_limits",
        "participation_identity_migrations",
        "participation_key_registry",
        "knowledge_rate_limits",
        "onchain_metrics",
        "participation_subject_locks",
        "proposals",
        "research_jobs",
        "research_results",
        "schema_migrations",
        "score_policies",
        "scores",
        "score_runs",
        "score_policy_activations",
        "sources",
        "supports",
      ]),
    );
  });

  it("models sources, claims and evidence as separate related entities", async () => {
    await migrate(executor, await loadMigrations());

    const actor = await database.query<{ id: string }>(`
      INSERT INTO actors (kind) VALUES ('USER') RETURNING id
    `);
    const actorId = actor.rows[0]?.id;
    const proposal = await database.query<{ id: string }>(
      `
        INSERT INTO proposals (
          author_actor_id, title, central_question
        ) VALUES ($1, 'Test proposal', 'What can the evidence establish?')
        RETURNING id
      `,
      [actorId],
    );
    const proposalId = proposal.rows[0]?.id;
    const source = await database.query<{ id: string }>(
      `
        INSERT INTO sources (
          proposal_id, contributed_by_actor_id, kind, original_url, canonical_url
        ) VALUES (
          $1, $2, 'URL', 'https://example.com/a', 'https://example.com/a'
        )
        RETURNING id
      `,
      [proposalId, actorId],
    );
    const sourceId = source.rows[0]?.id;
    const claim = await database.query<{ id: string }>(
      `
        INSERT INTO claims (
          proposal_id, source_id, created_by_actor_id, statement
        ) VALUES ($1, $2, $3, 'A testable claim')
        RETURNING id
      `,
      [proposalId, sourceId, actorId],
    );
    const claimId = claim.rows[0]?.id;

    await database.query(
      `
        INSERT INTO evidence (
          claim_id, source_id, contributed_by_actor_id, stance, locator
        ) VALUES ($1, $2, $3, 'SUPPORTS', 'paragraph 2')
      `,
      [claimId, sourceId, actorId],
    );

    const counts = await database.query<{
      sources: number;
      claims: number;
      evidence: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM sources) AS sources,
        (SELECT count(*)::int FROM claims) AS claims,
        (SELECT count(*)::int FROM evidence) AS evidence
    `);

    expect(counts.rows[0]).toEqual({
      sources: 1,
      claims: 1,
      evidence: 1,
    });
  });

  it("prevents duplicate active support for one participation subject", async () => {
    await migrate(executor, await loadMigrations());
    const proposal = await database.query<{ id: string }>(`
      INSERT INTO proposals (title, central_question)
      VALUES ('Support test', 'Can the same subject support twice?')
      RETURNING id
    `);
    const proposalId = proposal.rows[0]?.id;
    const subjectHash = "a".repeat(64);

    await database.query(
      `
        INSERT INTO participation_key_registry (key_id, key_verifier)
        VALUES ('legacy-v1', $1)
      `,
      ["b".repeat(64)],
    );
    await database.query(
      `
        INSERT INTO supports (
          proposal_id, subject_key_hash, policy_version
        ) VALUES ($1, $2, 1)
      `,
      [proposalId, subjectHash],
    );

    await expect(
      database.query(
        `
          INSERT INTO supports (
            proposal_id, subject_key_hash, policy_version
          ) VALUES ($1, $2, 1)
        `,
        [proposalId, subjectHash],
      ),
    ).rejects.toThrow();
  });

  it("keeps all score dimensions independent", async () => {
    await migrate(executor, await loadMigrations());
    const proposal = await database.query<{ id: string }>(`
      INSERT INTO proposals (title, central_question)
      VALUES ('Score test', 'Are dimensions stored independently?')
      RETURNING id
    `);
    const proposalId = proposal.rows[0]?.id;
    const run = await database.query<{ id: string }>(
      `INSERT INTO score_runs (
        proposal_id, policy_version, inputs, dimensions, eligible
      ) VALUES ($1, 1, '{}', '{}', false) RETURNING id`,
      [proposalId],
    );
    const runId = run.rows[0]?.id;

    for (const [version, dimension, value] of [
      [1, "PRIORITY", 0.75],
      [1, "PROGRESS", 0.25],
      [1, "CONFIDENCE", 0.5],
      [1, "SUPPORT_COUNT", 42],
    ] as const) {
      const policy = await database.query<{ id: string }>(
        `
          INSERT INTO score_policies (
            dimension, version, name, definition, definition_hash
          ) VALUES ($1, $2, $3, '{}', $4)
          RETURNING id
        `,
        [dimension, version, `${dimension} v${version}`, "a".repeat(64)],
      );
      await database.query(
        `
          INSERT INTO scores (
            proposal_id, policy_id, score_run_id, dimension, value
          ) VALUES ($1, $2, $3, $4, $5)
        `,
        [proposalId, policy.rows[0]?.id, runId, dimension, value],
      );
    }

    const result = await database.query<{ dimension: string }>(`
      SELECT dimension FROM scores ORDER BY dimension
    `);
    expect(result.rows.map((row) => row.dimension)).toEqual([
      "CONFIDENCE",
      "PRIORITY",
      "PROGRESS",
      "SUPPORT_COUNT",
    ]);
  });

  it("enforces budgets and one job per authorization structurally", async () => {
    await migrate(executor, await loadMigrations());
    const proposal = await database.query<{ id: string }>(`
      INSERT INTO proposals (title, central_question)
      VALUES ('Job test', 'Are job budgets structurally bounded?')
      RETURNING id
    `);
    const proposalId = proposal.rows[0]?.id;
    const authorization = await database.query<{ id: string }>(
      `
        INSERT INTO authorizations (
          proposal_id, type, status, policy_version, idempotency_key,
          max_cost_minor, currency, max_duration_seconds, max_calls,
          max_tokens, expires_at
        ) VALUES (
          $1, 'ADMIN', 'VALID', 1, 'test-authorization',
          1000, 'EUR', 3600, 10, 10000, CURRENT_TIMESTAMP + INTERVAL '1 hour'
        )
        RETURNING id
      `,
      [proposalId],
    );
    const authorizationId = authorization.rows[0]?.id;

    await database.query(
      `
        INSERT INTO research_jobs (
          proposal_id, authorization_id, plan_version,
          max_cost_minor, currency, max_duration_seconds,
          max_calls, max_tokens, stop_condition
        ) VALUES ($1, $2, 1, 1000, 'EUR', 3600, 10, 10000, '{}')
      `,
      [proposalId, authorizationId],
    );

    await expect(
      database.query(
        `
          INSERT INTO research_jobs (
            proposal_id, authorization_id, plan_version,
            max_cost_minor, currency, max_duration_seconds,
            max_calls, max_tokens, stop_condition
          ) VALUES ($1, $2, 1, 1000, 'EUR', 3600, 10, 10000, '{}')
        `,
        [proposalId, authorizationId],
      ),
    ).rejects.toThrow();

    await expect(
      database.query(
        "UPDATE research_jobs SET calls_used = 11 WHERE authorization_id = $1",
        [authorizationId],
      ),
    ).rejects.toThrow();
  });

  it("does not depend on Notion-specific identifiers", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((migration) => migration.sql).join("\n")).not.toMatch(
      /notion/i,
    );
  });
});
