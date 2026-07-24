import { randomUUID } from "node:crypto";

import type { AppendEventCommand } from "../events/event-store.js";
import { EventStore } from "../events/event-store.js";
import type { TransactionalDatabase } from "../db/database.js";
import type { ScoreDimension, ScorePolicyConfig, ScoreResult } from "./model.js";
import { scorePolicyFingerprint, validateScorePolicy } from "./policy-manager.js";

interface ActivePolicyRow {
  readonly dimension: ScoreDimension["dimension"];
  readonly version: number;
  readonly eligibility_definition: ScorePolicyConfig;
  readonly definition_hash: string;
  readonly definition: Readonly<Record<string, unknown>>;
}
interface InputsRow {
  readonly id: string;
  readonly public_id: string;
  readonly status: string;
  readonly version: number;
  readonly support_count: string;
  readonly sources: number;
  readonly claims: number;
  readonly evidence: number;
  readonly contradictions: number;
}
interface CountsRow {
  readonly sources: number;
  readonly claims: number;
  readonly evidence: number;
  readonly contradictions: number;
}

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
function event(
  type: string,
  aggregateType: string,
  aggregateId: string,
  sequence: number,
  runId: string,
  policyVersion: number,
): AppendEventCommand {
  return {
    eventId: randomUUID(), eventType: type, eventVersion: 1,
    aggregateType, aggregateId, expectedSequence: sequence,
    actor: { type: "system" }, correlationId: runId,
    payload: { scoreRunId: runId, policyVersion, executionStarted: false },
  };
}

