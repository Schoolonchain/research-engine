import { randomUUID } from "node:crypto";
import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import { eventSequence } from "./helpers.js";
import { ResearchAuthorizationError, ResearchBudgetError, ResearchConflictError, ResearchLeaseError, ResearchNotFoundError, ResearchValidationError } from "./errors.js";
import type { ResearchJobLease, ResearchJobView } from "./model.js";

interface Usage { readonly calls: number; readonly tokens: number; readonly costMinor: number }
interface JobRow {
  readonly id: string; readonly public_id: string; readonly authorization_public_id: string;
  readonly status: string; readonly attempts: number; readonly max_attempts: number;
  readonly available_at: Date; readonly deadline_at: Date; readonly lease_owner?: string;
  readonly lease_expires_at?: Date; readonly lease_token?: string;
  readonly max_calls: number; readonly max_tokens: string;
  readonly max_cost_minor: string; readonly calls_used: number; readonly tokens_used: string;
  readonly spent_cost_minor: string; readonly cancel_requested_at?: Date | null;
  readonly deadline_exceeded?: boolean;
}

function jobView(row: JobRow): ResearchJobView {
  return Object.freeze({ publicId: row.public_id, authorizationPublicId: row.authorization_public_id,
    status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, deadlineAt: row.deadline_at });
}
function validateUsage(usage: Usage): void {
  for (const value of [usage.calls, usage.tokens, usage.costMinor]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new ResearchValidationError("Invalid usage");
  }
}
function validateOutput(output: Readonly<Record<string, unknown>>): void {
  if (!output || Array.isArray(output) || Object.getPrototypeOf(output) !== Object.prototype) {
    throw new ResearchValidationError("Invalid deterministic output");
  }
  const keys = Object.keys(output).sort();
  if (keys.join(",") !== "digest,kind,provider,publication" ||
    output["kind"] !== "DETERMINISTIC_SIMULATION" ||
    typeof output["digest"] !== "string" || !/^[a-f0-9]{64}$/.test(output["digest"]) ||
    output["provider"] !== null || output["publication"] !== false) {
    throw new ResearchValidationError("Invalid deterministic output");
  }
}

