import { randomUUID } from "node:crypto";

import type {
  DatabaseExecutor,
  TransactionalDatabase,
} from "../db/database.js";
import { EventStore } from "../events/event-store.js";
import {
  ProposalConflictError,
  ProposalForbiddenError,
  ProposalNotFoundError,
  ProposalValidationError,
} from "./errors.js";
import type {
  ActorContext,
  CreateProposalInput,
  Proposal,
  ProposalVisibility,
  TransitionProposalInput,
  UpdateProposalInput,
} from "./model.js";
import {
  expectedVersion,
  validateCreateProposal,
  validateReason,
  validateUpdateProposal,
} from "./validation.js";

interface ProposalRow {
  readonly id: string;
  readonly public_id: string;
  readonly author_actor_id: string | null;
  readonly title: string;
  readonly central_question: string;
  readonly description: string;
  readonly status: string;
  readonly visibility: ProposalVisibility;
  readonly status_reason: string | null;
  readonly support_count: string;
  readonly opened_at: Date | null;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: number;
}

interface CountRow {
  readonly count: string;
}

const EDITABLE_STATUSES = new Set(["CREATED", "OPEN", "COLLECTING"]);
const PRIVILEGED_ROLES = new Set(["MODERATOR", "ADMIN"]);

function proposal(row: ProposalRow): Proposal {
  return Object.freeze({
    publicId: row.public_id,
    authorActorId: row.author_actor_id,
    title: row.title,
    centralQuestion: row.central_question,
    description: row.description,
    status: row.status,
    visibility: row.visibility,
    statusReason: row.status_reason,
    supportCount: Number(row.support_count),
    openedAt: row.opened_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function canManage(actor: ActorContext, row: ProposalRow): boolean {
  return (
    row.author_actor_id === actor.actorId || PRIVILEGED_ROLES.has(actor.role)
  );
}

function requireManage(actor: ActorContext, row: ProposalRow): void {
  if (!canManage(actor, row)) throw new ProposalForbiddenError();
}

async function selectInternal(
  transaction: DatabaseExecutor,
  publicId: string,
): Promise<ProposalRow> {
  const result = await transaction.query<ProposalRow>(
    "SELECT * FROM proposals WHERE public_id = $1",
    [publicId],
  );
  const row = result.rows[0];
  if (!row || row.status === "DELETED") throw new ProposalNotFoundError();
  return row;
}

function eventCommand(
  row: ProposalRow,
  actor: ActorContext,
  expectedSequence: number,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    aggregateType: "proposal",
    aggregateId: row.id,
    expectedSequence,
    actor: { type: actor.role.toLowerCase(), id: actor.actorId },
    correlationId: randomUUID(),
    payload,
  } as const;
}

export class ProposalService {
  private readonly events: EventStore;

  public constructor(private readonly database: TransactionalDatabase) {
    this.events = new EventStore(database);
  }

  public async create(
    actor: ActorContext,
    input: CreateProposalInput,
  ): Promise<Proposal> {
    const validated = validateCreateProposal(input);
    const id = randomUUID();
    const publicId = randomUUID();
    const syntheticRow = {
      id,
      public_id: publicId,
      author_actor_id: actor.actorId,
    } as ProposalRow;

    const result = await this.events.transact(
      eventCommand(syntheticRow, actor, 0, "proposal_created", {
        status: "CREATED",
        visibility: validated.visibility,
        recordedFields: [
          "title",
          "central_question",
          "description",
          "visibility",
        ],
      }),
      async (transaction) => {
        const inserted = await transaction.query<ProposalRow>(
          `
            INSERT INTO proposals (
              id, public_id, author_actor_id, title,
              central_question, description, visibility
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `,
          [
            id,
            publicId,
            actor.actorId,
            validated.title,
            validated.centralQuestion,
            validated.description,
            validated.visibility,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Proposal insert returned no row");
        return proposal(row);
      },
    );
    return result.result;
  }

  public async get(
    publicId: string,
    actor?: ActorContext,
  ): Promise<Proposal> {
    return this.database.transaction(async (transaction) => {
      const row = await selectInternal(transaction, publicId);
      if (
        row.visibility === "PRIVATE" &&
        (!actor || !canManage(actor, row))
      ) {
        throw new ProposalNotFoundError();
      }
      return proposal(row);
    });
  }

  public async list(
    actor: ActorContext | undefined,
    limit: number,
    offset: number,
  ): Promise<readonly Proposal[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ProposalValidationError("limit must be between 1 and 100");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ProposalValidationError(
        "offset must be a non-negative integer",
      );
    }

    return this.database.transaction(async (transaction) => {
      const privileged = actor ? PRIVILEGED_ROLES.has(actor.role) : false;
      const result = await transaction.query<ProposalRow>(
        `
          SELECT *
          FROM proposals
          WHERE
            status <> 'DELETED'
            AND (
              visibility = 'PUBLIC'
              OR ($1::uuid IS NOT NULL AND author_actor_id = $1::uuid)
              OR $2::boolean = true
            )
          ORDER BY created_at DESC, public_id
          LIMIT $3 OFFSET $4
        `,
        [actor?.actorId ?? null, privileged, limit, offset],
      );
      return Object.freeze(result.rows.map(proposal));
    });
  }

  public async update(
    actor: ActorContext,
    publicId: string,
    input: UpdateProposalInput,
  ): Promise<Proposal> {
    const validated = validateUpdateProposal(input);

    const assignments: string[] = [];
    const values: unknown[] = [];
    const changedFields: string[] = [];
    for (const [column, field, value] of [
      ["title", "title", validated.title],
      ["central_question", "centralQuestion", validated.centralQuestion],
      ["description", "description", validated.description],
      ["visibility", "visibility", validated.visibility],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
        changedFields.push(field);
      }
    }

    const changed = await this.events.transactPrepared(
      async (transaction) => {
        const current = await selectInternal(transaction, publicId);
        requireManage(actor, current);
        if (!EDITABLE_STATUSES.has(current.status)) {
          throw new ProposalConflictError(
            `Proposal cannot be edited in status ${current.status}`,
          );
        }
        return eventCommand(
          current,
          actor,
          validated.expectedVersion,
          "proposal_updated",
          {
            changedFields,
            resultingVersion: validated.expectedVersion + 1,
          },
        );
      },
      async (transaction) => {
        const updateValues = [
          ...values,
          publicId,
          validated.expectedVersion,
        ];
        const updated = await transaction.query<ProposalRow>(
          `
            UPDATE proposals
            SET
              ${assignments.join(", ")},
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
            WHERE public_id = $${updateValues.length - 1}
              AND version = $${updateValues.length}
            RETURNING *
          `,
          updateValues,
        );
        const row = updated.rows[0];
        if (!row) {
          throw new ProposalConflictError(
            "Proposal version changed; reload before updating",
          );
        }
        return proposal(row);
      },
    );
    return changed.result;
  }

  public open(
    actor: ActorContext,
    publicId: string,
    input: TransitionProposalInput,
  ): Promise<Proposal> {
    return this.transition(
      actor,
      publicId,
      expectedVersion(input.expectedVersion),
      ["CREATED"],
      "OPEN",
      "proposal_opened",
    );
  }

  public archive(
    actor: ActorContext,
    publicId: string,
    input: TransitionProposalInput,
  ): Promise<Proposal> {
    return this.transition(
      actor,
      publicId,
      expectedVersion(input.expectedVersion),
      [
        "CREATED",
        "OPEN",
        "COLLECTING",
        "THRESHOLD_REACHED",
        "ELIGIBLE",
      ],
      "ARCHIVED",
      "proposal_archived",
      input.reason === undefined ? null : validateReason(input.reason),
    );
  }

  public async delete(
    actor: ActorContext,
    publicId: string,
    input: TransitionProposalInput,
  ): Promise<void> {
    const version = expectedVersion(input.expectedVersion);
    const reason = validateReason(input.reason);

    await this.events.transactPrepared(
      async (transaction) => {
        const current = await selectInternal(transaction, publicId);
        requireManage(actor, current);
        if (
          !PRIVILEGED_ROLES.has(actor.role) &&
          current.status !== "CREATED"
        ) {
          throw new ProposalForbiddenError(
            "Owners may delete only proposals that have not been opened",
          );
        }

        const dependencies = await transaction.query<CountRow>(
          `
            SELECT (
              (SELECT count(*) FROM authorizations WHERE proposal_id = $1)
              + (SELECT count(*) FROM research_jobs WHERE proposal_id = $1)
            )::text AS count
          `,
          [current.id],
        );
        if (Number(dependencies.rows[0]?.count ?? 0) > 0) {
          throw new ProposalConflictError(
            "Proposal with research history cannot be deleted",
          );
        }
        return eventCommand(current, actor, version, "proposal_deleted", {
          previousStatus: current.status,
          reasonRecorded: true,
        });
      },
      async (transaction) => {
        const deleted = await transaction.query(
          `
            UPDATE proposals
            SET
              title = '[deleted]',
              central_question = '[deleted]',
              description = '',
              status = 'DELETED',
              status_reason = $1,
              deleted_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP,
              version = version + 1
            WHERE public_id = $2 AND version = $3
            RETURNING id
          `,
          [reason, publicId, version],
        );
        if (deleted.rowCount === 0) {
          throw new ProposalConflictError(
            "Proposal version changed; reload before deleting",
          );
        }
      },
    );
  }

  private async transition(
    actor: ActorContext,
    publicId: string,
    version: number,
    allowedStatuses: readonly string[],
    nextStatus: string,
    eventType: string,
    reason: string | null = null,
  ): Promise<Proposal> {
    const changed = await this.events.transactPrepared(
      async (transaction) => {
        const current = await selectInternal(transaction, publicId);
        requireManage(actor, current);

        if (!allowedStatuses.includes(current.status)) {
          throw new ProposalConflictError(
            `Cannot transition ${current.status} to ${nextStatus}`,
          );
        }
        return eventCommand(current, actor, version, eventType, {
          from: current.status,
          to: nextStatus,
          reasonRecorded: reason !== null,
        });
      },
      async (transaction) => {
        const timestampColumn =
          nextStatus === "OPEN" ? "opened_at" : "archived_at";
        const updated = await transaction.query<ProposalRow>(
          `
            UPDATE proposals
            SET
              status = $1,
              status_reason = $2,
              ${timestampColumn} = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP,
              version = version + 1
            WHERE public_id = $3 AND version = $4
            RETURNING *
          `,
          [nextStatus, reason, publicId, version],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new ProposalConflictError(
            "Proposal version changed; reload before transitioning",
          );
        }
        return proposal(row);
      },
    );
    return changed.result;
  }
}
