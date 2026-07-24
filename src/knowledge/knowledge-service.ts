import { randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeValidationError,
} from "./errors.js";
import type {
  AddClaimInput,
  AddEvidenceInput,
  AddUrlSourceInput,
  Claim,
  ClaimClassification,
  Evidence,
  EvidenceStance,
  KnowledgeActor,
  Source,
} from "./model.js";
import { canonicalizeSourceUrl } from "./url-policy.js";

interface ProposalRow {
  readonly id: string;
  readonly public_id: string;
  readonly status: string;
}
interface SourceRow {
  readonly id: string;
  readonly public_id: string;
  readonly proposal_id: string;
  readonly proposal_public_id: string;
  readonly original_url: string;
  readonly canonical_url: string;
  readonly title: string | null;
  readonly fetch_status: string;
  readonly version: number;
}
interface ClaimRow {
  readonly id: string;
  readonly public_id: string;
  readonly proposal_id: string;
  readonly proposal_public_id: string;
  readonly source_public_id: string | null;
  readonly statement: string;
  readonly classification: ClaimClassification;
  readonly context: string | null;
  readonly version: number;
}
interface EvidenceRow {
  readonly public_id: string;
  readonly claim_public_id: string;
  readonly source_public_id: string;
  readonly stance: EvidenceStance;
  readonly locator: string | null;
  readonly excerpt: string | null;
  readonly context: string | null;
  readonly version: number;
}

const CONTRIBUTABLE = new Set(["OPEN", "COLLECTING"]);
const CLASSIFICATIONS = new Set<ClaimClassification>([
  "FACT",
  "CLAIM",
  "INFERENCE",
  "UNCERTAINTY",
]);
const STANCES = new Set<EvidenceStance>([
  "SUPPORTS",
  "CONTRADICTS",
  "CONTEXTUALIZES",
  "UNKNOWN",
]);

function text(value: unknown, label: string, max: number, optional = false): string | null {
  if (value === undefined && optional) return null;
  if (typeof value !== "string") throw new KnowledgeValidationError(`${label} must be text`);
  const normalized = value.trim();
  if ((!optional && normalized.length === 0) || normalized.length > max) {
    throw new KnowledgeValidationError(`${label} has invalid length`);
  }
  return normalized || null;
}

async function proposalForContribution(
  tx: DatabaseExecutor,
  publicId: string,
): Promise<ProposalRow> {
  const result = await tx.query<ProposalRow>(
    "SELECT id, public_id, status FROM proposals WHERE public_id = $1 AND status <> 'DELETED'",
    [publicId],
  );
  const row = result.rows[0];
  if (!row) throw new KnowledgeNotFoundError("Proposal not found");
  if (!CONTRIBUTABLE.has(row.status)) {
    throw new KnowledgeConflictError("Proposal does not accept contributions");
  }
  return row;
}

function command(
  id: string,
  actor: KnowledgeActor,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): AppendEventCommand {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    aggregateType: eventType.split("_")[0] ?? "knowledge",
    aggregateId: id,
    expectedSequence: 0,
    actor: { type: actor.role.toLowerCase(), id: actor.actorId },
    correlationId: randomUUID(),
    payload,
  };
}

function source(row: SourceRow): Source {
  return Object.freeze({
    publicId: row.public_id,
    proposalPublicId: row.proposal_public_id,
    kind: "URL",
    originalUrl: row.original_url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    fetchStatus: row.fetch_status,
    version: row.version,
  });
}

function claim(row: ClaimRow): Claim {
  return Object.freeze({
    publicId: row.public_id,
    proposalPublicId: row.proposal_public_id,
    sourcePublicId: row.source_public_id,
    statement: row.statement,
    classification: row.classification,
    context: row.context,
    version: row.version,
  });
}

function evidence(row: EvidenceRow): Evidence {
  return Object.freeze({
    publicId: row.public_id,
    claimPublicId: row.claim_public_id,
    sourcePublicId: row.source_public_id,
    stance: row.stance,
    locator: row.locator,
    excerpt: row.excerpt,
    context: row.context,
    version: row.version,
  });
}

export class KnowledgeService {
  private readonly events: EventStore;
  public constructor(private readonly database: TransactionalDatabase) {
    this.events = new EventStore(database);
  }

  public async addUrlSource(
    actor: KnowledgeActor,
    proposalPublicId: string,
    input: AddUrlSourceInput,
  ): Promise<Source> {
    const originalUrl = text(input.url, "url", 4096) as string;
    const canonicalUrl = canonicalizeSourceUrl(originalUrl);
    const title = text(input.title, "title", 1000, true);
    const id = randomUUID();
    const publicId = randomUUID();
    const result = await this.events.transactPrepared(
      async (tx) => {
        const proposal = await proposalForContribution(tx, proposalPublicId);
        const duplicate = await tx.query<{ id: string }>(
          "SELECT id FROM sources WHERE proposal_id = $1 AND canonical_url = $2",
          [proposal.id, canonicalUrl],
        );
        if (duplicate.rows[0]) throw new KnowledgeConflictError("Source already exists");
        return command(id, actor, "source_added", {
          proposalId: proposal.public_id,
          kind: "URL",
          canonicalized: canonicalUrl !== originalUrl,
        });
      },
      async (tx, event) => {
        const inserted = await tx.query<SourceRow>(
          `
            INSERT INTO sources (
              id, public_id, proposal_id, contributed_by_actor_id,
              kind, original_url, canonical_url, title
            )
            SELECT $1, $2, id, $3, 'URL', $4, $5, $6
            FROM proposals WHERE public_id = $7
            RETURNING *, $7::uuid AS proposal_public_id
          `,
          [id, publicId, actor.actorId, originalUrl, canonicalUrl, title, event.payload["proposalId"]],
        );
        const row = inserted.rows[0];
        if (!row) throw new KnowledgeNotFoundError("Proposal not found");
        return source(row);
      },
    );
    return result.result;
  }

