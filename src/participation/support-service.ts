import { randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import {
  EventConcurrencyError,
  EventStore,
  type AppendEventCommand,
} from "../events/event-store.js";
import {
  DuplicateSupportError,
  ParticipationConflictError,
  SupportNotFoundError,
} from "./errors.js";
import { ParticipationKeyDeriver } from "./identity.js";
import {
  DEFAULT_PARTICIPATION_RATE_POLICY,
  type ParticipationIdentity,
  type ParticipationRatePolicy,
  type SupportResult,
} from "./model.js";
import { ParticipationRateLimiter } from "./rate-limiter.js";

interface ProposalRow {
  readonly id: string;
  readonly public_id: string;
  readonly status: string;
  readonly support_count: string;
  readonly version: number;
}

interface SupportRow {
  readonly id: string;
}

const MAX_CONCURRENCY_RETRIES = 3;
const SUPPORTABLE_STATUSES = new Set(["OPEN", "COLLECTING"]);

async function proposalForSupport(
  transaction: DatabaseExecutor,
  publicId: string,
): Promise<ProposalRow> {
  const result = await transaction.query<ProposalRow>(
    `
      SELECT id, public_id, status, support_count, version
      FROM proposals
      WHERE public_id = $1 AND status <> 'DELETED'
    `,
    [publicId],
  );
  const row = result.rows[0];
  if (!row) throw new ParticipationConflictError("Proposal is unavailable");
  if (!SUPPORTABLE_STATUSES.has(row.status)) {
    throw new ParticipationConflictError(
      `Proposal cannot receive support in status ${row.status}`,
    );
  }
  return row;
}

function supportEvent(
  row: ProposalRow,
  identity: ParticipationIdentity,
  eventType: "support_added" | "support_revoked",
  resultingCount: number,
): AppendEventCommand {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    aggregateType: "proposal",
    aggregateId: row.id,
    expectedSequence: row.version,
    actor: identity.actorId
      ? { type: "user", id: identity.actorId }
      : { type: "anonymous" },
    correlationId: randomUUID(),
    payload: {
      resultingSupportCount: resultingCount,
      participationPolicyVersion: 1,
    },
  };
}

export class SupportService {
  private readonly events: EventStore;
  private readonly keys: ParticipationKeyDeriver;
  private readonly limiter: ParticipationRateLimiter;

  public constructor(
    private readonly database: TransactionalDatabase,
    hmacKey: string,
    policy: ParticipationRatePolicy = DEFAULT_PARTICIPATION_RATE_POLICY,
  ) {
    this.events = new EventStore(database);
    this.keys = new ParticipationKeyDeriver(hmacKey);
    this.limiter = new ParticipationRateLimiter(database, policy);
  }

  public async add(
    identity: ParticipationIdentity,
    proposalPublicId: string,
  ): Promise<SupportResult> {
    const keys = this.keys.derive(identity);
    await this.limiter.consume("support_add", keys);

    return this.withConcurrencyRetry(async () => {
      const changed = await this.events.transactPrepared(
        async (transaction) => {
          const row = await proposalForSupport(transaction, proposalPublicId);
          return supportEvent(
            row,
            identity,
            "support_added",
            Number(row.support_count) + 1,
          );
        },
        async (transaction, command) => {
          const inserted = await transaction.query<SupportRow>(
            `
              INSERT INTO supports (
                proposal_id, actor_id, subject_key_hash, policy_version
              )
              SELECT id, $1, $2, 1
              FROM proposals
              WHERE id = $3
              ON CONFLICT (proposal_id, subject_key_hash)
                WHERE status = 'ACTIVE'
              DO NOTHING
              RETURNING id
            `,
            [
              identity.actorId ?? null,
              keys.subjectKeyHash,
              command.aggregateId,
            ],
          );
          if (inserted.rowCount === 0) throw new DuplicateSupportError();

          const updated = await transaction.query<ProposalRow>(
            `
              UPDATE proposals
              SET
                support_count = support_count + 1,
                version = version + 1,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND version = $2
              RETURNING id, public_id, status, support_count, version
            `,
            [command.aggregateId, command.expectedSequence],
          );
          const row = updated.rows[0];
          if (!row) {
            throw new EventConcurrencyError(
              "proposal",
              command.aggregateId,
              command.expectedSequence,
            );
          }
          return Object.freeze({
            proposalPublicId: row.public_id,
            supportCount: Number(row.support_count),
            proposalVersion: row.version,
            supported: true,
          });
        },
      );
      return changed.result;
    });
  }

  public async revoke(
    identity: ParticipationIdentity,
    proposalPublicId: string,
  ): Promise<SupportResult> {
    const keys = this.keys.derive(identity);
    await this.limiter.consume("support_revoke", keys);

    return this.withConcurrencyRetry(async () => {
      const changed = await this.events.transactPrepared(
        async (transaction) => {
          const row = await proposalForSupport(transaction, proposalPublicId);
          return supportEvent(
            row,
            identity,
            "support_revoked",
            Math.max(0, Number(row.support_count) - 1),
          );
        },
        async (transaction, command) => {
          const revoked = await transaction.query<SupportRow>(
            `
              UPDATE supports
              SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
              WHERE
                proposal_id = $1
                AND subject_key_hash = $2
                AND status = 'ACTIVE'
              RETURNING id
            `,
            [command.aggregateId, keys.subjectKeyHash],
          );
          if (revoked.rowCount === 0) throw new SupportNotFoundError();

          const updated = await transaction.query<ProposalRow>(
            `
              UPDATE proposals
              SET
                support_count = GREATEST(0, support_count - 1),
                version = version + 1,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND version = $2
              RETURNING id, public_id, status, support_count, version
            `,
            [command.aggregateId, command.expectedSequence],
          );
          const row = updated.rows[0];
          if (!row) {
            throw new EventConcurrencyError(
              "proposal",
              command.aggregateId,
              command.expectedSequence,
            );
          }
          return Object.freeze({
            proposalPublicId: row.public_id,
            supportCount: Number(row.support_count),
            proposalVersion: row.version,
            supported: false,
          });
        },
      );
      return changed.result;
    });
  }

  private async withConcurrencyRetry<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 1; attempt <= MAX_CONCURRENCY_RETRIES; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof EventConcurrencyError) ||
          attempt === MAX_CONCURRENCY_RETRIES
        ) {
          throw error;
        }
      }
    }
    throw new Error("Unreachable concurrency retry state");
  }
}

