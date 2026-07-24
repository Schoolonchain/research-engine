import { createHash } from "node:crypto";

import type { TransactionalDatabase } from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import { randomUUID } from "node:crypto";
import type { ScorePolicyConfig } from "./model.js";

const DIMENSIONS = ["PRIORITY", "PROGRESS", "CONFIDENCE", "SUPPORT_COUNT"] as const;
const FORMULAS = {
  PRIORITY: "support_log_50_accepted_evidence_50_v1",
  PROGRESS: "accepted_sources_claims_evidence_target_30_v1",
  CONFIDENCE: "accepted_evidence_contradiction_penalty_v1",
  SUPPORT_COUNT: "materialized_support_count_v1",
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function scorePolicyFingerprint(
  definition: unknown,
  eligibility: ScorePolicyConfig,
): string {
  return createHash("sha256")
    .update(canonical({ definition, eligibility }))
    .digest("hex");
}

export function validateScorePolicy(policy: ScorePolicyConfig): void {
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new Error("Score policy version must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.minimumSupports) || policy.minimumSupports < 0) {
    throw new Error("minimumSupports must be a non-negative integer");
  }
  for (const threshold of [
    policy.priorityThreshold,
    policy.progressThreshold,
    policy.confidenceThreshold,
  ]) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error("Score thresholds must be between 0 and 1");
    }
  }
}

export class ScorePolicyManager {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) {
    this.events = new EventStore(database);
  }

  public async activate(policy: ScorePolicyConfig): Promise<void> {
    validateScorePolicy(policy);
    await this.database.transaction(async (tx) => {
      for (const dimension of DIMENSIONS) {
        const definition = { formula: FORMULAS[dimension] };
        const fingerprint = scorePolicyFingerprint(definition, policy);
        const existing = await tx.query<{ definition_hash: string | null }>(
          "SELECT definition_hash FROM score_policies WHERE dimension = $1 AND version = $2",
          [dimension, policy.version],
        );
        if (existing.rows[0] && existing.rows[0].definition_hash !== fingerprint) {
          throw new Error(`Score policy ${dimension} v${policy.version} is immutable`);
        }
        if (!existing.rows[0]) {
          await tx.query(
            `INSERT INTO score_policies (
              dimension, version, name, definition, eligibility_definition,
              definition_hash, status
            ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,'DRAFT')`,
            [
              dimension, policy.version, `${dimension} v${policy.version}`,
              JSON.stringify(definition), JSON.stringify(policy), fingerprint,
            ],
          );
        }
      }
      const previous = await tx.query<{ version: number }>(
        "SELECT DISTINCT version FROM score_policies WHERE status = 'ACTIVE'",
      );
      await tx.query(
        "UPDATE score_policies SET status = 'RETIRED' WHERE status = 'ACTIVE'",
      );
      await tx.query(
        `UPDATE score_policies SET status = 'ACTIVE', activated_at = CURRENT_TIMESTAMP
         WHERE version = $1 AND dimension = ANY($2::text[])`,
        [policy.version, [...DIMENSIONS]],
      );
      const correlationId = randomUUID();
      await tx.query(
        `INSERT INTO score_policy_activations (
          policy_version, previous_policy_version, correlation_id
        ) VALUES ($1,$2,$3)`,
        [policy.version, previous.rows[0]?.version ?? null, correlationId],
      );
      await this.events.appendMany(tx, [{
        eventId: randomUUID(),
        eventType: "score_policy_activated",
        eventVersion: 1,
        aggregateType: "score_policy_activation",
        aggregateId: correlationId,
        expectedSequence: 0,
        actor: { type: "system" },
        correlationId,
        payload: {
          policyVersion: policy.version,
          previousPolicyVersion: previous.rows[0]?.version ?? null,
        },
      }]);
    });
  }
}
