import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/research/authorization-service.js";
import { ResearchJobService } from "../src/research/job-service.js";
import { DeterministicResearchExecutor } from "../src/research/deterministic-executor.js";
import { ResearchAuthorizationError, ResearchBudgetError } from "../src/research/errors.js";
import { ScorePolicyManager } from "../src/scoring/policy-manager.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import type { DatabaseExecutor, DatabaseResult, TransactionalDatabase } from "../src/db/database.js";
import type { AdministrativeContext, AdministrativeRole } from "../src/admin/model.js";

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

describe("Phase 8 authorization and deterministic research jobs", () => {
  let raw: PGlite;
  let database: Database;
  beforeEach(async () => {
    raw = new PGlite();
    await migrate({ query: (sql: string, values: readonly unknown[] = []) =>
      values.length ? raw.query(sql, [...values]) : raw.exec(sql) }, await loadMigrations());
    database = new Database(raw);
  });
  afterEach(async () => raw.close());

  async function context(role: AdministrativeRole, subject: string): Promise<AdministrativeContext> {
    const actor = await raw.query<{ id: string }>("INSERT INTO actors (kind) VALUES ('ADMIN') RETURNING id");
    const identity = await raw.query<{ id: string }>(
      `INSERT INTO administrative_identities (actor_id, issuer, subject, role)
       VALUES ($1,'https://idp.example',$2,$3) RETURNING id`, [actor.rows[0]!.id, subject, role]);
    const session = await raw.query<{ id: string; authenticated_at: Date; reauthenticated_at: Date; expires_at: Date }>(
      `INSERT INTO administrative_sessions (identity_id, token_hash, csrf_hash, mfa_verified,
        authenticated_at, reauthenticated_at, expires_at)
       VALUES ($1,$2,$3,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '15 minutes')
       RETURNING id, authenticated_at, reauthenticated_at, expires_at`,
      [identity.rows[0]!.id, subject.padEnd(64, "a").slice(0, 64), subject.padEnd(64, "b").slice(0, 64)]);
    return Object.freeze({ actorId: actor.rows[0]!.id, identityId: identity.rows[0]!.id,
      sessionId: session.rows[0]!.id, role, mfaVerified: true,
      authenticatedAt: session.rows[0]!.authenticated_at,
      reauthenticatedAt: session.rows[0]!.reauthenticated_at,
      expiresAt: session.rows[0]!.expires_at });
  }

  async function eligible(policyAdmin: AdministrativeContext, suffix: string, activate = true): Promise<string> {
    if (activate) await new ScorePolicyManager(database).activate(policyAdmin, {
      version: 1, priorityThreshold: 0.5, progressThreshold: 0.5,
      confidenceThreshold: 0.5, minimumSupports: 1,
    }, `phase8-policy-${suffix}`);
    const activation = await raw.query<{ policy_version: number; policy_set_hash: string }>(
      `SELECT policy_version, policy_set_hash FROM score_policy_activations
       ORDER BY activation_sequence DESC LIMIT 1`);
    const proposal = await raw.query<{ id: string; public_id: string }>(
      `INSERT INTO proposals (title, central_question, status)
       VALUES ($1,'Can this run deterministically?','ELIGIBLE') RETURNING id, public_id`, [`Phase 8 ${suffix}`]);
    const run = await raw.query<{ id: string }>(
      `INSERT INTO score_runs (proposal_id, policy_version, inputs, dimensions, eligible,
        policy_set_hash, knowledge_revision)
       VALUES ($1,$2,'{}','{}',true,$3,0) RETURNING id`,
      [proposal.rows[0]!.id, activation.rows[0]!.policy_version, activation.rows[0]!.policy_set_hash]);
    await raw.query(`UPDATE proposals SET eligibility_score_run_id = $1,
      eligibility_policy_set_hash = $2, eligibility_knowledge_revision = 0 WHERE id = $3`,
    [run.rows[0]!.id, activation.rows[0]!.policy_set_hash, proposal.rows[0]!.id]);
    return proposal.rows[0]!.public_id;
  }

  async function issue(
    validator: AdministrativeContext, proposalPublicId: string, suffix: string,
    overrides: Partial<{ maxCalls: number; maxTokens: number; maxCostMinor: number; maxAttempts: number; expiresAt: Date }> = {},
  ) {
    return new AuthorizationService(database).issue(validator, {
      proposalPublicId, type: "THRESHOLD", currency: "USD",
      maxCostMinor: overrides.maxCostMinor ?? 0, maxDurationSeconds: 300,
      maxCalls: overrides.maxCalls ?? 2, maxTokens: overrides.maxTokens ?? 100,
      maxAttempts: overrides.maxAttempts ?? 3,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
      idempotencyKey: `authorization-${suffix}`,
    });
  }

  it("issues explicitly and creates exactly one job under concurrent consumption", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-concurrency");
    const validator = await context("VALIDATOR", "validator-concurrency");
    const proposalPublicId = await eligible(policyAdmin, "concurrency");
    const fixedExpiry = new Date(Date.now() + 60_000);
    const issued = await Promise.all(Array.from({ length: 10 }, () =>
      issue(validator, proposalPublicId, "concurrency", { expiresAt: fixedExpiry })));
    expect(new Set(issued.map((permit) => permit.publicId)).size).toBe(1);
    const authorization = issued[0]!;
    const jobs = new ResearchJobService(database);
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      jobs.createFromAuthorization(authorization.publicId)));
    expect(new Set(results.map((job) => job.publicId)).size).toBe(1);
    const counts = await raw.query<{ permits: number; jobs: number; consumed: number }>(
      `SELECT (SELECT count(*)::int FROM research_jobs) AS jobs,
        (SELECT count(*)::int FROM authorizations) AS permits,
        (SELECT count(*)::int FROM authorizations WHERE status = 'CONSUMED') AS consumed`);
    expect(counts.rows[0]).toEqual({ permits: 1, jobs: 1, consumed: 1 });
  });

  it("blocks revoked, expired and policy-stale authorizations", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-guards");
    const validator = await context("VALIDATOR", "validator-guards");
    const first = await eligible(policyAdmin, "guards");
    const revoked = await issue(validator, first, "revoked");
    await new AuthorizationService(database).revoke(validator, revoked.publicId, "Human review withdrawn", "revoke-authorization-1");
    await expect(new ResearchJobService(database).createFromAuthorization(revoked.publicId))
      .rejects.toBeInstanceOf(ResearchAuthorizationError);

    const second = await eligible(policyAdmin, "expired", false);
    const expired = await issue(validator, second, "expired", { expiresAt: new Date(Date.now() + 50) });
    await new Promise((resolve) => setTimeout(resolve, 70));
    await expect(new ResearchJobService(database).createFromAuthorization(expired.publicId))
      .rejects.toBeInstanceOf(ResearchAuthorizationError);

    const third = await eligible(policyAdmin, "stale", false);
    const stale = await issue(validator, third, "stale");
    await new ScorePolicyManager(database).activate(policyAdmin, {
      version: 2, priorityThreshold: 0.6, progressThreshold: 0.6,
      confidenceThreshold: 0.6, minimumSupports: 2,
    }, "phase8-policy-rotation");
    await expect(new ResearchJobService(database).createFromAuthorization(stale.publicId))
      .rejects.toBeInstanceOf(ResearchAuthorizationError);
  });

  it("executes deterministically with zero provider and zero cost", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-executor");
    const validator = await context("VALIDATOR", "validator-executor");
    const proposal = await eligible(policyAdmin, "executor");
    const authorization = await issue(validator, proposal, "executor");
    const jobs = new ResearchJobService(database);
    const job = await jobs.createFromAuthorization(authorization.publicId);
    expect(await new DeterministicResearchExecutor(jobs).runNext("sim-worker")).toBe(job.publicId);
    const stored = await raw.query<{ status: string; spent_cost_minor: string; calls_used: number; output: Record<string, unknown> }>(
      `SELECT status, spent_cost_minor, calls_used, execution_output AS output
       FROM research_jobs WHERE public_id = $1`, [job.publicId]);
    expect(stored.rows[0]).toMatchObject({ status: "COMPLETED", spent_cost_minor: 0,
      calls_used: 1, output: { kind: "DETERMINISTIC_SIMULATION", provider: null, publication: false } });
  });

  it("enforces budgets, cancellation, leases and bounded retries", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-limits");
    const validator = await context("VALIDATOR", "validator-limits");
    const jobs = new ResearchJobService(database);

    const budgetAuth = await issue(validator, await eligible(policyAdmin, "budget"), "budget", { maxCalls: 1 });
    const budgetJob = await jobs.createFromAuthorization(budgetAuth.publicId);
    const budgetLease = await jobs.claim("budget-worker", 30);
    expect(budgetLease?.publicId).toBe(budgetJob.publicId);
    await expect(jobs.complete(budgetJob.publicId, "budget-worker",
      { calls: 2, tokens: 1, costMinor: 0 }, {})).rejects.toBeInstanceOf(ResearchBudgetError);

    const cancelAuth = await issue(validator, await eligible(policyAdmin, "cancel", false), "cancel");
    const cancelJob = await jobs.createFromAuthorization(cancelAuth.publicId);
    await jobs.cancel(cancelJob.publicId);
    expect((await raw.query<{ status: string }>("SELECT status FROM research_jobs WHERE public_id = $1", [cancelJob.publicId])).rows[0]!.status).toBe("CANCELLED");

    await jobs.fail(budgetJob.publicId, "budget-worker", "SIMULATED_FAILURE", 1);
    await raw.query("UPDATE research_jobs SET available_at = CURRENT_TIMESTAMP WHERE public_id = $1", [budgetJob.publicId]);
    expect((await jobs.claim("retry-worker", 30))?.attempts).toBe(2);
    await jobs.fail(budgetJob.publicId, "retry-worker", "SIMULATED_FAILURE", 1);
    await raw.query("UPDATE research_jobs SET available_at = CURRENT_TIMESTAMP WHERE public_id = $1", [budgetJob.publicId]);
    expect((await jobs.claim("final-worker", 30))?.attempts).toBe(3);
    await jobs.fail(budgetJob.publicId, "final-worker", "SIMULATED_FAILURE", 1);
    expect((await raw.query<{ status: string }>("SELECT status FROM research_jobs WHERE public_id = $1", [budgetJob.publicId])).rows[0]!.status).toBe("FAILED");
  });

  it("recovers expired leases and terminates abandoned final attempts", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-lease-recovery");
    const validator = await context("VALIDATOR", "validator-lease-recovery");
    const authorization = await issue(validator, await eligible(policyAdmin, "lease-recovery"),
      "lease-recovery", { maxAttempts: 2 });
    const jobs = new ResearchJobService(database);
    const job = await jobs.createFromAuthorization(authorization.publicId);
    expect((await jobs.claim("crashed-worker-1", 30))?.attempts).toBe(1);
    await raw.query(`UPDATE research_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE public_id = $1`, [job.publicId]);
    expect((await jobs.claim("crashed-worker-2", 30))?.attempts).toBe(2);
    await raw.query(`UPDATE research_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE public_id = $1`, [job.publicId]);
    expect(await jobs.claim("third-worker", 30)).toBeNull();
    expect((await raw.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM research_jobs WHERE public_id = $1", [job.publicId],
    )).rows[0]).toEqual({ status: "FAILED", error_code: "RETRIES_EXHAUSTED" });
  });
});
