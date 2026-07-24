import type {
  DatabaseExecutor,
  TransactionalDatabase,
} from "../db/database.js";
import { assertSafeEventPayload } from "./payload-policy.js";

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,149}$/;

export interface ActorReference {
  readonly type: string;
  readonly id?: string;
}

export interface AppendEventCommand {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedSequence: number;
  readonly actor?: ActorReference;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly topic?: string;
}

export interface StoredEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly actorType: string | null;
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
}

interface SequenceRow {
  readonly current_sequence: string;
}

interface StoredEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly sequence: string;
  readonly actor_type: string | null;
  readonly actor_id: string | null;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
}

export class EventConcurrencyError extends Error {
  public constructor(
    aggregateType: string,
    aggregateId: string,
    expectedSequence: number,
  ) {
    super(
      `Unexpected sequence for ${aggregateType}/${aggregateId}; expected ${expectedSequence}`,
    );
    this.name = "EventConcurrencyError";
  }
}

function validateCommand(command: AppendEventCommand): void {
  for (const [label, value] of [
    ["aggregateType", command.aggregateType],
    ["eventType", command.eventType],
  ] as const) {
    if (!NAME_PATTERN.test(value)) {
      throw new Error(`${label} must use lower snake_case`);
    }
  }
  if (!Number.isSafeInteger(command.expectedSequence)) {
    throw new Error("expectedSequence must be a safe integer");
  }
  if (command.expectedSequence < 0) {
    throw new Error("expectedSequence cannot be negative");
  }
  if (!Number.isSafeInteger(command.eventVersion) || command.eventVersion < 1) {
    throw new Error("eventVersion must be a positive integer");
  }
  assertSafeEventPayload(command.payload);
}

function storedEvent(row: StoredEventRow): StoredEvent {
  return Object.freeze({
    eventId: row.event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    sequence: Number(row.sequence),
    actorType: row.actor_type,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: Object.freeze(row.payload),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  });
}

export class EventStore {
  public constructor(private readonly database: TransactionalDatabase) {}

  public async transact<Result>(
    command: AppendEventCommand,
    mutateState: (transaction: DatabaseExecutor) => Promise<Result>,
  ): Promise<{ readonly result: Result; readonly event: StoredEvent }> {
    validateCommand(command);

    return this.database.transaction(async (transaction) => {
      const result = await mutateState(transaction);
      const event = await this.append(transaction, command);
      return Object.freeze({ result, event });
    });
  }

  public async transactPrepared<Result>(
    prepare: (
      transaction: DatabaseExecutor,
    ) => Promise<AppendEventCommand>,
    mutateState: (
      transaction: DatabaseExecutor,
      command: AppendEventCommand,
    ) => Promise<Result>,
  ): Promise<{ readonly result: Result; readonly event: StoredEvent }> {
    return this.database.transaction(async (transaction) => {
      const command = await prepare(transaction);
      validateCommand(command);
      const result = await mutateState(transaction, command);
      const event = await this.append(transaction, command);
      return Object.freeze({ result, event });
    });
  }

  private async append(
    transaction: DatabaseExecutor,
    command: AppendEventCommand,
  ): Promise<StoredEvent> {
    await transaction.query(
      `
        INSERT INTO aggregate_streams (
          aggregate_type, aggregate_id, current_sequence
        ) VALUES ($1, $2, 0)
        ON CONFLICT (aggregate_type, aggregate_id) DO NOTHING
      `,
      [command.aggregateType, command.aggregateId],
    );

    const sequenceResult = await transaction.query<SequenceRow>(
      `
        UPDATE aggregate_streams
        SET
          current_sequence = current_sequence + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE
          aggregate_type = $1
          AND aggregate_id = $2
          AND current_sequence = $3
        RETURNING current_sequence
      `,
      [
        command.aggregateType,
        command.aggregateId,
        command.expectedSequence,
      ],
    );
    const sequenceRow = sequenceResult.rows[0];
    if (!sequenceRow) {
      throw new EventConcurrencyError(
        command.aggregateType,
        command.aggregateId,
        command.expectedSequence,
      );
    }

    const eventResult = await transaction.query<StoredEventRow>(
      `
        INSERT INTO domain_events (
          event_id, aggregate_type, aggregate_id, sequence,
          event_type, event_version, actor_type, actor_id,
          correlation_id, causation_id, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11::jsonb
        )
        RETURNING *
      `,
      [
        command.eventId,
        command.aggregateType,
        command.aggregateId,
        Number(sequenceRow.current_sequence),
        command.eventType,
        command.eventVersion,
        command.actor?.type ?? null,
        command.actor?.id ?? null,
        command.correlationId,
        command.causationId ?? null,
        JSON.stringify(command.payload),
      ],
    );
    const eventRow = eventResult.rows[0];
    if (!eventRow) throw new Error("Event insert returned no row");

    await transaction.query(
      `
        INSERT INTO outbox_messages (event_id, topic)
        VALUES ($1, $2)
      `,
      [command.eventId, command.topic ?? "domain_events"],
    );

    return storedEvent(eventRow);
  }
}

