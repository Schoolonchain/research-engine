import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, DatabaseResult, TransactionalDatabase } from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { ProposalService } from "../src/proposals/proposal-service.js";
import type { ActorContext } from "../src/proposals/model.js";
import { ScoreService } from "../src/scoring/score-service.js";
import { ScorePolicyManager } from "../src/scoring/policy-manager.js";

class Executor implements DatabaseExecutor {
  public constructor(private readonly db: PGlite | Transaction) {}
  public async query<Row>(sql: string, values: readonly unknown[] = []): Promise<DatabaseResult<Row>> {
    const result = await this.db.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}
class Database implements TransactionalDatabase {
  public constructor(private readonly db: PGlite) {}
  public transaction<Result>(operation: (tx: DatabaseExecutor) => Promise<Result>): Promise<Result> {
    return this.db.transaction((tx) => operation(new Executor(tx)));
  }
}

describe("Phase 6 scoring and eligibility", () => {
  let raw: PGlite;
  let database: Database;
  let proposalId: string;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length ? raw.query(sql, [...values]) : raw.exec(sql) },
      await loadMigrations(),
    );
    database = new Database(raw);
    const actorRow = await raw.query<{ id: string }>(
      "INSERT INTO actors (kind) VALUES ('USER') RETURNING id",
    );
    const actor: ActorContext = { actorId: actorRow.rows[0]!.id, role: "USER" };
    const proposals = new ProposalService(database);
    const created = await proposals.create(actor, {
      title: "Scored proposal", centralQuestion: "Is scoring reproducible?",
    });
    proposalId = (await proposals.open(actor, created.publicId, { expectedVersion: 1 })).publicId;
    await new ScorePolicyManager(database).activate({
      version: 1,
      priorityThreshold: 0.55,
      progressThreshold: 0.3,
      confidenceThreshold: 0.4,
      minimumSupports: 3,
    });
  });

  afterEach(async () => raw.close());

  it("stores separate reproducible dimensions without creating research work", async () => {
    const service = new ScoreService(database);
    const first = await service.recalculate(proposalId);
    const second = await service.recalculate(proposalId);
    expect(first.dimensions.map((item) => item.dimension)).toEqual([
      "PRIORITY", "PROGRESS", "CONFIDENCE", "SUPPORT_COUNT",
    ]);
    expect(second.dimensions).toEqual(first.dimensions);
    expect(first.eligible).toBe(false);
    const state = await raw.query<{ scores: number; jobs: number; authorizations: number }>(`
      SELECT (SELECT count(*)::int FROM scores) AS scores,
        (SELECT count(*)::int FROM research_jobs) AS jobs,
        (SELECT count(*)::int FROM authorizations) AS authorizations
    `);
    expect(state.rows[0]).toEqual({ scores: 8, jobs: 0, authorizations: 0 });
  });

  it("keeps policy versions immutable and activates a new version atomically", async () => {
    const manager = new ScorePolicyManager(database);
    await expect(manager.activate({
      version: 1,
      priorityThreshold: 0,
      progressThreshold: 0,
      confidenceThreshold: 0,
      minimumSupports: 0,
    })).rejects.toThrow("immutable");
    await manager.activate({
      version: 2,
      priorityThreshold: 0.6,
      progressThreshold: 0.4,
      confidenceThreshold: 0.5,
      minimumSupports: 5,
    });
    const active = await raw.query<{ version: number; count: number }>(
      `SELECT version, count(*)::int AS count FROM score_policies
       WHERE status = 'ACTIVE' GROUP BY version`,
    );
    expect(active.rows).toEqual([{ version: 2, count: 4 }]);
    expect((await new ScoreService(database).recalculate(proposalId))
      .dimensions.every((item) => item.policyVersion === 2)).toBe(true);
  });

  it("marks an evidenced proposal eligible but never authorizes or queues it", async () => {
    const proposal = await raw.query<{ id: string }>(
      "UPDATE proposals SET support_count = 50 WHERE public_id = $1 RETURNING id",
      [proposalId],
    );
    const source = await raw.query<{ id: string }>(
      `INSERT INTO sources (
        proposal_id, kind, original_url, canonical_url, moderation_status
       ) VALUES ($1,'URL','https://example.com','https://example.com/','ACCEPTED') RETURNING id`,
      [proposal.rows[0]!.id],
    );
    for (let index = 0; index < 10; index += 1) {
      const claim = await raw.query<{ id: string }>(
        `INSERT INTO claims (proposal_id, source_id, statement, moderation_status)
         VALUES ($1,$2,$3,'ACCEPTED') RETURNING id`,
        [proposal.rows[0]!.id, source.rows[0]!.id, `Claim ${index}`],
      );
      for (let evidenceIndex = 0; evidenceIndex < 2; evidenceIndex += 1) {
        await raw.query(
          `INSERT INTO evidence (
            claim_id, source_id, stance, locator, moderation_status
          ) VALUES ($1,$2,'SUPPORTS',$3,'ACCEPTED')`,
          [claim.rows[0]!.id, source.rows[0]!.id, `${index}-${evidenceIndex}`],
        );
      }
    }
    const [result, concurrent] = await Promise.all([
      new ScoreService(database).recalculate(proposalId),
      new ScoreService(database).recalculate(proposalId),
    ]);
    expect(result.eligible).toBe(true);
    expect(result.proposalStatus).toBe("ELIGIBLE");
    expect(concurrent.proposalStatus).toBe("ELIGIBLE");
    const state = await raw.query<{ jobs: number; auth: number; eligibility_events: number }>(`
      SELECT (SELECT count(*)::int FROM research_jobs) AS jobs,
        (SELECT count(*)::int FROM authorizations) AS auth,
        (SELECT count(*)::int FROM domain_events
          WHERE event_type = 'proposal_became_eligible') AS eligibility_events
    `);
    expect(state.rows[0]).toEqual({ jobs: 0, auth: 0, eligibility_events: 1 });

    await raw.query("UPDATE evidence SET moderation_status = 'REJECTED'");
    const lost = await new ScoreService(database).recalculate(proposalId);
    expect(lost.eligible).toBe(false);
    expect(lost.proposalStatus).toBe("COLLECTING");
    const history = await raw.query<{ event_type: string }>(
      `SELECT event_type FROM domain_events
       WHERE event_type IN (
         'threshold_reached', 'proposal_became_eligible', 'threshold_lost'
       ) ORDER BY recorded_at, sequence`,
    );
    expect(history.rows.map((row) => row.event_type)).toEqual([
      "threshold_reached", "proposal_became_eligible", "threshold_lost",
    ]);
  });
});
