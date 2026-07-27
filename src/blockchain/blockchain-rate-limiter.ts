import { createHash } from "node:crypto";

import type { TransactionalDatabase } from "../db/database.js";
import { BlockchainRateLimitError } from "./errors.js";

export type BlockchainAction = "block_collect";
export interface BlockchainRatePolicy {
  readonly version: number;
  readonly windowSeconds: number;
  readonly retentionSeconds: number;
  readonly actorLimits: Readonly<Record<BlockchainAction, number>>;
  readonly globalLimit: number;
}

export const DEFAULT_BLOCKCHAIN_RATE_POLICY: BlockchainRatePolicy = Object.freeze({
  version: 1,
  windowSeconds: 60,
  retentionSeconds: 600,
  actorLimits: Object.freeze({ block_collect: 30 }),
  globalLimit: 500,
});

interface CounterRow {
  readonly count: number;
  readonly retry_after_seconds: number;
}

export class BlockchainRateLimiter {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly policy = DEFAULT_BLOCKCHAIN_RATE_POLICY,
  ) {
    const requiredActions = ["block_collect"];
    const configuredActions = Object.keys(policy.actorLimits).sort();
    if (
      configuredActions.length !== requiredActions.length ||
      configuredActions.some((action, index) => action !== requiredActions[index])
    ) {
      throw new Error(
        "Blockchain rate policy must define exactly block_collect",
      );
    }
    const values = [
      policy.version,
      policy.windowSeconds,
      policy.retentionSeconds,
      policy.globalLimit,
      ...Object.values(policy.actorLimits),
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("Blockchain rate policy values must be positive integers");
    }
    if (policy.retentionSeconds < policy.windowSeconds) {
      throw new Error("Blockchain rate retention must cover the window");
    }
  }

  public async consume(action: BlockchainAction, actorId: string): Promise<void> {
    const actorHash = createHash("sha256").update(`blockchain:actor:${actorId}`).digest("hex");
    const globalHash = createHash("sha256").update("blockchain:global").digest("hex");
    await this.database.transaction(async (tx) => {
      await tx.query(
        `
          DELETE FROM blockchain_rate_limits
          WHERE ctid IN (
            SELECT ctid FROM blockchain_rate_limits
            WHERE expires_at < CURRENT_TIMESTAMP
            ORDER BY expires_at
            LIMIT 1000
          )
        `,
      );
      for (const [scope, key, limit] of [
        ["ACTOR", actorHash, this.policy.actorLimits[action]],
        ["GLOBAL", globalHash, this.policy.globalLimit],
      ] as const) {
        const result = await tx.query<CounterRow>(
          `WITH timing AS (
            SELECT to_timestamp(
              floor(extract(epoch FROM CURRENT_TIMESTAMP) / $5) * $5
            ) AS window_started_at
          )
            INSERT INTO blockchain_rate_limits (
              action, scope, key_hash, policy_version, window_started_at,
              count, limit_snapshot, expires_at
            )
            SELECT $1,$2,$3,$4,timing.window_started_at,1,$6,
              timing.window_started_at + ($7 * interval '1 second')
            FROM timing
            ON CONFLICT (action, scope, key_hash, policy_version, window_started_at)
            DO UPDATE SET count = blockchain_rate_limits.count + 1
            RETURNING count, GREATEST(
              1,
              ceil(extract(epoch FROM (
                window_started_at + ($5 * interval '1 second') - CURRENT_TIMESTAMP
              )))::int
            ) AS retry_after_seconds
          `,
          [
            action, scope, key, this.policy.version,
            this.policy.windowSeconds, limit, this.policy.retentionSeconds,
          ],
        );
        const row = result.rows[0];
        if (row && row.count > limit) {
          throw new BlockchainRateLimitError(row.retry_after_seconds);
        }
      }
    });
  }
}
