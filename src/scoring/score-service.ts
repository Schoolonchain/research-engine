import { randomUUID } from "node:crypto";

import type { TransactionalDatabase } from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import type { ScoreDimension, ScorePolicyConfig, ScoreResult } from "./model.js";

interface InputsRow {
  readonly id: string;
  readonly public_id: string;
  readonly status: string;
  readonly version: number;
  readonly support_count: string;
  readonly sources: number;
  readonly claims: number;
  readonly evidence: number;
  readonly accepted_evidence: number;
  readonly contradicted_evidence: number;
}

const DEFAULT_POLICY: ScorePolicyConfig = Object.freeze({
  version: 1,
  priorityThreshold: 0.55,
  progressThreshold: 0.3,
  confidenceThreshold: 0.4,
  minimumSupports: 3,
});

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class ScoreService {
  private readonly events: EventStore;

  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly policy: ScorePolicyConfig = DEFAULT_POLICY,
  ) {
    this.events = new EventStore(database);
    const numeric = Object.values(policy);
    if (numeric.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error("Score policy values must be finite and non-negative");
    }
    if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
      throw new Error("Score policy version must be a positive integer");
    }
    for (const threshold of [
      policy.priorityThreshold,
      policy.progressThreshold,
      policy.confidenceThreshold,
    ]) {
      if (threshold > 1) throw new Error("Score thresholds cannot exceed 1");
    }
    if (!Number.isSafeInteger(policy.minimumSupports)) {
      throw new Error("minimumSupports must be an integer");
    }
  }

  public async recalculate(proposalPublicId: string): Promise<ScoreResult> {
    const runId = randomUUID();
    const scored = await this.events.transactPrepared(
      async (tx) => {
        const result = await tx.query<InputsRow>(
          `
            SELECT proposal.id, proposal.public_id, proposal.status, proposal.version,
              proposal.support_count,
              count(DISTINCT source.id)::int AS sources,
              count(DISTINCT claim.id)::int AS claims,
              count(DISTINCT evidence.id)::int AS evidence,
              count(DISTINCT evidence.id) FILTER (
                WHERE evidence.moderation_status = 'ACCEPTED'
              )::int AS accepted_evidence,
              count(DISTINCT evidence.id) FILTER (
                WHERE evidence.stance = 'CONTRADICTS'
                  AND evidence.moderation_status = 'ACCEPTED'
              )::int AS contradicted_evidence
            FROM proposals AS proposal
            LEFT JOIN sources AS source ON source.proposal_id = proposal.id
            LEFT JOIN claims AS claim ON claim.proposal_id = proposal.id
            LEFT JOIN evidence ON evidence.claim_id = claim.id
            WHERE proposal.public_id = $1 AND proposal.status <> 'DELETED'
            GROUP BY proposal.id
          `,
          [proposalPublicId],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Proposal not found");
        return {
          eventId: randomUUID(),
          eventType: "score_recalculated",
          eventVersion: 1,
          aggregateType: "score_run",
          aggregateId: runId,
          expectedSequence: 0,
          actor: { type: "system" },
          correlationId: randomUUID(),
          payload: { proposalId: row.public_id, policyVersion: this.policy.version },
          topic: "domain_events",
          row,
        };
      },
      async (tx, command) => {
        const row = (command as typeof command & { row: InputsRow }).row;
        const supportCount = Number(row.support_count);
        const evidenceQuality = row.evidence === 0
          ? 0
          : (row.accepted_evidence - row.contradicted_evidence * 0.5) / row.evidence;
        const dimensions: ScoreDimension[] = [
          {
            dimension: "PRIORITY",
            value: rounded(bounded(
              Math.log1p(supportCount) / Math.log1p(100) * 0.5 +
              Math.min(row.evidence, 20) / 20 * 0.5,
            )),
            policyVersion: this.policy.version,
            inputs: { supportCount, evidenceCount: row.evidence },
            explanation: "50% apoyo normalizado y 50% cobertura de evidencia (máximo 20).",
          },
          {
            dimension: "PROGRESS",
            value: rounded(bounded((row.sources + row.claims + row.evidence) / 30)),
            policyVersion: this.policy.version,
            inputs: { sources: row.sources, claims: row.claims, evidence: row.evidence },
            explanation: "Cobertura acumulada de Source, Claim y Evidence sobre objetivo 30.",
          },
          {
            dimension: "CONFIDENCE",
            value: rounded(bounded(evidenceQuality)),
            policyVersion: this.policy.version,
            inputs: {
              evidence: row.evidence,
              acceptedEvidence: row.accepted_evidence,
              acceptedContradictions: row.contradicted_evidence,
            },
            explanation: "Proporción aceptada con penalización explícita de contradicciones.",
          },
          {
            dimension: "SUPPORT_COUNT",
            value: supportCount,
            policyVersion: this.policy.version,
            inputs: { supportCount },
            explanation: "Conteo materializado independiente; no es una probabilidad.",
          },
        ];
        for (const dimension of dimensions) {
          const policy = await tx.query<{ id: string }>(
            `
              INSERT INTO score_policies (
                dimension, version, name, definition, eligibility_definition, status,
                activated_at
              ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'ACTIVE',CURRENT_TIMESTAMP)
              ON CONFLICT (dimension, version) DO UPDATE SET name = EXCLUDED.name
              RETURNING id
            `,
            [
              dimension.dimension, this.policy.version,
              `${dimension.dimension} v${this.policy.version}`,
              JSON.stringify({ formula: dimension.explanation }),
              JSON.stringify(this.policy),
            ],
          );
          await tx.query(
            `
              INSERT INTO scores (
                proposal_id, policy_id, dimension, value, inputs, explanation
              ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
              ON CONFLICT (proposal_id, dimension, policy_id)
              DO UPDATE SET value = EXCLUDED.value, inputs = EXCLUDED.inputs,
                explanation = EXCLUDED.explanation, calculated_at = CURRENT_TIMESTAMP
            `,
            [
              row.id, policy.rows[0]!.id, dimension.dimension, dimension.value,
              JSON.stringify(dimension.inputs), dimension.explanation,
            ],
          );
        }
        const byName = Object.fromEntries(dimensions.map((item) => [item.dimension, item.value]));
        const eligible =
          supportCount >= this.policy.minimumSupports &&
          (byName["PRIORITY"] ?? 0) >= this.policy.priorityThreshold &&
          (byName["PROGRESS"] ?? 0) >= this.policy.progressThreshold &&
          (byName["CONFIDENCE"] ?? 0) >= this.policy.confidenceThreshold;
        await tx.query(
          `UPDATE proposals SET priority_score = $1,
            priority_score_policy_version = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [byName["PRIORITY"], this.policy.version, row.id],
        );
        return { row, dimensions: Object.freeze(dimensions), eligible };
      },
    );

    let status = scored.result.row.status;
    if (
      scored.result.eligible &&
      ["OPEN", "COLLECTING", "THRESHOLD_REACHED"].includes(status)
    ) {
      const changed = await this.events.transactPrepared(
        async (tx) => {
          const current = await tx.query<{ id: string; version: number; status: string }>(
            "SELECT id, version, status FROM proposals WHERE public_id = $1 FOR UPDATE",
            [proposalPublicId],
          );
          const row = current.rows[0]!;
          return {
            eventId: randomUUID(), eventType: "proposal_became_eligible",
            eventVersion: 1, aggregateType: "proposal", aggregateId: row.id,
            expectedSequence: row.version, actor: { type: "system" },
            correlationId: randomUUID(),
            payload: { policyVersion: this.policy.version, executionStarted: false },
          };
        },
        async (tx) => {
          await tx.query(
            `UPDATE proposals SET status = 'ELIGIBLE', version = version + 1,
              updated_at = CURRENT_TIMESTAMP WHERE public_id = $1`,
            [proposalPublicId],
          );
          return "ELIGIBLE";
        },
      );
      status = changed.result;
    }
    return Object.freeze({
      proposalPublicId,
      dimensions: scored.result.dimensions,
      eligible: scored.result.eligible,
      proposalStatus: status,
    });
  }
}
