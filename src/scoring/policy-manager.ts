import { createHash } from "node:crypto";

import type { TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import { randomUUID } from "node:crypto";
import type { AdministrativeContext } from "../admin/model.js";
import {
  AdministrativeConflictError,
  AdministrativeValidationError,
} from "../admin/errors.js";
import { assertAdministrativeAuthority } from "../admin/authority.js";
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

export function scorePolicySetFingerprint(
  fingerprints: readonly Readonly<{ dimension: string; fingerprint: string }>[],
): string {
  return createHash("sha256")
    .update(canonical([...fingerprints].sort((left, right) =>
      left.dimension.localeCompare(right.dimension))))
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

  public async activate(
    authority: AdministrativeContext,
    policy: ScorePolicyConfig,
    mutationKey: string,
  ): Promise<void> {
    validateScorePolicy(policy);
    const key = mutationKey.trim().normalize("NFC");
    if (key.length < 8 || key.length > 200) {
      throw new AdministrativeValidationError("Invalid idempotency key");
    }
    const activationRequestHash = createHash("sha256")
      .update(canonical(policy)).digest("hex");
    await this.database.transaction(async (tx) => {
      await assertAdministrativeAuthority(tx, authority, ["POLICY_ADMIN"], true);
      const existingReceipt = await tx.query<{ request_hash: string }>(
        `SELECT request_hash FROM administrative_mutation_receipts
         WHERE identity_id = $1 AND operation = 'activate_score_policy'
           AND idempotency_key = $2`,
        [authority.identityId, key],
      );
      if (existingReceipt.rows[0]) {
        if (existingReceipt.rows[0].request_hash !== activationRequestHash) {
          throw new AdministrativeConflictError(
            "Idempotency key was used for another policy",
          );
        }
        return;
      }
      await tx.query(
        "SELECT name FROM administrative_locks WHERE name = 'policy_activation' FOR UPDATE",
      );
      const fingerprints: Array<{ dimension: string; fingerprint: string }> = [];
      for (const dimension of DIMENSIONS) {
        const definition = { formula: FORMULAS[dimension] };
        const fingerprint = scorePolicyFingerprint(definition, policy);
        fingerprints.push({ dimension, fingerprint });
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
      const policySetHash = scorePolicySetFingerprint(fingerprints);
      const previous = await tx.query<{ version: number }>(
        `SELECT DISTINCT version FROM score_policies WHERE status = 'ACTIVE'
         ORDER BY version`,
      );
      if (previous.rows.length > 1) {
        throw new Error("Active score policy versions are inconsistent");
      }
      if (previous.rows[0]?.version === policy.version) {
        throw new AdministrativeConflictError("Score policy version is already active");
      }
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
          policy_version, previous_policy_version, correlation_id, policy_set_hash
        ) VALUES ($1,$2,$3,$4)`,
        [policy.version, previous.rows[0]?.version ?? null, correlationId, policySetHash],
      );
      const invalidated = await tx.query<{ id: string; version: number }>(
        "SELECT id, version FROM proposals WHERE status = 'ELIGIBLE' FOR UPDATE",
      );
      await tx.query(
        `UPDATE proposals SET status = 'COLLECTING', version = version + 1,
          eligibility_score_run_id = NULL,
          eligibility_policy_set_hash = NULL,
          eligibility_knowledge_revision = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE status = 'ELIGIBLE'`,
      );
      await tx.query(
        `INSERT INTO administrative_action_audit (
          actor_id, session_id, action, target_type, target_id,
          correlation_id, details
        ) VALUES ($1,$2,'score_policy_activated','SCORE_POLICY_ACTIVATION',
          $3,$3,$4::jsonb)`,
        [authority.actorId, authority.sessionId, correlationId,
          JSON.stringify({
            policyVersion: policy.version,
            previousPolicyVersion: previous.rows[0]?.version ?? null,
            policySetHash,
          })],
      );
      await tx.query(
        `INSERT INTO administrative_mutation_receipts (
          identity_id, operation, idempotency_key, request_hash, correlation_id
        ) VALUES ($1,'activate_score_policy',$2,$3,$4)`,
        [authority.identityId, key, activationRequestHash, correlationId],
      );
      const commands: AppendEventCommand[] = [{
        eventId: randomUUID(),
        eventType: "score_policy_activated",
        eventVersion: 1,
        aggregateType: "score_policy_activation",
        aggregateId: correlationId,
        expectedSequence: 0,
        actor: { type: "policy_admin", id: authority.actorId },
        correlationId,
        payload: {
          policyVersion: policy.version,
          previousPolicyVersion: previous.rows[0]?.version ?? null,
          policySetHash,
        },
      }];
      for (const proposal of invalidated.rows) {
        commands.push({
          eventId: randomUUID(),
          eventType: "eligibility_snapshot_invalidated",
          eventVersion: 1,
          aggregateType: "proposal",
          aggregateId: proposal.id,
          expectedSequence: proposal.version,
          actor: { type: "policy_admin", id: authority.actorId },
          correlationId,
          payload: {
            cause: "score_policy_activated",
            policyVersion: policy.version,
            policySetHash,
            executionStarted: false,
          },
        });
      }
      await this.events.appendMany(tx, commands);
    });
  }
}
