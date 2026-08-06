import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, DatabaseResult, TransactionalDatabase } from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { ProposalService } from "../src/proposals/proposal-service.js";
import type { ActorContext } from "../src/proposals/model.js";
import { ScoreService } from "../src/scoring/score-service.js";
import { ScorePolicyManager } from "../src/scoring/policy-manager.js";
import type { AdministrativeContext } from "../src/admin/model.js";

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
  let policyAdmin: AdministrativeContext;

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
    const adminActor = await raw.query<{ id: string }>(
      "INSERT INTO actors (kind) VALUES ('ADMIN') RETURNING id",
    );
    const identity = await raw.query<{ id: string }>(
      `INSERT INTO administrative_identities (actor_id, issuer, subject, role)
       VALUES ($1,'https://idp.example','policy-admin','POLICY_ADMIN') RETURNING id`,
      [adminActor.rows[0]!.id],
    );
    const session = await raw.query<{
      id: string; authenticated_at: Date; reauthenticated_at: Date; expires_at: Date;
    }>(
      `INSERT INTO administrative_sessions (
        identity_id, token_hash, csrf_hash, mfa_verified,
        authenticated_at, reauthenticated_at, expires_at
      ) VALUES ($1,$2,$3,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '15 minutes')
      RETURNING id, authenticated_at, reauthenticated_at, expires_at`,
      [identity.rows[0]!.id, "a".repeat(64), "b".repeat(64)],
    );
    policyAdmin = Object.freeze({
      actorId: adminActor.rows[0]!.id,
      identityId: identity.rows[0]!.id,
      sessionId: session.rows[0]!.id,
      role: "POLICY_ADMIN",
      mfaVerified: true,
      authenticatedAt: session.rows[0]!.authenticated_at,
      reauthenticatedAt: session.rows[0]!.reauthenticated_at,
      expiresAt: session.rows[0]!.expires_at,
    });
    await new ScorePolicyManager(database).activate(policyAdmin, {
      version: 1,
      priorityThreshold: 0.55,
      progressThreshold: 0.3,
      confidenceThreshold: 0.4,
      minimumSupports: 3,
    }, "activate-score-policy-1");
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
    await expect(manager.activate(policyAdmin, {
      version: 1,
      priorityThreshold: 0,
      progressThreshold: 0,
      confidenceThreshold: 0,
      minimumSupports: 0,
    }, "activate-score-policy-conflict")).rejects.toThrow("immutable");
    await manager.activate(policyAdmin, {
      version: 2,
      priorityThreshold: 0.6,
      progressThreshold: 0.4,
      confidenceThreshold: 0.5,
      minimumSupports: 5,
    }, "activate-score-policy-2");
    const active = await raw.query<{ version: number; count: number }>(
      `SELECT version, count(*)::int AS count FROM score_policies
       WHERE status = 'ACTIVE' GROUP BY version`,
    );
    expect(active.rows).toEqual([{ version: 2, count: 4 }]);
    const audit = await raw.query<{
      activations: number; events: number; outbox: number; matching_hashes: number;
    }>(`
      SELECT (SELECT count(*)::int FROM score_policy_activations) AS activations,
        (SELECT count(*)::int FROM domain_events
          WHERE event_type = 'score_policy_activated') AS events,
        (SELECT count(*)::int FROM outbox_messages AS outbox
          JOIN domain_events AS event ON event.event_id = outbox.event_id
          WHERE event.event_type = 'score_policy_activated') AS outbox,
        (SELECT count(*)::int FROM score_policy_activations AS activation
          JOIN domain_events AS event ON event.aggregate_id = activation.correlation_id
          WHERE event.event_type = 'score_policy_activated'
            AND event.payload->>'policySetHash' = activation.policy_set_hash) AS matching_hashes
    `);
    expect(audit.rows[0]).toEqual({
      activations: 2, events: 2, outbox: 2, matching_hashes: 2,
    });
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

    await raw.query("UPDATE sources SET moderation_status = 'REJECTED'");
    await raw.query("UPDATE claims SET moderation_status = 'REJECTED'");
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

  it("protects policy definitions and scoring history from direct mutation", async () => {
    await new ScoreService(database).recalculate(proposalId);
    await expect(raw.query(
      `UPDATE score_policies
       SET eligibility_definition = '{"version":1,"priorityThreshold":0,
         "progressThreshold":0,"confidenceThreshold":0,"minimumSupports":0}'::jsonb`,
    )).rejects.toThrow("immutable");
    await expect(raw.query("DELETE FROM score_policies")).rejects.toThrow("append-only");
    await expect(raw.query(
      "UPDATE score_policy_activations SET previous_policy_version = 999",
    )).rejects.toThrow("append-only");
    await expect(raw.query(
      "UPDATE score_runs SET eligible = NOT eligible",
    )).rejects.toThrow("append-only");
    const ids = await raw.query<{ proposal_id: string; policy_id: string }>(
      `SELECT (SELECT id FROM proposals) AS proposal_id,
        (SELECT id FROM score_policies LIMIT 1) AS policy_id`,
    );
    await expect(raw.query(
      `INSERT INTO scores (proposal_id, policy_id, dimension, value)
       VALUES ($1,$2,'PRIORITY',0)`,
      [ids.rows[0]!.proposal_id, ids.rows[0]!.policy_id],
    )).rejects.toThrow();
  });

  it("excludes Evidence whose Claim is linked to a rejected Source", async () => {
    const proposal = await raw.query<{ id: string }>(
      "UPDATE proposals SET support_count = 50 WHERE public_id = $1 RETURNING id",
      [proposalId],
    );
    const rejectedSource = await raw.query<{ id: string }>(
      `INSERT INTO sources (
        proposal_id, kind, original_url, canonical_url, moderation_status
      ) VALUES ($1,'URL','https://rejected.example','https://rejected.example/','REJECTED')
      RETURNING id`,
      [proposal.rows[0]!.id],
    );
    const acceptedSource = await raw.query<{ id: string }>(
      `INSERT INTO sources (
        proposal_id, kind, original_url, canonical_url, moderation_status
      ) VALUES ($1,'URL','https://accepted.example','https://accepted.example/','ACCEPTED')
      RETURNING id`,
      [proposal.rows[0]!.id],
    );
    const claim = await raw.query<{ id: string }>(
      `INSERT INTO claims (proposal_id, source_id, statement, moderation_status)
       VALUES ($1,$2,'Rejected antecedent','ACCEPTED') RETURNING id`,
      [proposal.rows[0]!.id, rejectedSource.rows[0]!.id],
    );
    for (let index = 0; index < 20; index += 1) {
      await raw.query(
        `INSERT INTO evidence (
          claim_id, source_id, stance, locator, moderation_status
        ) VALUES ($1,$2,'SUPPORTS',$3,'ACCEPTED')`,
        [claim.rows[0]!.id, acceptedSource.rows[0]!.id, `Evidence ${index}`],
      );
    }

    const result = await new ScoreService(database).recalculate(proposalId);
    const run = await raw.query<{ inputs: { acceptedClaims: number; acceptedEvidence: number } }>(
      "SELECT inputs FROM score_runs ORDER BY created_at DESC LIMIT 1",
    );
    expect(run.rows[0]!.inputs).toMatchObject({ acceptedClaims: 0, acceptedEvidence: 0 });
    expect(result.eligible).toBe(false);
  });
});
