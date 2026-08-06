import { randomUUID } from "node:crypto";
import type { TransactionalDatabase } from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import { assertAdministrativeAuthority } from "../admin/authority.js";
import type { AdministrativeContext } from "../admin/model.js";
import { ResearchAuthorizationError, ResearchConflictError, ResearchNotFoundError, ResearchValidationError } from "./errors.js";
import { boundedKey, eventSequence, requestHash } from "./helpers.js";
import type { AuthorizationView, IssueAuthorizationInput } from "./model.js";

interface AuthorizationRow {
  readonly id: string; readonly public_id: string; readonly status: string;
  readonly policy_set_hash: string; readonly eligibility_score_run_id: string;
  readonly expires_at: Date; readonly issued_by_actor_id?: string;
}

function view(row: AuthorizationRow): AuthorizationView {
  return Object.freeze({ publicId: row.public_id, status: row.status,
    policySetHash: row.policy_set_hash, eligibilityScoreRunId: row.eligibility_score_run_id,
    expiresAt: row.expires_at });
}

function limits(input: IssueAuthorizationInput): void {
  if (input.type !== "ADMIN" && input.type !== "THRESHOLD") throw new ResearchValidationError("PAYMENT is outside Phase 8");
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date()) throw new ResearchValidationError("Invalid authorization expiry");
  for (const [name, value, max] of [
    ["maxCostMinor", input.maxCostMinor, Number.MAX_SAFE_INTEGER],
    ["maxDurationSeconds", input.maxDurationSeconds, 86_400],
    ["maxCalls", input.maxCalls, 10_000], ["maxTokens", input.maxTokens, 10_000_000],
    ["maxAttempts", input.maxAttempts, 10],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === "maxCostMinor" ? 0 : 1) || value > max) throw new ResearchValidationError(`Invalid ${name}`);
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new ResearchValidationError("Invalid currency");
}

