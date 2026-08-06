import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/research/authorization-service.js";
import { ResearchJobService } from "../src/research/job-service.js";
import { DeterministicResearchExecutor } from "../src/research/deterministic-executor.js";
import { ResearchAuthorizationError, ResearchBudgetError, ResearchConflictError,
  ResearchLeaseError, ResearchValidationError } from "../src/research/errors.js";
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

  const validOutput = (digest = "a".repeat(64)) => ({
    kind: "DETERMINISTIC_SIMULATION", digest, provider: null, publication: false,
  } as const);

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
      { calls: 2, tokens: 1, costMinor: 0 }, validOutput())).rejects.toBeInstanceOf(ResearchBudgetError);

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
    expect((await raw.query<{ events: number; outbox: number }>(`SELECT
      count(*)::int AS events,
      count(outbox.id)::int AS outbox FROM domain_events AS event
      JOIN outbox_messages AS outbox ON outbox.event_id=event.event_id
      WHERE event.aggregate_id=(SELECT id FROM research_jobs WHERE public_id=$1)
        AND event.event_type='research_job_failed'`, [job.publicId])).rows[0]).toEqual({ events: 1, outbox: 1 });
  });

  it("rejects an expired lease and a late response after reassignment", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-late-response");
    const validator = await context("VALIDATOR", "validator-late-response");
    const jobs = new ResearchJobService(database);
    const permit = await issue(validator, await eligible(policyAdmin, "late-response"), "late-response");
    const job = await jobs.createFromAuthorization(permit.publicId);
    await jobs.claim("old-worker", 30);
    await raw.query(`UPDATE research_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'
      WHERE public_id=$1`, [job.publicId]);
    await expect(jobs.complete(job.publicId, "old-worker", { calls: 1, tokens: 1, costMinor: 0 },
      validOutput())).rejects.toBeInstanceOf(ResearchLeaseError);
    expect((await jobs.claim("new-worker", 30))?.attempts).toBe(2);
    await expect(jobs.fail(job.publicId, "old-worker", "LATE_RESPONSE", 1,
      { calls: 1, tokens: 1, costMinor: 0 })).rejects.toBeInstanceOf(ResearchLeaseError);
    await jobs.complete(job.publicId, "new-worker", { calls: 1, tokens: 1, costMinor: 0 }, validOutput());
  });

  it("fails at a deadline crossed during execution and accounts consumed work", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-deadline");
    const validator = await context("VALIDATOR", "validator-deadline");
    const jobs = new ResearchJobService(database);
    const permit = await issue(validator, await eligible(policyAdmin, "deadline"), "deadline");
    const job = await jobs.createFromAuthorization(permit.publicId);
    await jobs.claim("deadline-worker", 30);
    await raw.query(`UPDATE research_jobs SET deadline_at=clock_timestamp()-INTERVAL '1 second'
      WHERE public_id=$1`, [job.publicId]);
    await jobs.complete(job.publicId, "deadline-worker", { calls: 1, tokens: 7, costMinor: 0 }, validOutput());
    const result = await raw.query<{ status: string; calls_used: number; tokens_used: string }>(
      `SELECT status,calls_used,tokens_used FROM research_jobs WHERE public_id=$1`, [job.publicId]);
    expect(result.rows[0]).toEqual({ status: "FAILED", calls_used: 1, tokens_used: 7 });
    expect((await raw.query<{ count: number }>(`SELECT count(*)::int AS count FROM domain_events
      WHERE aggregate_id=(SELECT id FROM research_jobs WHERE public_id=$1)
        AND event_type='research_job_failed'`, [job.publicId])).rows[0]!.count).toBe(1);
  });

  it("gives cancellation precedence over a concurrent worker failure", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-cancel-race");
    const validator = await context("VALIDATOR", "validator-cancel-race");
    const jobs = new ResearchJobService(database);
    const permit = await issue(validator, await eligible(policyAdmin, "cancel-race"), "cancel-race");
    const job = await jobs.createFromAuthorization(permit.publicId);
    await jobs.claim("race-worker", 30);
    await Promise.allSettled([jobs.cancel(job.publicId), jobs.fail(job.publicId, "race-worker",
      "SIMULATED_FAILURE", 1, { calls: 1, tokens: 2, costMinor: 0 })]);
    expect((await raw.query<{ status: string }>(`SELECT status FROM research_jobs WHERE public_id=$1`,
      [job.publicId])).rows[0]!.status).toBe("CANCELLED");
    expect((await raw.query<{ count: number }>(`SELECT count(*)::int AS count FROM domain_events
      WHERE aggregate_id=(SELECT id FROM research_jobs WHERE public_id=$1)
        AND event_type='research_job_cancelled'`, [job.publicId])).rows[0]!.count).toBe(1);
  });

  it("accounts failed-attempt usage across bounded retries", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-failed-usage");
    const validator = await context("VALIDATOR", "validator-failed-usage");
    const jobs = new ResearchJobService(database);
    const permit = await issue(validator, await eligible(policyAdmin, "failed-usage"), "failed-usage",
      { maxCalls: 2, maxTokens: 10, maxAttempts: 2 });
    const job = await jobs.createFromAuthorization(permit.publicId);
    await jobs.claim("usage-one", 30);
    await jobs.fail(job.publicId, "usage-one", "FIRST_FAILURE", 1, { calls: 1, tokens: 4, costMinor: 0 });
    await raw.query(`UPDATE research_jobs SET available_at=clock_timestamp() WHERE public_id=$1`, [job.publicId]);
    await jobs.claim("usage-two", 30);
    await jobs.fail(job.publicId, "usage-two", "FINAL_FAILURE", 1, { calls: 1, tokens: 6, costMinor: 0 });
    const result = await raw.query<{ status: string; calls_used: number; tokens_used: string; attempts: number }>(
      `SELECT status,calls_used,tokens_used,attempts FROM research_jobs WHERE public_id=$1`, [job.publicId]);
    expect(result.rows[0]).toEqual({ status: "FAILED", calls_used: 2, tokens_used: 10, attempts: 2 });
    expect((await raw.query<{ count: number }>(`SELECT count(*)::int AS count FROM research_job_attempt_usage
      WHERE research_job_id=(SELECT id FROM research_jobs WHERE public_id=$1)`, [job.publicId])).rows[0]!.count).toBe(2);
  });

  it("writes exactly one event and Outbox message for every terminal transition", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-terminal-events");
    const validator = await context("VALIDATOR", "validator-terminal-events");
    const jobs = new ResearchJobService(database);
    for (const [suffix, outcome] of [["completed", "COMPLETED"], ["failed", "FAILED"],
      ["cancelled", "CANCELLED"]] as const) {
      const permit = await issue(validator, await eligible(policyAdmin, `terminal-${suffix}`, suffix === "completed"),
        `terminal-${suffix}`, { maxAttempts: 1 });
      const job = await jobs.createFromAuthorization(permit.publicId);
      if (outcome === "CANCELLED") await jobs.cancel(job.publicId);
      else {
        await jobs.claim(`terminal-${suffix}`, 30);
        if (outcome === "COMPLETED") await jobs.complete(job.publicId, `terminal-${suffix}`,
          { calls: 1, tokens: 1, costMinor: 0 }, validOutput());
        else await jobs.fail(job.publicId, `terminal-${suffix}`, "FINAL_FAILURE", 1,
          { calls: 1, tokens: 1, costMinor: 0 });
      }
      const events = await raw.query<{ event_type: string; outbox_count: number }>(
        `SELECT event.event_type,
          (SELECT count(*)::int FROM outbox_messages WHERE event_id=event.event_id) AS outbox_count
         FROM domain_events AS event JOIN research_jobs AS job ON job.id=event.aggregate_id
         WHERE job.public_id=$1 AND event.event_type=$2`, [job.publicId, `research_job_${outcome.toLowerCase()}`]);
      expect(events.rows).toEqual([{ event_type: `research_job_${outcome.toLowerCase()}`, outbox_count: 1 }]);
    }
  });

  it("rejects malformed, provider-bearing and publication outputs", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-invalid-output");
    const validator = await context("VALIDATOR", "validator-invalid-output");
    const jobs = new ResearchJobService(database);
    const permit = await issue(validator, await eligible(policyAdmin, "invalid-output"), "invalid-output");
    const job = await jobs.createFromAuthorization(permit.publicId);
    await jobs.claim("output-worker", 30);
    for (const output of [{}, { ...validOutput(), digest: "bad" },
      { ...validOutput(), provider: "real-ai" }, { ...validOutput(), publication: true },
      { ...validOutput(), extra: "field" }]) {
      await expect(jobs.complete(job.publicId, "output-worker", { calls: 1, tokens: 1, costMinor: 0 }, output))
        .rejects.toBeInstanceOf(ResearchValidationError);
    }
  });

  it("makes repeated revocation state-idempotent without duplicate events", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-repeat-revoke");
    const validator = await context("VALIDATOR", "validator-repeat-revoke");
    const service = new AuthorizationService(database);
    const permit = await issue(validator, await eligible(policyAdmin, "repeat-revoke"), "repeat-revoke");
    await service.revoke(validator, permit.publicId, "Withdrawn by reviewer", "revoke-first");
    await service.revoke(validator, permit.publicId, "Withdrawn by reviewer", "revoke-second");
    await expect(service.revoke(validator, permit.publicId, "Different reason", "revoke-third"))
      .rejects.toBeInstanceOf(ResearchConflictError);
    const count = await raw.query<{ count: number }>(`SELECT count(*)::int AS count FROM domain_events
      WHERE event_type='authorization_revoked' AND aggregate_id=(SELECT id FROM authorizations WHERE public_id=$1)`,
    [permit.publicId]);
    expect(count.rows[0]!.count).toBe(1);
  });

  it("allows only a justified ADMIN exception while THRESHOLD remains current-eligibility bound", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "policy-admin-exception");
    const validator = await context("VALIDATOR", "validator-admin-exception");
    const proposal = await eligible(policyAdmin, "admin-exception");
    await raw.query(`UPDATE proposals SET status='COLLECTING' WHERE public_id=$1`, [proposal]);
    const base = { proposalPublicId: proposal, currency: "USD", maxCostMinor: 0,
      maxDurationSeconds: 300, maxCalls: 2, maxTokens: 100, maxAttempts: 2,
      expiresAt: new Date(Date.now() + 60_000) } as const;
    await expect(new AuthorizationService(database).issue(validator, { ...base, type: "THRESHOLD",
      idempotencyKey: "threshold-ineligible" })).rejects.toBeInstanceOf(ResearchAuthorizationError);
    await expect(new AuthorizationService(database).issue(validator, { ...base, type: "ADMIN",
      idempotencyKey: "admin-without-reason" })).rejects.toBeInstanceOf(ResearchValidationError);
    const admin = await new AuthorizationService(database).issue(validator, { ...base, type: "ADMIN",
      justification: "Explicit exception approved for deterministic investigation",
      idempotencyKey: "admin-with-reason" });
    expect((await new ResearchJobService(database).createFromAuthorization(admin.publicId)).status).toBe("QUEUED");
  });
});