  public async addClaim(
    actor: KnowledgeActor,
    proposalPublicId: string,
    input: AddClaimInput,
  ): Promise<Claim> {
    const statement = text(input.statement, "statement", 10_000) as string;
    const context = text(input.context, "context", 20_000, true);
    const classification = input.classification ?? "CLAIM";
    if (!CLASSIFICATIONS.has(classification)) {
      throw new KnowledgeValidationError("Invalid claim classification");
    }
    const id = randomUUID();
    const publicId = randomUUID();
    const result = await this.events.transactPrepared(
      async (tx) => {
        const proposal = await proposalForContribution(tx, proposalPublicId);
        let sourceId: string | null = null;
        if (input.sourcePublicId) {
          const found = await tx.query<{ id: string }>(
            "SELECT id FROM sources WHERE public_id = $1 AND proposal_id = $2",
            [input.sourcePublicId, proposal.id],
          );
          sourceId = found.rows[0]?.id ?? null;
          if (!sourceId) throw new KnowledgeNotFoundError("Source not found");
        }
        return command(id, actor, "claim_added", {
          proposalId: proposal.public_id,
          sourceLinked: sourceId !== null,
          classification,
          sourceId,
        });
      },
      async (tx, event) => {
        const inserted = await tx.query<ClaimRow>(
          `
            INSERT INTO claims (
              id, public_id, proposal_id, source_id, created_by_actor_id,
              statement, classification, context
            )
            SELECT $1, $2, id, $3, $4, $5, $6, $7
            FROM proposals WHERE public_id = $8
            RETURNING *,
              $8::uuid AS proposal_public_id,
              $9::uuid AS source_public_id
          `,
          [
            id, publicId, event.payload["sourceId"], actor.actorId,
            statement, classification, context, proposalPublicId,
            input.sourcePublicId ?? null,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new KnowledgeNotFoundError("Proposal not found");
        return claim(row);
      },
    );
    return result.result;
  }

  public async addEvidence(
    actor: KnowledgeActor,
    claimPublicId: string,
    input: AddEvidenceInput,
  ): Promise<Evidence> {
    if (!STANCES.has(input.stance)) throw new KnowledgeValidationError("Invalid evidence stance");
    const locator = text(input.locator, "locator", 2000, true);
    const excerpt = text(input.excerpt, "excerpt", 20_000, true);
    const context = text(input.context, "context", 20_000, true);
    const id = randomUUID();
    const publicId = randomUUID();
    const result = await this.events.transactPrepared(
      async (tx) => {
        const relation = await tx.query<{
          claim_id: string; source_id: string; proposal_id: string;
        }>(
          `
            SELECT claim.id AS claim_id, source.id AS source_id, claim.proposal_id
            FROM claims AS claim
            JOIN sources AS source ON source.public_id = $2
            JOIN proposals AS proposal ON proposal.id = claim.proposal_id
            WHERE claim.public_id = $1
              AND source.proposal_id = claim.proposal_id
              AND proposal.status IN ('OPEN', 'COLLECTING')
          `,
          [claimPublicId, input.sourcePublicId],
        );
        const row = relation.rows[0];
        if (!row) throw new KnowledgeNotFoundError("Claim/source relation not found");
        return command(id, actor, "evidence_added", {
          claimId: row.claim_id,
          sourceId: row.source_id,
          stance: input.stance,
        });
      },
      async (tx, event) => {
        const duplicate = await tx.query<{ id: string }>(
          `
            SELECT id FROM evidence
            WHERE claim_id = $1 AND source_id = $2 AND stance = $3
              AND locator IS NOT DISTINCT FROM $4
          `,
          [event.payload["claimId"], event.payload["sourceId"], input.stance, locator],
        );
        if (duplicate.rows[0]) throw new KnowledgeConflictError("Evidence already exists");
        const inserted = await tx.query<EvidenceRow>(
          `
            INSERT INTO evidence (
              id, public_id, claim_id, source_id, contributed_by_actor_id,
              stance, locator, excerpt, context
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING *,
              $10::uuid AS claim_public_id,
              $11::uuid AS source_public_id
          `,
          [
            id, publicId, event.payload["claimId"], event.payload["sourceId"],
            actor.actorId, input.stance, locator, excerpt, context,
            claimPublicId, input.sourcePublicId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Evidence insert returned no row");
        return evidence(row);
      },
    );
    return result.result;
  }
}