export class ResearchJobService {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) { this.events = new EventStore(database); }

  private async terminalEvent(tx: DatabaseExecutor, row: Pick<JobRow, "id" | "public_id">,
    status: "FAILED" | "CANCELLED" | "COMPLETED", errorCode: string | null, actorType: string): Promise<void> {
    await this.events.appendMany(tx, [{ eventId: randomUUID(),
      eventType: `research_job_${status.toLowerCase()}`, eventVersion: 1,
      aggregateType: "research_job", aggregateId: row.id,
      expectedSequence: await eventSequence(tx, "research_job", row.id),
      actor: { type: actorType }, correlationId: randomUUID(),
      payload: { jobPublicId: row.public_id, terminalStatus: status,
        errorCode, deterministicSimulation: true } }]);
  }

  private async recordUsage(tx: DatabaseExecutor, row: JobRow, usage: Usage,
    outcome: "COMPLETED" | "FAILED" | "CANCELLED", errorCode: string | null): Promise<void> {
    if (row.calls_used + usage.calls > row.max_calls ||
      Number(row.tokens_used) + usage.tokens > Number(row.max_tokens) ||
      Number(row.spent_cost_minor) + usage.costMinor > Number(row.max_cost_minor)) {
      throw new ResearchBudgetError("Research budget exceeded");
    }
    await tx.query(`INSERT INTO research_job_attempt_usage
      (research_job_id, attempt, calls_used, tokens_used, cost_minor, outcome, error_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.id, row.attempts, usage.calls, usage.tokens, usage.costMinor, outcome, errorCode]);
    await tx.query(`UPDATE research_jobs SET calls_used = calls_used + $1,
      tokens_used = tokens_used + $2, spent_cost_minor = spent_cost_minor + $3 WHERE id = $4`,
    [usage.calls, usage.tokens, usage.costMinor, row.id]);
  }

  private async cancelRunning(tx: DatabaseExecutor, row: JobRow, usage: Usage): Promise<void> {
    await this.recordUsage(tx, row, usage, "CANCELLED", "CANCEL_REQUESTED");
    await tx.query(`UPDATE research_jobs SET status = 'CANCELLED', cancelled_at = clock_timestamp(),
      error_code = 'CANCEL_REQUESTED', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
      version = version + 1, updated_at = clock_timestamp() WHERE id = $1`, [row.id]);
    await this.terminalEvent(tx, row, "CANCELLED", "CANCEL_REQUESTED", "simulated_worker");
  }

  private async finalizeAbandoned(tx: DatabaseExecutor): Promise<void> {
    const rows = await tx.query<JobRow>(`SELECT job.*, permit.public_id AS authorization_public_id,
      job.deadline_at <= clock_timestamp() AS deadline_exceeded
      FROM research_jobs AS job JOIN authorizations AS permit ON permit.id = job.authorization_id
      WHERE (job.status = 'RUNNING' AND job.lease_expires_at <= clock_timestamp()
          AND job.cancel_requested_at IS NOT NULL)
        OR (job.status IN ('QUEUED','RUNNING') AND job.deadline_at <= clock_timestamp())
        OR (job.status IN ('QUEUED','RUNNING') AND job.attempts >= job.max_attempts
          AND (job.status = 'QUEUED' OR job.lease_expires_at <= clock_timestamp()))
      ORDER BY job.created_at FOR UPDATE OF job SKIP LOCKED LIMIT 100`);
    for (const row of rows.rows) {
      const cancelled = row.cancel_requested_at !== null && row.cancel_requested_at !== undefined;
      const deadline = row.deadline_exceeded === true;
      const status = cancelled ? "CANCELLED" as const : "FAILED" as const;
      const code = cancelled ? "CANCEL_REQUESTED" : deadline ? "DEADLINE_EXCEEDED" : "RETRIES_EXHAUSTED";
      await tx.query(`UPDATE research_jobs SET status = $1,
        cancelled_at = CASE WHEN $1 = 'CANCELLED' THEN clock_timestamp() ELSE cancelled_at END,
        failed_at = CASE WHEN $1 = 'FAILED' THEN clock_timestamp() ELSE failed_at END,
        error_code = $2, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = clock_timestamp() WHERE id = $3`, [status, code, row.id]);
      await this.terminalEvent(tx, row, status, code, "system");
    }
  }

  public async createFromAuthorization(authorizationPublicId: string): Promise<ResearchJobView> {
    return this.database.transaction(async (tx) => {
      const authorization = (await tx.query<{
        id: string; proposal_id: string; type: string; status: string; valid_from: Date; expires_at: Date;
        max_cost_minor: string; currency: string; max_duration_seconds: number;
        max_calls: number; max_tokens: string; policy_set_hash: string;
        eligibility_score_run_id: string | null; evidence: { maxAttempts?: number };
      }>(`SELECT id, proposal_id, type, status, valid_from, expires_at, max_cost_minor, currency,
          max_duration_seconds, max_calls, max_tokens, policy_set_hash,
          eligibility_score_run_id, evidence FROM authorizations WHERE public_id = $1 FOR UPDATE`,
      [authorizationPublicId])).rows[0];
      if (!authorization) throw new ResearchNotFoundError("Authorization not found");
      const existing = await tx.query<JobRow>(`SELECT job.*, permit.public_id AS authorization_public_id
        FROM research_jobs AS job JOIN authorizations AS permit ON permit.id = job.authorization_id
        WHERE job.authorization_id = $1`, [authorization.id]);
      if (existing.rows[0]) return jobView(existing.rows[0]);
      if (authorization.status !== "VALID") throw new ResearchAuthorizationError("Authorization is not consumable");
      const time = await tx.query<{ valid: boolean }>(`SELECT $1::timestamptz <= clock_timestamp()
        AND $2::timestamptz > clock_timestamp() AS valid`, [authorization.valid_from, authorization.expires_at]);
      if (!time.rows[0]?.valid) throw new ResearchAuthorizationError("Authorization expired");
      await tx.query(
        "SELECT name FROM administrative_locks WHERE name = 'policy_activation' FOR SHARE",
      );
      const active = await tx.query<{ policy_set_hash: string }>(`SELECT policy_set_hash
        FROM score_policy_activations ORDER BY activation_sequence DESC LIMIT 1`);
      if (active.rows[0]?.policy_set_hash !== authorization.policy_set_hash) {
        throw new ResearchAuthorizationError("Authorization policy is stale");
      }
      if (authorization.type === "THRESHOLD") {
        const current = await tx.query<{ present: boolean }>(`SELECT true AS present
          FROM current_proposal_eligibility WHERE proposal_id = $1 AND score_run_id = $2
            AND policy_set_hash = $3`, [authorization.proposal_id,
          authorization.eligibility_score_run_id, authorization.policy_set_hash]);
        if (!current.rows[0]) throw new ResearchAuthorizationError("Authorization snapshot is stale");
      }
      const inserted = await tx.query<JobRow>(`INSERT INTO research_jobs (
        proposal_id, authorization_id, status, plan_version, priority, max_cost_minor, currency,
        max_duration_seconds, max_calls, max_tokens, stop_condition, max_attempts,
        available_at, deadline_at) VALUES ($1,$2,'QUEUED',1,0,$3,$4,$5,$6,$7,$8::jsonb,$9,
        clock_timestamp(), LEAST($10::timestamptz, clock_timestamp() + ($5::integer * INTERVAL '1 second')))
        RETURNING *`, [authorization.proposal_id, authorization.id, authorization.max_cost_minor,
        authorization.currency, authorization.max_duration_seconds, authorization.max_calls,
        authorization.max_tokens, JSON.stringify({ deterministicSimulation: true }),
        authorization.evidence.maxAttempts ?? 3, authorization.expires_at]);
      const row = { ...inserted.rows[0]!, authorization_public_id: authorizationPublicId };
      const consumed = await tx.query(`UPDATE authorizations SET status = 'CONSUMED',
        consumed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'VALID'`, [authorization.id]);
      if (consumed.rowCount !== 1) throw new ResearchConflictError("Authorization consumption conflict");
      const correlationId = randomUUID();
      await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "authorization_consumed",
        eventVersion: 1, aggregateType: "authorization", aggregateId: authorization.id,
        expectedSequence: await eventSequence(tx, "authorization", authorization.id),
        actor: { type: "system" }, correlationId, payload: { permitPublicId: authorizationPublicId,
          jobPublicId: row.public_id, consumedExactlyOnce: true } },
      { eventId: randomUUID(), eventType: "research_job_created",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id, expectedSequence: 0,
        actor: { type: "system" }, correlationId, payload: { jobPublicId: row.public_id,
          permitPublicId: authorizationPublicId, policySetHash: authorization.policy_set_hash,
          deterministicSimulation: true } }]);
      return jobView(row);
    });
  }

  public async claim(workerId: string, leaseSeconds: number): Promise<ResearchJobLease | null> {
    const worker = workerId.trim().normalize("NFC");
    if (worker.length < 1 || worker.length > 200 || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new ResearchValidationError("Invalid lease request");
    return this.database.transaction(async (tx) => {
      await this.finalizeAbandoned(tx);
      const claimed = await tx.query<JobRow>(`WITH candidate AS (
        SELECT id FROM research_jobs WHERE ((status = 'QUEUED' AND available_at <= clock_timestamp())
          OR (status = 'RUNNING' AND lease_expires_at <= clock_timestamp()))
          AND cancel_requested_at IS NULL AND attempts < max_attempts AND deadline_at > clock_timestamp()
        ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE research_jobs AS job SET status = 'RUNNING', attempts = job.attempts + 1,
          lease_owner = $1, lease_token = gen_random_uuid(),
          lease_expires_at = LEAST(job.deadline_at,
            clock_timestamp() + ($2::integer * INTERVAL '1 second')),
          started_at = COALESCE(job.started_at, clock_timestamp()), version = job.version + 1,
          updated_at = clock_timestamp() FROM candidate, authorizations AS permit
        WHERE job.id = candidate.id AND permit.id = job.authorization_id
        RETURNING job.*, permit.public_id AS authorization_public_id`, [worker, leaseSeconds]);
      const row = claimed.rows[0];
      if (!row) return null;
      return Object.freeze({ ...jobView(row), leaseOwner: row.lease_owner!,
        leaseToken: row.lease_token!, leaseExpiresAt: row.lease_expires_at!, maxCalls: row.max_calls,
        maxTokens: Number(row.max_tokens), maxCostMinor: Number(row.max_cost_minor),
        remainingCalls: row.max_calls - row.calls_used,
        remainingTokens: Number(row.max_tokens) - Number(row.tokens_used),
        remainingCostMinor: Number(row.max_cost_minor) - Number(row.spent_cost_minor) });
    });
  }

  public async complete(jobPublicId: string, workerId: string, leaseToken: string, usage: Usage,
    output: Readonly<Record<string, unknown>>): Promise<void> {
    validateUsage(usage); validateOutput(output);
    await this.database.transaction(async (tx) => {
      const row = (await tx.query<JobRow>(`SELECT job.*, permit.public_id AS authorization_public_id
        FROM research_jobs AS job JOIN authorizations AS permit ON permit.id = job.authorization_id
        WHERE job.public_id = $1 FOR UPDATE OF job`, [jobPublicId])).rows[0];
      if (!row) throw new ResearchNotFoundError("Research job not found");
      if (row.status !== "RUNNING" || row.lease_owner !== workerId || row.lease_token !== leaseToken)
        throw new ResearchLeaseError("Invalid lease generation");
      const timing = await tx.query<{ lease_valid: boolean; deadline_valid: boolean }>(
        `SELECT $1::timestamptz > clock_timestamp() AS lease_valid,
          $2::timestamptz > clock_timestamp() AS deadline_valid`, [row.lease_expires_at, row.deadline_at]);
      const timingRow = timing.rows[0];
      if (!timingRow) throw new ResearchLeaseError("Unable to validate lease");
      if (!timingRow.deadline_valid) {
        await this.recordUsage(tx, row, usage, "FAILED", "DEADLINE_EXCEEDED");
        await tx.query(`UPDATE research_jobs SET status='FAILED', failed_at=clock_timestamp(),
          error_code='DEADLINE_EXCEEDED', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
          version=version+1, updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
        await this.terminalEvent(tx, row, "FAILED", "DEADLINE_EXCEEDED", "simulated_worker"); return;
      }
      if (!timingRow.lease_valid) throw new ResearchLeaseError("Expired lease");
      if (row.cancel_requested_at) { await this.cancelRunning(tx, row, usage); return; }
      await this.recordUsage(tx, row, usage, "COMPLETED", null);
      await tx.query(`UPDATE research_jobs SET status='COMPLETED', execution_output=$1::jsonb,
        completed_at=clock_timestamp(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
        version=version+1, updated_at=clock_timestamp() WHERE id=$2`, [JSON.stringify(output), row.id]);
      await this.terminalEvent(tx, row, "COMPLETED", null, "simulated_worker");
    });
  }

  public async fail(jobPublicId: string, workerId: string, leaseToken: string, errorCode: string,
    retryDelaySeconds: number, usage: Usage): Promise<void> {
    validateUsage(usage);
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(errorCode) || !Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 1 || retryDelaySeconds > 300) throw new ResearchValidationError("Invalid failure");
    await this.database.transaction(async (tx) => {
      const row = (await tx.query<JobRow>(`SELECT job.*, permit.public_id AS authorization_public_id
        FROM research_jobs AS job JOIN authorizations AS permit ON permit.id=job.authorization_id
        WHERE job.public_id=$1 FOR UPDATE OF job`, [jobPublicId])).rows[0];
      if (!row) throw new ResearchNotFoundError("Research job not found");
      if (row.status !== "RUNNING" || row.lease_owner !== workerId || row.lease_token !== leaseToken)
        throw new ResearchLeaseError("Invalid lease generation");
      const timing = await tx.query<{ lease_valid: boolean; deadline_valid: boolean }>(
        `SELECT $1::timestamptz > clock_timestamp() AS lease_valid,
          $2::timestamptz > clock_timestamp() AS deadline_valid`, [row.lease_expires_at, row.deadline_at]);
      const timingRow = timing.rows[0];
      if (!timingRow) throw new ResearchLeaseError("Unable to validate lease");
      const exhausted = row.attempts >= row.max_attempts || !timingRow.deadline_valid;
      const finalCode = !timingRow.deadline_valid ? "DEADLINE_EXCEEDED" : errorCode;
      if (!timingRow.deadline_valid) {
        await this.recordUsage(tx, row, usage, "FAILED", finalCode);
        await tx.query(`UPDATE research_jobs SET status='FAILED', failed_at=clock_timestamp(),
          error_code=$1, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
          version=version+1, updated_at=clock_timestamp() WHERE id=$2`, [finalCode, row.id]);
        await this.terminalEvent(tx, row, "FAILED", finalCode, "simulated_worker"); return;
      }
      if (!timingRow.lease_valid) throw new ResearchLeaseError("Expired lease");
      if (row.cancel_requested_at) { await this.cancelRunning(tx, row, usage); return; }
      await this.recordUsage(tx, row, usage, "FAILED", finalCode);
      await tx.query(`UPDATE research_jobs SET status=$1,
        available_at=CASE WHEN $1='QUEUED' THEN clock_timestamp()+($2*INTERVAL '1 second') ELSE available_at END,
        failed_at=CASE WHEN $1='FAILED' THEN clock_timestamp() ELSE NULL END,
        error_code=$3, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
        version=version+1, updated_at=clock_timestamp() WHERE id=$4`,
      [exhausted ? "FAILED" : "QUEUED", retryDelaySeconds, finalCode, row.id]);
      if (exhausted) await this.terminalEvent(tx, row, "FAILED", finalCode, "simulated_worker");
      else await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "research_job_retry_scheduled",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id,
        expectedSequence: await eventSequence(tx, "research_job", row.id),
        actor: { type: "simulated_worker" }, correlationId: randomUUID(),
        payload: { jobPublicId, errorCode: finalCode, attempts: row.attempts,
          retryScheduled: true, retryDelaySeconds } }]);
    });
  }

  public async cancel(jobPublicId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const row = (await tx.query<JobRow>(`SELECT job.*, permit.public_id AS authorization_public_id
        FROM research_jobs AS job JOIN authorizations AS permit ON permit.id=job.authorization_id
        WHERE job.public_id=$1 FOR UPDATE OF job`, [jobPublicId])).rows[0];
      if (!row || ["COMPLETED", "FAILED", "CANCELLED"].includes(row.status)) throw new ResearchConflictError("Job cannot be cancelled");
      const immediate = ["CREATED", "QUEUED", "PAUSED"].includes(row.status);
      await tx.query(`UPDATE research_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
        status=CASE WHEN $2 THEN 'CANCELLED' ELSE status END,
        cancelled_at=CASE WHEN $2 THEN clock_timestamp() ELSE cancelled_at END,
        error_code=CASE WHEN $2 THEN 'CANCEL_REQUESTED' ELSE error_code END,
        version=version+1, updated_at=clock_timestamp() WHERE id=$1`, [row.id, immediate]);
      if (immediate) await this.terminalEvent(tx, row, "CANCELLED", "CANCEL_REQUESTED", "system");
      else await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "research_job_cancel_requested",
        eventVersion: 1, aggregateType: "research_job", aggregateId: row.id,
        expectedSequence: await eventSequence(tx, "research_job", row.id), actor: { type: "system" },
        correlationId: randomUUID(), payload: { jobPublicId, runningAtRequest: true } }]);
    });
  }
}
