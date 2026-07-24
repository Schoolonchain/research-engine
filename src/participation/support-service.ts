import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import {
  EventConcurrencyError,
  EventStore,
  type AppendEventCommand,
} from "../events/event-store.js";
import {
  DuplicateSupportError,
  ParticipationConfigurationError,
  ParticipationContentionError,
  ParticipationConflictError,
  SupportNotFoundError,
} from "./errors.js";
import { ParticipationKeyDeriver } from "./identity.js";
import {
  DEFAULT_PARTICIPATION_RATE_POLICY,
  type ParticipationIdentity,
  type ParticipationKeyVersion,
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

interface ExistingSupportRow extends SupportRow {
  readonly subject_key_hash: string;
  readonly subject_key_id: string;
}

interface MissingKeyRow {
  readonly key_id: string;
}

interface RegisteredKeyRow {
  readonly key_verifier: string;
}

const MAX_CONCURRENCY_RETRIES = 3;
const SUPPORTABLE_STATUSES = new Set(["OPEN", "COLLECTING"]);

function hashPlaceholders(start: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(
    ", ",
  );
}

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
    hmacKeys: readonly ParticipationKeyVersion[],
    policy: ParticipationRatePolicy = DEFAULT_PARTICIPATION_RATE_POLICY,
  ) {
    this.events = new EventStore(database);
    this.keys = new ParticipationKeyDeriver(hmacKeys);
    this.limiter = new ParticipationRateLimiter(database, policy);
  }

  public async add(
    identity: ParticipationIdentity,
    proposalPublicId: string,
  ): Promise<SupportResult> {
    await this.assertReady();
    const keys = this.keys.derive(identity);
    await this.limiter.consume("support_add", keys);
    if (await this.normalizeExistingSupport(proposalPublicId, keys)) {
      throw new DuplicateSupportError();
    }

    return retryOnEventConcurrency(async () => {
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
          await this.lockSubject(transaction, keys.rateSubjectKeyHash);
          const candidates = hashPlaceholders(
            2,
            keys.subjectCandidateHashes.length,
          );
          const duplicate = await transaction.query<SupportRow>(
            `
              SELECT id
              FROM supports
              WHERE
                proposal_id = $1
                AND status = 'ACTIVE'
                AND subject_key_hash IN (${candidates})
              LIMIT 1
            `,
            [command.aggregateId, ...keys.subjectCandidateHashes],
          );
          if (duplicate.rows[0]) throw new DuplicateSupportError();

          const inserted = await transaction.query<SupportRow>(
            `
              INSERT INTO supports (
                proposal_id, actor_id, subject_key_hash,
                subject_key_id, policy_version
              )
              SELECT id, $1, $2, $3, 1
              FROM proposals
              WHERE id = $4
              ON CONFLICT (proposal_id, subject_key_hash)
                WHERE status = 'ACTIVE'
              DO NOTHING
              RETURNING id
            `,
            [
              identity.actorId ?? null,
              keys.subjectKeyHash,
              keys.subjectKeyId,
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
    await this.assertReady();
    const keys = this.keys.derive(identity);
    await this.limiter.consume("support_revoke", keys);

    return retryOnEventConcurrency(async () => {
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
          await this.lockSubject(transaction, keys.rateSubjectKeyHash);
          const candidates = hashPlaceholders(
            2,
            keys.subjectCandidateHashes.length,
          );
          const revoked = await transaction.query<SupportRow>(
            `
              UPDATE supports
              SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
              WHERE
                proposal_id = $1
                AND subject_key_hash IN (${candidates})
                AND status = 'ACTIVE'
              RETURNING id
            `,
            [command.aggregateId, ...keys.subjectCandidateHashes],
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

  private async lockSubject(
    transaction: DatabaseExecutor,
    stableKeyHash: string,
  ): Promise<void> {
    await transaction.query(
      `
        DELETE FROM participation_subject_locks
        WHERE expires_at < CURRENT_TIMESTAMP
      `,
    );
    await transaction.query(
      `
        INSERT INTO participation_subject_locks (key_hash, expires_at)
        VALUES ($1, CURRENT_TIMESTAMP + interval '24 hours')
        ON CONFLICT (key_hash)
        DO UPDATE SET
          last_used_at = CURRENT_TIMESTAMP,
          expires_at = CURRENT_TIMESTAMP + interval '24 hours'
      `,
      [stableKeyHash],
    );
  }

  public async assertReady(): Promise<void> {
    const configured = this.keys.keyDescriptors();
    await this.database.transaction(async (transaction) => {
      for (const key of configured) {
        await transaction.query(
          `
            INSERT INTO participation_key_registry (
              key_id, key_verifier, active_support_count
            )
            SELECT
              $1::varchar(100),
              $2::char(64),
              count(*) FILTER (WHERE status = 'ACTIVE')
            FROM supports
            WHERE subject_key_id = $1::varchar(100)
            ON CONFLICT (key_id) DO NOTHING
          `,
          [key.id, key.verifier],
        );
        const registered = await transaction.query<RegisteredKeyRow>(
          `
            SELECT key_verifier
            FROM participation_key_registry
            WHERE key_id = $1
          `,
          [key.id],
        );
        if (registered.rows[0]?.key_verifier !== key.verifier) {
          throw new ParticipationConfigurationError(
            `Participation key ID ${key.id} is bound to different key material`,
          );
        }
        await transaction.query(
          `
            UPDATE participation_key_registry
            SET last_verified_at = CURRENT_TIMESTAMP
            WHERE key_id = $1
          `,
          [key.id],
        );
      }

      const configuredIds = configured.map((key) => key.id);
      const placeholders = hashPlaceholders(1, configuredIds.length);
      const missing = await transaction.query<MissingKeyRow>(
        `
          SELECT key_id
          FROM participation_key_registry
          WHERE
            active_support_count > 0
            AND key_id NOT IN (${placeholders})
          ORDER BY key_id
        `,
        configuredIds,
      );
      if (missing.rows.length > 0) {
        throw new ParticipationConfigurationError(
          `Participation keyring is missing active key IDs: ${missing.rows
            .map((row) => row.key_id)
            .join(", ")}`,
        );
      }
    });
  }

  private normalizeExistingSupport(
    proposalPublicId: string,
    keys: ReturnType<ParticipationKeyDeriver["derive"]>,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await proposalForSupport(transaction, proposalPublicId);
      await this.lockSubject(transaction, keys.rateSubjectKeyHash);
      const candidates = hashPlaceholders(
        2,
        keys.subjectCandidateHashes.length,
      );
      const result = await transaction.query<ExistingSupportRow>(
        `
          SELECT
            support.id,
            support.subject_key_hash,
            support.subject_key_id
          FROM supports AS support
          INNER JOIN proposals AS proposal
            ON proposal.id = support.proposal_id
          WHERE
            proposal.public_id = $1
            AND support.status = 'ACTIVE'
            AND support.subject_key_hash IN (${candidates})
          FOR UPDATE OF support
          LIMIT 1
        `,
        [proposalPublicId, ...keys.subjectCandidateHashes],
      );
      const existing = result.rows[0];
      if (!existing) return false;

      if (
        existing.subject_key_hash !== keys.subjectKeyHash ||
        existing.subject_key_id !== keys.subjectKeyId
      ) {
        await transaction.query(
          `
            UPDATE supports
            SET subject_key_hash = $1, subject_key_id = $2
            WHERE id = $3
          `,
          [keys.subjectKeyHash, keys.subjectKeyId, existing.id],
        );
        if (existing.subject_key_id !== keys.subjectKeyId) {
          await transaction.query(
            `
              INSERT INTO participation_identity_migrations (
                support_id, from_key_id, to_key_id
              )
              VALUES ($1, $2, $3)
            `,
            [existing.id, existing.subject_key_id, keys.subjectKeyId],
          );
        }
      }
      return true;
    });
  }
}

export async function retryOnEventConcurrency<Result>(
  operation: () => Promise<Result>,
  options: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
  } = {},
): Promise<Result> {
  const maxAttempts = options.maxAttempts ?? MAX_CONCURRENCY_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof EventConcurrencyError)) throw error;
      if (attempt === maxAttempts) throw new ParticipationContentionError();
      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
      await delay(exponential + jitter);
    }
  }
  throw new ParticipationContentionError();
}