export class ScoreService {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) {
    this.events = new EventStore(database);
  }

  public async recalculate(proposalPublicId: string): Promise<ScoreResult> {
    const runId = randomUUID();
    return this.database.transaction(async (outer) => {
      const policies = await outer.query<ActivePolicyRow>(
        `SELECT dimension, version, definition, eligibility_definition, definition_hash
         FROM score_policies WHERE status = 'ACTIVE' ORDER BY dimension`,
      );
      if (policies.rows.length !== 4) throw new Error("Exactly four active score policies are required");
      const versions = new Set(policies.rows.map((row) => row.version));
      if (versions.size !== 1) throw new Error("Active score policy versions are inconsistent");
      const policy = policies.rows[0]!.eligibility_definition;
      validateScorePolicy(policy);
      if (policies.rows.some((row) =>
        JSON.stringify(row.eligibility_definition) !== JSON.stringify(policy))) {
        throw new Error("Active eligibility definitions are inconsistent");
      }
      for (const active of policies.rows) {
        if (
          scorePolicyFingerprint(active.definition, active.eligibility_definition) !==
          active.definition_hash
        ) {
          throw new Error(`Score policy ${active.dimension} fingerprint mismatch`);
        }
      }

      const proposalResult = await outer.query<Omit<InputsRow, keyof CountsRow>>(
        `SELECT id, public_id, status, version, support_count
         FROM proposals WHERE public_id = $1 AND status <> 'DELETED' FOR UPDATE`,
        [proposalPublicId],
      );
      const proposal = proposalResult.rows[0];
      if (!proposal) throw new Error("Proposal not found");
      const countResult = await outer.query<CountsRow>(
        `
          SELECT count(DISTINCT source.id) FILTER (
              WHERE source.moderation_status = 'ACCEPTED'
            )::int AS sources,
            count(DISTINCT claim.id) FILTER (
              WHERE claim.moderation_status = 'ACCEPTED'
                AND (
                  claim.source_id IS NULL OR EXISTS (
                    SELECT 1 FROM sources AS claim_source
                    WHERE claim_source.id = claim.source_id
                      AND claim_source.moderation_status = 'ACCEPTED'
                  )
                )
            )::int AS claims,
            count(DISTINCT evidence.id) FILTER (
              WHERE evidence.moderation_status = 'ACCEPTED'
                AND claim.moderation_status = 'ACCEPTED'
                AND EXISTS (
                  SELECT 1 FROM sources AS evidence_source
                  WHERE evidence_source.id = evidence.source_id
                    AND evidence_source.moderation_status = 'ACCEPTED'
                )
            )::int AS evidence,
            count(DISTINCT evidence.id) FILTER (
              WHERE evidence.moderation_status = 'ACCEPTED'
                AND evidence.stance = 'CONTRADICTS'
                AND claim.moderation_status = 'ACCEPTED'
                AND EXISTS (
                  SELECT 1 FROM sources AS evidence_source
                  WHERE evidence_source.id = evidence.source_id
                    AND evidence_source.moderation_status = 'ACCEPTED'
                )
            )::int AS contradictions
          FROM proposals AS proposal
          LEFT JOIN sources AS source ON source.proposal_id = proposal.id
          LEFT JOIN claims AS claim ON claim.proposal_id = proposal.id
          LEFT JOIN evidence ON evidence.claim_id = claim.id
          WHERE proposal.id = $1
        `,
        [proposal.id],
      );
      const row: InputsRow = { ...proposal, ...countResult.rows[0]! };
      const supportsBig = BigInt(row.support_count);
      if (supportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Support count exceeds safe scoring range");
      }
      const supports = Number(supportsBig);
      const confidence = row.evidence === 0
        ? 0
        : (row.evidence - row.contradictions * 0.5) / row.evidence;
      const dimensions: ScoreDimension[] = [
        {
          dimension: "PRIORITY",
          value: rounded(bounded(
            Math.log1p(supports) / Math.log1p(100) * 0.5 +
            Math.min(row.evidence, 20) / 20 * 0.5,
          )),
          policyVersion: policy.version,
          inputs: { supportCount: supports, acceptedEvidence: row.evidence },
          explanation: "50% apoyo normalizado y 50% Evidence moderada ACCEPTED.",
        },
        {
          dimension: "PROGRESS",
          value: rounded(bounded((row.sources + row.claims + row.evidence) / 30)),
          policyVersion: policy.version,
          inputs: { acceptedSources: row.sources, acceptedClaims: row.claims, acceptedEvidence: row.evidence },
          explanation: "Cobertura de aportaciones moderadas ACCEPTED sobre objetivo 30.",
        },
        {
          dimension: "CONFIDENCE",
          value: rounded(bounded(confidence)),
          policyVersion: policy.version,
          inputs: { acceptedEvidence: row.evidence, acceptedContradictions: row.contradictions },
          explanation: "Evidence ACCEPTED con penalización explícita de contradicciones.",
        },
        {
          dimension: "SUPPORT_COUNT", value: supports, policyVersion: policy.version,
          inputs: { supportCount: supports },
          explanation: "Conteo materializado independiente.",
        },
      ];
      const values = Object.fromEntries(dimensions.map((item) => [item.dimension, item.value]));
      const eligible =
        supports >= policy.minimumSupports &&
        values["PRIORITY"]! >= policy.priorityThreshold &&
        values["PROGRESS"]! >= policy.progressThreshold &&
        values["CONFIDENCE"]! >= policy.confidenceThreshold;

      const transition =
        eligible && ["OPEN", "COLLECTING"].includes(row.status)
          ? "gain"
          : !eligible && row.status === "ELIGIBLE"
            ? "loss"
            : "none";
      const commands: AppendEventCommand[] = [
        event("score_recalculated", "score_run", runId, 0, runId, policy.version),
      ];
      let nextStatus = row.status;
      let versionDelta = 0;
      if (transition === "gain") {
        commands.push(event("threshold_reached", "proposal", row.id, row.version, runId, policy.version));
        commands.push(event("proposal_became_eligible", "proposal", row.id, row.version + 1, runId, policy.version));
        nextStatus = "ELIGIBLE";
        versionDelta = 2;
      } else if (transition === "loss") {
        commands.push(event("threshold_lost", "proposal", row.id, row.version, runId, policy.version));
        nextStatus = "COLLECTING";
        versionDelta = 1;
      }

      await outer.query(
          `INSERT INTO score_runs (
            id, proposal_id, policy_version, inputs, dimensions, eligible
          ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
          [
            runId, row.id, policy.version,
            JSON.stringify({
              supportCount: supports, acceptedSources: row.sources,
              acceptedClaims: row.claims, acceptedEvidence: row.evidence,
              acceptedContradictions: row.contradictions,
            }),
            JSON.stringify(Object.fromEntries(dimensions.map((item) => [item.dimension, item.value]))),
            eligible,
          ],
          );
      for (const dimension of dimensions) {
          const policyRow = policies.rows.find((item) => item.dimension === dimension.dimension)!;
          const policyId = await outer.query<{ id: string }>(
            "SELECT id FROM score_policies WHERE dimension = $1 AND version = $2",
            [dimension.dimension, policy.version],
          );
          await outer.query(
            `INSERT INTO scores (
              proposal_id, policy_id, score_run_id, dimension, value, inputs, explanation
            ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
            [
              row.id, policyId.rows[0]!.id, runId, policyRow.dimension,
              dimension.value, JSON.stringify(dimension.inputs), dimension.explanation,
            ],
          );
        }
        const updated = await outer.query(
          `UPDATE proposals SET status = $1, version = version + $2,
            priority_score = $3, priority_score_policy_version = $4,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND version = $6 AND status = $7`,
          [nextStatus, versionDelta, values["PRIORITY"], policy.version, row.id, row.version, row.status],
        );
      if (updated.rowCount !== 1) throw new Error("Proposal changed during scoring");
      await this.events.appendMany(outer, commands);
      return Object.freeze({
        proposalPublicId, dimensions: Object.freeze(dimensions), eligible,
        proposalStatus: nextStatus,
      });
    });
  }
}
