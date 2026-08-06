import { createHash, randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import {
  AdministrativeConflictError,
  AdministrativeNotFoundError,
  AdministrativeValidationError,
} from "./errors.js";
import { assertAdministrativeAuthority } from "./authority.js";
import type {
  AdministrativeContext,
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

function encodeCursor(publicId: string, scoreRunId: string, policySetHash: string): string {
  return Buffer.from(JSON.stringify([publicId, scoreRunId, policySetHash]), "utf8")
    .toString("base64url");
}

function decodeCursor(value: string | undefined): readonly [string, string, string] | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 500) {
    throw new AdministrativeValidationError("Invalid cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3 ||
      typeof parsed[0] !== "string" || typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string") throw new Error();
    if (!/^[0-9a-f-]{36}$/i.test(parsed[0]) ||
      !/^[0-9a-f-]{36}$/i.test(parsed[1]) || !/^[0-9a-f]{64}$/.test(parsed[2])) throw new Error();
    return [parsed[0], parsed[1], parsed[2]];
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
      if (after) {
        const cursorSnapshot = await tx.query<{ present: boolean }>(
          `SELECT true AS present FROM score_runs AS run
           JOIN proposals AS proposal ON proposal.id = run.proposal_id
           WHERE proposal.public_id = $1 AND run.id = $2
             AND run.policy_set_hash = $3`,
          [after[0], after[1], after[2]],
        );
        if (!cursorSnapshot.rows[0]) {
          throw new AdministrativeValidationError("Invalid cursor snapshot");
        }
        const activePolicy = await tx.query<{ policy_set_hash: string }>(
          `SELECT policy_set_hash FROM score_policy_activations
           ORDER BY activation_sequence DESC LIMIT 1`,
        );
        if (activePolicy.rows[0]?.policy_set_hash !== after[2]) {
          throw new AdministrativeConflictError("Eligible queue policy changed; restart pagination");
        }
      }
      const result = await tx.query<{
        public_id: string; title: string; updated_at: Date; score_run_id: string;
        policy_set_hash: string; knowledge_revision: string;
      }>(
        `SELECT proposal.public_id, proposal.title, proposal.updated_at,
           current.score_run_id, current.policy_set_hash,
           current.knowledge_revision
         FROM proposals AS proposal
         JOIN current_proposal_eligibility AS current
           ON current.proposal_id = proposal.id
         WHERE proposal.status = 'ELIGIBLE'
           AND ($1::uuid IS NULL OR proposal.public_id > $1::uuid)
         ORDER BY proposal.public_id LIMIT $2`,
        [after?.[0] ?? null, limit + 1],
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
          ? encodeCursor(last.public_id, last.score_run_id, last.policy_set_hash) : null,
      });
    });
  }

}
