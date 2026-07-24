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
  readonly expires_at: Date;
}

export class KnowledgeRateLimiter {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly policy = DEFAULT_KNOWLEDGE_RATE_POLICY,
  ) {}

  public async consume(action: KnowledgeAction, actorId: string): Promise<void> {
    const actorHash = createHash("sha256").update(`knowledge:actor:${actorId}`).digest("hex");
    const globalHash = createHash("sha256").update("knowledge:global").digest("hex");
    const windowMs = this.policy.windowSeconds * 1000;
    const started = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const expires = new Date(started.getTime() + this.policy.retentionSeconds * 1000);
    await this.database.transaction(async (tx) => {
      for (const [scope, key, limit] of [
        ["ACTOR", actorHash, this.policy.actorLimits[action]],
        ["GLOBAL", globalHash, this.policy.globalLimit],
      ] as const) {
        const result = await tx.query<CounterRow>(
          `
            INSERT INTO knowledge_rate_limits (
              action, scope, key_hash, policy_version, window_started_at,
              count, limit_snapshot, expires_at
            ) VALUES ($1,$2,$3,$4,$5,1,$6,$7)
            ON CONFLICT (action, scope, key_hash, policy_version, window_started_at)
            DO UPDATE SET count = knowledge_rate_limits.count + 1
            RETURNING count, expires_at
          `,
          [action, scope, key, this.policy.version, started, limit, expires],
        );
        const row = result.rows[0];
        if (row && row.count > limit) {
          const retry = Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000));
          throw new KnowledgeRateLimitError(retry);
        }
      }
    });
  }
}
