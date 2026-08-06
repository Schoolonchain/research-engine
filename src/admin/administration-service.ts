import { createHash, randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import {
  AdministrativeAuthorizationError,
  AdministrativeConflictError,
  AdministrativeNotFoundError,
  AdministrativeValidationError,
} from "./errors.js";
import { assertAdministrativeAuthority } from "./authority.js";
import type {
  AdministrativeContext,
  AdministrativeRole,
  EligibleQueuePage,
  ModeratedEntityType,
  ModerationDecision,
} from "./model.js";

const TABLES = {
  SOURCE: "sources",
  CLAIM: "claims",
  EVIDENCE: "evidence",
} as const;

interface EntityRow {
  readonly id: string;
  readonly proposal_id: string;
  readonly moderation_status: string;
  readonly version: number;
}

const ENTITY_SELECTS = {
  SOURCE: `SELECT id, proposal_id, moderation_status, version FROM sources
    WHERE public_id = $1 FOR UPDATE`,
  CLAIM: `SELECT id, proposal_id, moderation_status, version FROM claims
    WHERE public_id = $1 FOR UPDATE`,
  EVIDENCE: `SELECT evidence.id, claim.proposal_id,
    evidence.moderation_status, evidence.version
    FROM evidence JOIN claims AS claim ON claim.id = evidence.claim_id
    WHERE evidence.public_id = $1 FOR UPDATE OF evidence`,
} as const;

function idempotencyKey(value: string): string {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length < 8 || normalized.length > 200) {
    throw new AdministrativeValidationError("Invalid idempotency key");
  }
  return normalized;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function alreadyApplied(
  tx: DatabaseExecutor,
  context: AdministrativeContext,
  operation: string,
  key: string,
  hash: string,
): Promise<boolean> {
  const existing = await tx.query<{ request_hash: string }>(
    `SELECT request_hash FROM administrative_mutation_receipts
     WHERE identity_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [context.identityId, operation, key],
  );
  if (!existing.rows[0]) return false;
  if (existing.rows[0].request_hash !== hash) {
    throw new AdministrativeConflictError("Idempotency key was used for another request");
  }
  return true;
}

function encodeCursor(createdAt: Date, publicId: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), publicId]), "utf8")
    .toString("base64url");
}

function decodeCursor(value: string | undefined): readonly [Date, string] | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 500) {
    throw new AdministrativeValidationError("Invalid cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== "string" || typeof parsed[1] !== "string") throw new Error();
    const date = new Date(parsed[0]);
    if (!Number.isFinite(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(parsed[1])) throw new Error();
    return [date, parsed[1]];
  } catch {
    throw new AdministrativeValidationError("Invalid cursor");
  }
}

async function eventSequence(
  tx: DatabaseExecutor,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const result = await tx.query<{ current_sequence: string }>(
    `SELECT current_sequence FROM aggregate_streams
     WHERE aggregate_type = $1 AND aggregate_id = $2`,
    [aggregateType, aggregateId],
  );
  return Number(result.rows[0]?.current_sequence ?? 0);
}

export class AdministrationService {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) {
    this.events = new EventStore(database);
  }

  public async moderate(
    context: AdministrativeContext,
    entityType: ModeratedEntityType,
    publicId: string,
    decision: ModerationDecision,
    reason: string,
    mutationKey: string,
  ): Promise<void> {
    if (!["ACCEPTED", "REJECTED"].includes(decision)) {
      throw new AdministrativeValidationError("Invalid moderation decision");
    }
    const normalizedReason = reason.trim().normalize("NFC");
    if (normalizedReason.length < 1 || normalizedReason.length > 2000) {
      throw new AdministrativeValidationError("Invalid moderation reason");
    }
    if (!/^[0-9a-f-]{36}$/i.test(publicId)) {
      throw new AdministrativeValidationError("Invalid public ID");
    }
    const table = TABLES[entityType];
    const key = idempotencyKey(mutationKey);
    const hash = requestHash({ entityType, publicId, decision, reason: normalizedReason });
    const correlationId = randomUUID();
    await this.database.transaction(async (tx) => {
      await assertAdministrativeAuthority(tx, context, ["MODERATOR"]);
      if (await alreadyApplied(tx, context, "moderate", key, hash)) return;
      const selected = await tx.query<EntityRow>(
        ENTITY_SELECTS[entityType],
        [publicId],
      );
      const row = selected.rows[0];
      if (!row) throw new AdministrativeNotFoundError("Entity not found");
      const updated = await tx.query(
        `UPDATE ${table} SET moderation_status = $1,
          version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND version = $3`,
        [decision, row.id, row.version],
      );
      if (updated.rowCount !== 1) throw new Error("Moderation concurrency conflict");
      const proposal = await tx.query<{ status: string }>(
        "SELECT status FROM proposals WHERE id = $1 FOR UPDATE",
        [row.proposal_id],
      );
      const invalidated = proposal.rows[0]?.status === "ELIGIBLE";
      await tx.query(
        `UPDATE proposals SET knowledge_revision = knowledge_revision + 1,
          status = CASE WHEN status = 'ELIGIBLE' THEN 'COLLECTING' ELSE status END,
          eligibility_score_run_id = NULL,
          eligibility_policy_set_hash = NULL,
          eligibility_knowledge_revision = NULL,
          version = version + CASE WHEN status = 'ELIGIBLE' THEN 1 ELSE 0 END,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.proposal_id],
      );
      await tx.query(
        `INSERT INTO administrative_action_audit (
          actor_id, session_id, action, target_type, target_id,
          correlation_id, details, reason
        ) VALUES ($1,$2,'moderation_decided',$3,$4,$5,$6::jsonb,$7)`,
        [context.actorId, context.sessionId, entityType, row.id, correlationId,
          JSON.stringify({
            from: row.moderation_status,
            to: decision,
            reasonProvided: true,
            eligibilityInvalidated: invalidated,
          }), normalizedReason],
      );
      await tx.query(
        `INSERT INTO administrative_mutation_receipts (
          identity_id, operation, idempotency_key, request_hash, correlation_id
        ) VALUES ($1,'moderate',$2,$3,$4)`,
        [context.identityId, key, hash, correlationId],
      );
      const commands: AppendEventCommand[] = [{
        eventId: randomUUID(),
        eventType: "moderation_decided",
        eventVersion: 1,
        aggregateType: entityType.toLowerCase(),
        aggregateId: row.id,
        expectedSequence: await eventSequence(tx, entityType.toLowerCase(), row.id),
        actor: { type: "moderator", id: context.actorId },
        correlationId,
        payload: {
          entityType,
          from: row.moderation_status,
          to: decision,
          reasonProvided: true,
          eligibilityInvalidated: invalidated,
        },
      }];
      if (invalidated) {
        commands.push({
          eventId: randomUUID(),
          eventType: "eligibility_snapshot_invalidated",
          eventVersion: 1,
          aggregateType: "proposal",
          aggregateId: row.proposal_id,
          expectedSequence: await eventSequence(tx, "proposal", row.proposal_id),
          actor: { type: "moderator", id: context.actorId },
          correlationId,
          payload: {
            cause: "knowledge_moderation_changed",
            knowledgeRevisionAdvanced: true,
            executionStarted: false,
          },
        });
      }
      await this.events.appendMany(tx, commands);
    });
  }

  public async listEligible(
    context: AdministrativeContext,
    limit = 50,
    cursor?: string,
  ): Promise<EligibleQueuePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AdministrativeValidationError("Invalid limit");
    }
    const after = decodeCursor(cursor);
    return this.database.transaction(async (tx) => {
      await assertAdministrativeAuthority(
        tx, context, ["MODERATOR", "VALIDATOR", "POLICY_ADMIN"],
      );
      const result = await tx.query<{
        public_id: string; title: string; updated_at: Date; score_run_id: string;
        policy_set_hash: string; knowledge_revision: string; score_created_at: Date;
      }>(
        `WITH active_activation AS (
           SELECT policy_version, policy_set_hash FROM score_policy_activations
           ORDER BY activation_sequence DESC LIMIT 1
         )
         SELECT proposal.public_id, proposal.title, proposal.updated_at,
           run.id AS score_run_id, run.policy_set_hash,
           proposal.knowledge_revision, run.created_at AS score_created_at
         FROM proposals AS proposal
         JOIN score_runs AS run ON run.id = proposal.eligibility_score_run_id
         JOIN active_activation AS activation
           ON activation.policy_version = run.policy_version
          AND activation.policy_set_hash = run.policy_set_hash
         WHERE proposal.status = 'ELIGIBLE' AND run.eligible = true
           AND run.knowledge_revision = proposal.knowledge_revision
           AND proposal.eligibility_knowledge_revision = proposal.knowledge_revision
           AND proposal.eligibility_policy_set_hash = run.policy_set_hash
           AND ($1::timestamptz IS NULL OR
             (run.created_at, proposal.public_id) > ($1::timestamptz, $2::uuid))
         ORDER BY run.created_at, proposal.public_id LIMIT $3`,
        [after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      const pageRows = result.rows.slice(0, limit);
      const items = pageRows.map((row) => Object.freeze({
        publicId: row.public_id,
        title: row.title,
        scoreRunId: row.score_run_id,
        policySetHash: row.policy_set_hash,
        knowledgeRevision: Number(row.knowledge_revision),
        updatedAt: row.updated_at,
      }));
      const last = pageRows.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: result.rows.length > limit && last
          ? encodeCursor(last.score_created_at, last.public_id) : null,
      });
    });
  }

  public async changeIdentity(
    context: AdministrativeContext,
    targetIdentityId: string,
    change: Readonly<{ role?: AdministrativeRole; status?: "ACTIVE" | "SUSPENDED" | "REVOKED" }>,
    reason: string,
    mutationKey: string,
  ): Promise<void> {
    const key = idempotencyKey(mutationKey);
    const normalizedReason = reason.trim().normalize("NFC");
    if (normalizedReason.length < 1 || normalizedReason.length > 2000 ||
      (!change.role && !change.status) ||
      (change.role !== undefined &&
        !["MODERATOR", "POLICY_ADMIN", "VALIDATOR"].includes(change.role)) ||
      (change.status !== undefined &&
        !["ACTIVE", "SUSPENDED", "REVOKED"].includes(change.status))) {
      throw new AdministrativeValidationError("Invalid identity change");
    }
    const hash = requestHash({ targetIdentityId, ...change, reason: normalizedReason });
    await this.database.transaction(async (tx) => {
      await assertAdministrativeAuthority(tx, context, ["POLICY_ADMIN"], true);
      if (context.identityId === targetIdentityId) {
        throw new AdministrativeAuthorizationError("Self-administration is forbidden");
      }
      if (await alreadyApplied(tx, context, "change_identity", key, hash)) return;
      const target = await tx.query<{ actor_id: string; role: AdministrativeRole; status: string }>(
        `SELECT actor_id, role, status FROM administrative_identities
         WHERE id = $1 FOR UPDATE`, [targetIdentityId],
      );
      if (!target.rows[0]) throw new AdministrativeNotFoundError("Identity not found");
      const correlationId = randomUUID();
      await tx.query(
        `UPDATE administrative_identities SET role = COALESCE($1, role),
          status = COALESCE($2, status), updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [change.role ?? null, change.status ?? null, targetIdentityId],
      );
      if (change.status && change.status !== "ACTIVE") {
        await tx.query(
          `UPDATE administrative_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
           WHERE identity_id = $1`, [targetIdentityId],
        );
      }
      await tx.query(
        `INSERT INTO administrative_action_audit (
          actor_id, session_id, action, target_type, target_id,
          correlation_id, details, reason
        ) VALUES ($1,$2,'administrative_identity_changed','ADMINISTRATIVE_IDENTITY',
          $3,$4,$5::jsonb,$6)`,
        [context.actorId, context.sessionId, targetIdentityId, correlationId,
          JSON.stringify({ roleChanged: change.role !== undefined,
            statusChanged: change.status !== undefined, reasonProvided: true }),
          normalizedReason],
      );
      await tx.query(
        `INSERT INTO administrative_mutation_receipts (
          identity_id, operation, idempotency_key, request_hash, correlation_id
        ) VALUES ($1,'change_identity',$2,$3,$4)`,
        [context.identityId, key, hash, correlationId],
      );
    });
  }
}
