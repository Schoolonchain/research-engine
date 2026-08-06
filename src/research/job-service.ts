import { randomUUID } from "node:crypto";
import type { TransactionalDatabase } from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import { eventSequence } from "./helpers.js";
import { ResearchAuthorizationError, ResearchBudgetError, ResearchConflictError, ResearchLeaseError, ResearchNotFoundError, ResearchValidationError } from "./errors.js";
import type { ResearchJobLease, ResearchJobView } from "./model.js";

interface JobRow {
  readonly id: string; readonly public_id: string; readonly authorization_public_id: string;
  readonly status: string; readonly attempts: number; readonly max_attempts: number;
  readonly available_at: Date; readonly deadline_at: Date; readonly lease_owner?: string;
  readonly lease_expires_at?: Date; readonly max_calls: number; readonly max_tokens: string;
  readonly max_cost_minor: string; readonly calls_used?: number; readonly tokens_used?: string;
  readonly spent_cost_minor?: string; readonly cancel_requested_at?: Date | null;
}

function jobView(row: JobRow): ResearchJobView {
  return Object.freeze({ publicId: row.public_id, authorizationPublicId: row.authorization_public_id,
    status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, deadlineAt: row.deadline_at });
}

export class ResearchJobService {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) { this.events = new EventStore(database); }

  public async createFromAuthorization(authorizationPublicId: string): Promise<ResearchJobView> {
    return this.database.transaction(async (tx) => {
      const auth = await tx.query<{
        id: string; proposal_id: string; status: string; valid_from: Date; expires_at: Date;
        max_cost_minor: string; currency: string; max_duration_seconds: number;
        max_calls: number; max_tokens: string; policy_set_hash: string;
        eligibility_score_run_id: string; evidence: { maxAttempts?: number };
      }>(
        `SELECT id, proposal_id, status, valid_from, expires_at, max_cost_minor, currency,
          max_duration_seconds, max_calls, max_tokens, policy_set_hash,
          eligibility_score_run_id, evidence
         FROM authorizations WHERE public_id = $1 FOR UPDATE`, [authorizationPublicId],
      );
      const authorization = auth.rows[0];
      if (!authorization) throw new ResearchNotFoundError("Authorization not found");
      const existing = await tx.query<JobRow>(
        `SELECT job.id, job.public_id, permit.public_id AS authorization_public_id,
          job.status, job.attempts, job.max_attempts, job.available_at, job.deadline_at
         FROM research_jobs AS job JOIN authorizations AS permit
           ON permit.id = job.authorization_id WHERE job.authorization_id = $1`,
        [authorization.id],
      );
      if (existing.rows[0]) return jobView(existing.rows[0]);
      if (authorization.status !== "VALID") throw new ResearchAuthorizationError("Authorization is not consumable");
      if (authorization.valid_from > new Date() || authorization.expires_at <= new Date()) {
        throw new ResearchAuthorizationError("Authorization expired");
      }
      const current = await tx.query<{ present: boolean }>(
        `SELECT true AS present FROM current_proposal_eligibility AS eligibility
         JOIN score_policy_activations AS activation
           ON activation.policy_set_hash = eligibility.policy_set_hash
         WHERE eligibility.proposal_id = $1
           AND eligibility.score_run_id = $2
           AND eligibility.policy_set_hash = $3
           AND activation.activation_sequence = (
             SELECT max(activation_sequence) FROM score_policy_activations
           )`, [authorization.proposal_id, authorization.eligibility_score_run_id,
          authorization.policy_set_hash],
      );
      if (!current.rows[0]) throw new ResearchAuthorizationError("Authorization snapshot or policy is stale");
      const maxAttempts = authorization.evidence.maxAttempts ?? 3;
      const inserted = await tx.query<JobRow>(
        `INSERT INTO research_jobs (
          proposal_id, authorization_id, status, plan_version, priority,
          max_cost_minor, currency, max_duration_seconds, max_calls, max_tokens,
          stop_condition, max_attempts, available_at, deadline_at
        ) VALUES ($1,$2,'QUEUED',1,0,$3,$4,$5,$6,$7,$8::jsonb,$9,
          CURRENT_TIMESTAMP, LEAST($10::timestamptz,
            CURRENT_TIMESTAMP + ($5::integer * INTERVAL '1 second')))
        RETURNING id, public_id, status, attempts,
          max_attempts, available_at, deadline_at`,
        [authorization.proposal_id, authorization.id, authorization.max_cost_minor,
          authorization.currency, authorization.max_duration_seconds, authorization.max_calls,
          authorization.max_tokens, JSON.stringify({ deterministicSimulation: true }), maxAttempts,
          authorization.expires_at],
      );
      const row = { ...inserted.rows[0]!, authorization_public_id: authorizationPublicId };
      await tx.query(`UPDATE authorizations SET status = 'CONSUMED', consumed_at = CURRENT_TIMESTAMP,
        version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'VALID'`,
      [authorization.id]);
      const correlationId = randomUUID();
      await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "research_job_created",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id, expectedSequence: 0,
        actor: { type: "system" }, correlationId,
        payload: { jobPublicId: row.public_id, permitPublicId: authorizationPublicId,
          policySetHash: authorization.policy_set_hash, deterministicSimulation: true } }]);
      return jobView(row);
    });
  }

  public async claim(workerId: string, leaseSeconds: number): Promise<ResearchJobLease | null> {
    const worker = workerId.trim().normalize("NFC");
    if (worker.length < 1 || worker.length > 200 || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new ResearchValidationError("Invalid lease request");
    return this.database.transaction(async (tx) => {
      await tx.query(`UPDATE research_jobs SET status = 'CANCELLED',
        cancelled_at = CURRENT_TIMESTAMP, lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'RUNNING' AND cancel_requested_at IS NOT NULL
          AND lease_expires_at < CURRENT_TIMESTAMP`);
      await tx.query(`UPDATE research_jobs SET status = 'FAILED', failed_at = CURRENT_TIMESTAMP,
        error_code = 'RETRIES_EXHAUSTED', lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('QUEUED','RUNNING') AND attempts >= max_attempts
          AND (status = 'QUEUED' OR lease_expires_at < CURRENT_TIMESTAMP)`);
      await tx.query(`UPDATE research_jobs SET status = 'FAILED', failed_at = CURRENT_TIMESTAMP,
        error_code = 'DEADLINE_EXCEEDED', lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('QUEUED','RUNNING') AND deadline_at <= CURRENT_TIMESTAMP`);
      const claimed = await tx.query<JobRow>(
        `WITH candidate AS (
          SELECT id FROM research_jobs
          WHERE ((status = 'QUEUED' AND available_at <= CURRENT_TIMESTAMP)
            OR (status = 'RUNNING' AND lease_expires_at < CURRENT_TIMESTAMP))
            AND cancel_requested_at IS NULL AND attempts < max_attempts
            AND deadline_at > CURRENT_TIMESTAMP
          ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE research_jobs AS job SET status = 'RUNNING', attempts = job.attempts + 1,
          lease_owner = $1, lease_expires_at = CURRENT_TIMESTAMP + ($2::integer * INTERVAL '1 second'),
          started_at = COALESCE(job.started_at, CURRENT_TIMESTAMP), version = job.version + 1,
          updated_at = CURRENT_TIMESTAMP
        FROM candidate, authorizations AS permit
        WHERE job.id = candidate.id AND permit.id = job.authorization_id
        RETURNING job.id, job.public_id, permit.public_id AS authorization_public_id,
          job.status, job.attempts, job.max_attempts, job.available_at, job.deadline_at,
          job.lease_owner, job.lease_expires_at, job.max_calls, job.max_tokens,
          job.max_cost_minor, job.calls_used, job.tokens_used, job.spent_cost_minor,
          job.cancel_requested_at`, [worker, leaseSeconds],
      );
      const row = claimed.rows[0];
      if (!row) return null;
      return Object.freeze({ ...jobView(row), leaseOwner: row.lease_owner!,
        leaseExpiresAt: row.lease_expires_at!, maxCalls: row.max_calls,
        maxTokens: Number(row.max_tokens), maxCostMinor: Number(row.max_cost_minor) });
    });
  }

  public async complete(
    jobPublicId: string, workerId: string,
    usage: Readonly<{ calls: number; tokens: number; costMinor: number }>,
    output: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    for (const value of [usage.calls, usage.tokens, usage.costMinor]) if (!Number.isSafeInteger(value) || value < 0) throw new ResearchValidationError("Invalid usage");
    await this.database.transaction(async (tx) => {
      const result = await tx.query<JobRow>(
        `SELECT job.*, permit.public_id AS authorization_public_id
         FROM research_jobs AS job JOIN authorizations AS permit
           ON permit.id = job.authorization_id
         WHERE job.public_id = $1 FOR UPDATE OF job`, [jobPublicId],
      );
      const row = result.rows[0];
      if (!row) throw new ResearchNotFoundError("Research job not found");
      if (row.status !== "RUNNING" || row.lease_owner !== workerId ||
        !row.lease_expires_at || row.lease_expires_at <= new Date()) throw new ResearchLeaseError("Invalid or expired lease");
      if (row.cancel_requested_at) {
        await tx.query(`UPDATE research_jobs SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP,
          lease_owner = NULL, lease_expires_at = NULL, version = version + 1,
          updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
        return;
      }
      if ((row.calls_used ?? 0) + usage.calls > row.max_calls ||
        Number(row.tokens_used ?? 0) + usage.tokens > Number(row.max_tokens) ||
        Number(row.spent_cost_minor ?? 0) + usage.costMinor > Number(row.max_cost_minor)) throw new ResearchBudgetError("Research budget exceeded");
      await tx.query(`UPDATE research_jobs SET status = 'COMPLETED',
        calls_used = calls_used + $1, tokens_used = tokens_used + $2,
        spent_cost_minor = spent_cost_minor + $3, execution_output = $4::jsonb,
        completed_at = CURRENT_TIMESTAMP, lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
      [usage.calls, usage.tokens, usage.costMinor, JSON.stringify(output), row.id]);
      const correlationId = randomUUID();
      await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "research_job_completed",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id,
        expectedSequence: await eventSequence(tx, "research_job", row.id),
        actor: { type: "simulated_worker" }, correlationId,
        payload: { jobPublicId, callsUsed: usage.calls, workUnitsUsed: usage.tokens,
          costMinor: usage.costMinor, deterministicSimulation: true } }]);
    });
  }

  public async fail(jobPublicId: string, workerId: string, errorCode: string, retryDelaySeconds: number): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(errorCode) || !Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 1 || retryDelaySeconds > 300) throw new ResearchValidationError("Invalid failure");
    await this.database.transaction(async (tx) => {
      const row = (await tx.query<JobRow>(`SELECT job.*, permit.public_id AS authorization_public_id
        FROM research_jobs AS job JOIN authorizations AS permit ON permit.id = job.authorization_id
        WHERE job.public_id = $1 FOR UPDATE OF job`, [jobPublicId])).rows[0];
      if (!row) throw new ResearchNotFoundError("Research job not found");
      if (row.status !== "RUNNING" || row.lease_owner !== workerId || !row.lease_expires_at || row.lease_expires_at <= new Date()) throw new ResearchLeaseError("Invalid or expired lease");
      const exhausted = row.attempts >= row.max_attempts;
      await tx.query(`UPDATE research_jobs SET status = $1,
        available_at = CASE WHEN $1 = 'QUEUED' THEN CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second') ELSE available_at END,
        failed_at = CASE WHEN $1 = 'FAILED' THEN CURRENT_TIMESTAMP ELSE NULL END,
        error_code = $3, lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [exhausted ? "FAILED" : "QUEUED", retryDelaySeconds, errorCode, row.id]);
      const correlationId = randomUUID();
      await this.events.appendMany(tx, [{ eventId: randomUUID(),
        eventType: exhausted ? "research_job_failed" : "research_job_retry_scheduled",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id,
        expectedSequence: await eventSequence(tx, "research_job", row.id),
        actor: { type: "simulated_worker" }, correlationId,
        payload: { jobPublicId, errorCode, attempts: row.attempts,
          retryScheduled: !exhausted, retryDelaySeconds: exhausted ? 0 : retryDelaySeconds } }]);
    });
  }

  public async cancel(jobPublicId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const current = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM research_jobs WHERE public_id = $1 FOR UPDATE`, [jobPublicId]);
      const row = current.rows[0];
      if (!row || ["COMPLETED", "FAILED", "CANCELLED"].includes(row.status))
        throw new ResearchConflictError("Job cannot be cancelled");
      await tx.query(`UPDATE research_jobs SET
        cancel_requested_at = COALESCE(cancel_requested_at, CURRENT_TIMESTAMP),
        status = CASE WHEN status IN ('CREATED','QUEUED','PAUSED') THEN 'CANCELLED' ELSE status END,
        cancelled_at = CASE WHEN status IN ('CREATED','QUEUED','PAUSED') THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`, [row.id]);
      const correlationId = randomUUID();
      await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "research_job_cancel_requested",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id,
        expectedSequence: await eventSequence(tx, "research_job", row.id),
        actor: { type: "system" }, correlationId,
        payload: { jobPublicId, runningAtRequest: row.status === "RUNNING" } }]);
    });
  }
}
