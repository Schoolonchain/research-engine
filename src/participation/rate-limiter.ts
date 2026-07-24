import type { TransactionalDatabase } from "../db/database.js";
import { ParticipationRateLimitError } from "./errors.js";
import type {
  ParticipationKeys,
} from "./identity.js";
import type { ParticipationRatePolicy } from "./model.js";

interface CounterRow {
  readonly count: number;
}

interface ScopeLimit {
  readonly scope: "SUBJECT" | "NETWORK" | "GLOBAL";
  readonly keyHash: string;
  readonly limit: number;
}

function validatePolicy(policy: ParticipationRatePolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (policy.retentionSeconds < policy.windowSeconds) {
    throw new Error("retentionSeconds must cover at least one window");
  }
}

export class ParticipationRateLimiter {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly policy: ParticipationRatePolicy,
  ) {
    validatePolicy(policy);
  }

  public async consume(action: string, keys: ParticipationKeys): Promise<void> {
    const scopes: ScopeLimit[] = [
      {
        scope: "SUBJECT",
        keyHash: keys.rateSubjectKeyHash,
        limit: this.policy.subjectLimit,
      },
      {
        scope: "GLOBAL",
        keyHash: keys.globalKeyHash,
        limit: this.policy.globalLimit,
      },
    ];
    if (keys.networkKeyHash) {
      scopes.push({
        scope: "NETWORK",
        keyHash: keys.networkKeyHash,
        limit: this.policy.networkLimit,
      });
    }

    const blocked = await this.database.transaction(async (transaction) => {
      const exceeded: ScopeLimit[] = [];
      for (const scope of scopes) {
        const result = await transaction.query<CounterRow>(
          `
            INSERT INTO participation_rate_limits (
              action, scope, key_hash, policy_version, window_started_at,
              count, limit_snapshot, expires_at
            ) VALUES (
              $1, $2, $3, $4,
              to_timestamp(
                floor(extract(epoch FROM CURRENT_TIMESTAMP) / $5) * $5
              ),
              1, $6,
              CURRENT_TIMESTAMP + ($7 * INTERVAL '1 second')
            )
            ON CONFLICT (
              action, scope, key_hash, policy_version, window_started_at
            )
            DO UPDATE SET
              count = participation_rate_limits.count + 1,
              limit_snapshot = EXCLUDED.limit_snapshot,
              updated_at = CURRENT_TIMESTAMP
            RETURNING count
          `,
          [
            action,
            scope.scope,
            scope.keyHash,
            this.policy.version,
            this.policy.windowSeconds,
            scope.limit,
            this.policy.retentionSeconds,
          ],
        );
        if ((result.rows[0]?.count ?? 0) > scope.limit) exceeded.push(scope);
      }

      for (const scope of exceeded) {
        await transaction.query(
          `
            INSERT INTO abuse_signals (
              action, scope, key_hash, signal_type,
              risk_level, policy_version, expires_at
            ) VALUES (
              $1, $2, $3, 'RATE_LIMIT_EXCEEDED',
              'MEDIUM', $4,
              CURRENT_TIMESTAMP + ($5 * INTERVAL '1 second')
            )
          `,
          [
            action,
            scope.scope,
            scope.keyHash,
            this.policy.version,
            this.policy.retentionSeconds,
          ],
        );
      }
      return exceeded.length > 0;
    });

    if (blocked) {
      throw new ParticipationRateLimitError(this.policy.windowSeconds);
    }
  }
}
