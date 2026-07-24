import type {
  DatabaseExecutor,
  TransactionalDatabase,
} from "../db/database.js";
import type { StoredEvent } from "./event-store.js";

const CONSUMER_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,149}$/;

interface ReceiptRow {
  readonly event_id: string;
}

export class IdempotentEventConsumer {
  public constructor(private readonly database: TransactionalDatabase) {}

  public async process(
    consumerName: string,
    event: StoredEvent,
    handler: (
      transaction: DatabaseExecutor,
      event: StoredEvent,
    ) => Promise<void>,
  ): Promise<"PROCESSED" | "DUPLICATE"> {
    if (!CONSUMER_NAME_PATTERN.test(consumerName)) {
      throw new Error("consumerName has an invalid format");
    }

    return this.database.transaction(async (transaction) => {
      const receipt = await transaction.query<ReceiptRow>(
        `
          INSERT INTO consumer_receipts (consumer_name, event_id)
          VALUES ($1, $2)
          ON CONFLICT (consumer_name, event_id) DO NOTHING
          RETURNING event_id
        `,
        [consumerName, event.eventId],
      );

      if (receipt.rowCount === 0) return "DUPLICATE";

      await handler(transaction, event);
      return "PROCESSED";
    });
  }
}

export async function updateAggregateEventCount(
  transaction: DatabaseExecutor,
  consumerName: string,
  event: StoredEvent,
): Promise<void> {
  await transaction.query(
    `
      INSERT INTO aggregate_event_counts (
        consumer_name, aggregate_type, aggregate_id,
        event_count, last_sequence
      ) VALUES ($1, $2, $3, 1, $4)
      ON CONFLICT (consumer_name, aggregate_type, aggregate_id)
      DO UPDATE SET
        event_count = aggregate_event_counts.event_count + 1,
        last_sequence = EXCLUDED.last_sequence,
        updated_at = CURRENT_TIMESTAMP
      WHERE aggregate_event_counts.last_sequence < EXCLUDED.last_sequence
    `,
    [
      consumerName,
      event.aggregateType,
      event.aggregateId,
      event.sequence,
    ],
  );
}

