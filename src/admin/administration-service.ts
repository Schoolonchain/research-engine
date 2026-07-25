import { randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import {
  AdministrativeAuthorizationError,
  AdministrativeNotFoundError,
  AdministrativeValidationError,
} from "./errors.js";
import type {
  AdministrativeContext,
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
  readonly moderation_status: string;
  readonly version: number;
}

function requireRole(
  context: AdministrativeContext,
  allowed: readonly AdministrativeContext["role"][],
): void {
  if (!allowed.includes(context.role)) {
    throw new AdministrativeAuthorizationError("Role is not permitted");
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
  ): Promise<void> {
    requireRole(context, ["MODERATOR"]);
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
    const correlationId = randomUUID();
    await this.database.transaction(async (tx) => {
      const selected = await tx.query<EntityRow>(
        `SELECT id, moderation_status, version FROM ${table}
         WHERE public_id = $1 FOR UPDATE`,
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
      await tx.query(
        `INSERT INTO administrative_action_audit (
          actor_id, session_id, action, target_type, target_id,
          correlation_id, details
        ) VALUES ($1,$2,'moderation_decided',$3,$4,$5,$6::jsonb)`,
        [context.actorId, context.sessionId, entityType, row.id, correlationId,
          JSON.stringify({
            from: row.moderation_status,
            to: decision,
            reasonRecorded: true,
          })],
      );
      await this.events.appendMany(tx, [{
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
          reasonRecorded: true,
        },
      }]);
    });
  }

  public async listEligible(
    context: AdministrativeContext,
    limit = 50,
  ): Promise<readonly Readonly<{ publicId: string; title: string; updatedAt: Date }>[]> {
    requireRole(context, ["MODERATOR", "VALIDATOR", "POLICY_ADMIN"]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AdministrativeValidationError("Invalid limit");
    }
    return this.database.transaction(async (tx) => {
      const result = await tx.query<{
        public_id: string; title: string; updated_at: Date;
      }>(
        `SELECT public_id, title, updated_at FROM proposals
         WHERE status = 'ELIGIBLE'
         ORDER BY updated_at, public_id LIMIT $1`,
        [limit],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        publicId: row.public_id,
        title: row.title,
        updatedAt: row.updated_at,
      })));
    });
  }
}