export class AuthorizationService {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) { this.events = new EventStore(database); }

  public async issue(context: AdministrativeContext, input: IssueAuthorizationInput): Promise<AuthorizationView> {
    limits(input);
    const key = boundedKey(input.idempotencyKey);
    const hash = requestHash({ ...input, expiresAt: input.expiresAt.toISOString() });
    return this.database.transaction(async (tx) => {
      await assertAdministrativeAuthority(tx, context, ["VALIDATOR"], true);
      const issueCorrelationId = randomUUID();
      await tx.query(
        `INSERT INTO research_mutation_receipts
          (actor_id, operation, idempotency_key, request_hash, correlation_id)
         VALUES ($1,'issue_authorization',$2,$3,$4)
         ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING`,
        [context.actorId, key, hash, issueCorrelationId],
      );
      const issueReceipt = await tx.query<{ request_hash: string }>(
        `SELECT request_hash FROM research_mutation_receipts
         WHERE actor_id = $1 AND operation = 'issue_authorization'
           AND idempotency_key = $2 FOR UPDATE`, [context.actorId, key],
      );
      if (issueReceipt.rows[0]?.request_hash !== hash) throw new ResearchConflictError("Idempotency conflict");
      const prior = await tx.query<AuthorizationRow>(
        `SELECT id, public_id, status, policy_set_hash, eligibility_score_run_id, expires_at,
          issued_by_actor_id
         FROM authorizations WHERE idempotency_key = $1`, [key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].issued_by_actor_id !== context.actorId) throw new ResearchConflictError("Idempotency key belongs to another actor");
        const evidence = await tx.query<{ request_hash: string }>(
          `SELECT evidence->>'requestHash' AS request_hash FROM authorizations WHERE id = $1`, [prior.rows[0].id],
        );
        if (evidence.rows[0]?.request_hash !== hash) throw new ResearchConflictError("Idempotency conflict");
        return view(prior.rows[0]);
      }
      const eligible = await tx.query<{
        proposal_id: string; score_run_id: string; policy_set_hash: string; policy_version: number;
      }>(
        `SELECT proposal.id AS proposal_id, current.score_run_id,
          current.policy_set_hash, run.policy_version
         FROM proposals AS proposal
         JOIN current_proposal_eligibility AS current ON current.proposal_id = proposal.id
         JOIN score_runs AS run ON run.id = current.score_run_id
         WHERE proposal.public_id = $1 FOR UPDATE OF proposal`, [input.proposalPublicId],
      );
      const snapshot = eligible.rows[0];
      if (!snapshot) throw new ResearchAuthorizationError("Current eligible snapshot required");
      const inserted = await tx.query<AuthorizationRow>(
        `INSERT INTO authorizations (
          proposal_id, issued_by_actor_id, type, status, policy_version, evidence,
          idempotency_key, max_cost_minor, currency, max_duration_seconds,
          max_calls, max_tokens, expires_at, eligibility_score_run_id, policy_set_hash
        ) VALUES ($1,$2,$3,'VALID',$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id, public_id, status, policy_set_hash, eligibility_score_run_id, expires_at`,
        [snapshot.proposal_id, context.actorId, input.type, snapshot.policy_version,
          JSON.stringify({ requestHash: hash, maxAttempts: input.maxAttempts }), key,
          input.maxCostMinor, input.currency, input.maxDurationSeconds, input.maxCalls,
          input.maxTokens, input.expiresAt, snapshot.score_run_id, snapshot.policy_set_hash],
      );
      const row = inserted.rows[0]!;
      await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "authorization_issued",
        eventVersion: 1, aggregateType: "authorization", aggregateId: row.id,
        expectedSequence: 0, actor: { type: "validator", id: context.actorId }, correlationId: issueCorrelationId,
        payload: { permitPublicId: row.public_id, proposalPublicId: input.proposalPublicId,
          type: input.type, policySetHash: snapshot.policy_set_hash, executionStarted: false } }]);
      return view(row);
    });
  }

  public async revoke(context: AdministrativeContext, publicId: string, reason: string, idempotencyKey: string): Promise<AuthorizationView> {
    const key = boundedKey(idempotencyKey);
    const normalizedReason = reason.trim().normalize("NFC");
    if (normalizedReason.length < 1 || normalizedReason.length > 2000) throw new ResearchValidationError("Invalid revocation reason");
    const hash = requestHash({ publicId, reason: normalizedReason });
    return this.database.transaction(async (tx) => {
      await assertAdministrativeAuthority(tx, context, ["VALIDATOR"], true);
      const auth = await tx.query<AuthorizationRow>(
        `SELECT id, public_id, status, policy_set_hash, eligibility_score_run_id, expires_at
         FROM authorizations WHERE public_id = $1 FOR UPDATE`, [publicId],
      );
      const row = auth.rows[0];
      if (!row) throw new ResearchNotFoundError("Authorization not found");
      const receipt = await tx.query<{ request_hash: string }>(
        `SELECT request_hash FROM research_mutation_receipts
         WHERE actor_id = $1 AND operation = 'revoke_authorization' AND idempotency_key = $2`,
        [context.actorId, key],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_hash !== hash) throw new ResearchConflictError("Idempotency conflict");
        return view(row);
      }
      if (row.status === "CONSUMED") throw new ResearchConflictError("Consumed authorization cannot be revoked");
      if (row.status !== "REVOKED") await tx.query(
        `UPDATE authorizations SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP,
          revocation_reason = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [normalizedReason, row.id],
      );
      const correlationId = randomUUID();
      await tx.query(`INSERT INTO research_mutation_receipts
        (actor_id, operation, idempotency_key, request_hash, correlation_id)
        VALUES ($1,'revoke_authorization',$2,$3,$4)`, [context.actorId, key, hash, correlationId]);
      await this.events.appendMany(tx, [{ eventId: randomUUID(), eventType: "authorization_revoked",
        eventVersion: 1, aggregateType: "authorization", aggregateId: row.id,
        expectedSequence: await eventSequence(tx, "authorization", row.id),
        actor: { type: "validator", id: context.actorId }, correlationId,
        payload: { permitPublicId: publicId, reasonProvided: true, executionStarted: false } }]);
      return Object.freeze({ ...view(row), status: "REVOKED" });
    });
  }
}
