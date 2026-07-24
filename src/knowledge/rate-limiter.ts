import { createHash } from "node:crypto";

import type { TransactionalDatabase } from "../db/database.js";
import { KnowledgeRateLimitError } from "./errors.js";

export type KnowledgeAction = "source_add" | "claim_add" | "evidence_add";
export interface KnowledgeRatePolicy {
  readonly version: number;
  readonly windowSeconds: number;
  readonly retentionSeconds: number;
  readonly actorLimits: Readonly<Record<KnowledgeAction, number>>;
  readonly globalLimit: number;
}

export const DEFAULT_KNOWLEDGE_RATE_POLICY: KnowledgeRatePolicy = Object.freeze({
  version: 1,
  windowSeconds: 60,
  retentionSeconds: 600,
  actorLimits: Object.freeze({ source_add: 20, claim_add: 60, evidence_add: 120 }),
  globalLimit: 1_000,
});

interface CounterRow {
  readonly count: number;
  readonly retry_after_seconds: number;
}

export class KnowledgeRateLimiter {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly policy = DEFAULT_KNOWLEDGE_RATE_POLICY,
  ) {
    const requiredActions = ["claim_add", "evidence_add", "source_add"];
    const configuredActions = Object.keys(policy.actorLimits).sort();
    if (
      configuredActions.length !== requiredActions.length ||
      configuredActions.some((action, index) => action !== requiredActions[index])
    ) {
      throw new Error(
        "Knowledge rate policy must define exactly source_add, claim_add and evidence_add",
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
      throw new Error("Knowledge rate policy values must be positive integers");
    }
    if (policy.retentionSeconds < policy.windowSeconds) {
      throw new Error("Knowledge rate retention must cover the window");
    }
  }

  public async consume(action: KnowledgeAction, actorId: string): Promise<void> {
    const actorHash = createHash("sha256").update(`knowledge:actor:${actorId}`).digest("hex");
    const globalHash = createHash("sha256").update("knowledge:global").digest("hex");
    await this.database.transaction(async (tx) => {
      await tx.query(
        `
          DELETE FROM knowledge_rate_limits
          WHERE ctid IN (
            SELECT ctid FROM knowledge_rate_limits
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
            INSERT INTO knowledge_rate_limits (
              action, scope, key_hash, policy_version, window_started_at,
              count, limit_snapshot, expires_at
            )
            SELECT $1,$2,$3,$4,timing.window_started_at,1,$6,
              timing.window_started_at + ($7 * interval '1 second')
            FROM timing
            ON CONFLICT (action, scope, key_hash, policy_version, window_started_at)
            DO UPDATE SET count = knowledge_rate_limits.count + 1
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
          throw new KnowledgeRateLimitError(row.retry_after_seconds);
        }
      }
    });
  }
}
