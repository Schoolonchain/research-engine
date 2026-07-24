import { randomUUID } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import {
  EventConcurrencyError,
  EventStore,
  type AppendEventCommand,
  type StoredEvent,
} from "../src/events/event-store.js";
import {
  IdempotentEventConsumer,
  updateAggregateEventCount,
} from "../src/events/idempotent-consumer.js";
import { Outbox, OutboxLeaseError } from "../src/events/outbox.js";
import { UnsafeEventPayloadError } from "../src/events/payload-policy.js";

class PGliteExecutor implements DatabaseExecutor {
  public constructor(private readonly database: PGlite | Transaction) {}

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.database.query<Row>(sql, [...values]);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }
}

class PGliteTransactionalDatabase implements TransactionalDatabase {
  public constructor(private readonly database: PGlite) {}

  public transaction<Result>(
    operation: (transaction: DatabaseExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction((transaction) =>
      operation(new PGliteExecutor(transaction)),
    );
  }
}

function command(
  aggregateId: string,
  expectedSequence: number,
  overrides: Partial<AppendEventCommand> = {},
): AppendEventCommand {
  return {
    eventId: randomUUID(),
    eventType: "proposal_created",
    eventVersion: 1,
    aggregateType: "proposal",
    aggregateId,
    expectedSequence,
    actor: { type: "user", id: randomUUID() },
    correlationId: randomUUID(),
    payload: { titleChanged: true },
    ...overrides,
  };
}

describe("Event Log and Outbox", () => {
  let database: PGlite;
  let transactionalDatabase: PGliteTransactionalDatabase;
  let eventStore: EventStore;

  beforeEach(async () => {
    database = new PGlite();
    const migrationExecutor = {
      query: async (sql: string, values: readonly unknown[] = []) =>
        values.length === 0
          ? database.exec(sql)
          : database.query(sql, [...values]),
    };
    await migrate(migrationExecutor, await loadMigrations());
    transactionalDatabase = new PGliteTransactionalDatabase(database);
    eventStore = new EventStore(transactionalDatabase);
  });

  afterEach(async () => {
    await database.close();
  });

  it("records ordered events and one outbox message per event", async () => {
    const aggregateId = randomUUID();

    const first = await eventStore.transact(command(aggregateId, 0), async () =>
      Promise.resolve("first"),
    );
    const second = await eventStore.transact(
      command(aggregateId, 1, {
        eventType: "proposal_updated",
        causationId: first.event.eventId,
      }),
      async () => Promise.resolve("second"),
    );

    expect(first.event.sequence).toBe(1);
    expect(second.event.sequence).toBe(2);

    const result = await database.query<{
      event_count: number;
      outbox_count: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM domain_events) AS event_count,
        (SELECT count(*)::int FROM outbox_messages) AS outbox_count
    `);
    expect(result.rows[0]).toEqual({ event_count: 2, outbox_count: 2 });
  });

  it("rejects stale writers and rolls back their state mutation", async () => {
    const aggregateId = randomUUID();
    await eventStore.transact(command(aggregateId, 0), async () =>
      Promise.resolve(),
    );

    await expect(
      eventStore.transact(command(aggregateId, 0), async (transaction) => {
        await transaction.query(
          `
            INSERT INTO proposals (title, central_question)
            VALUES ('Must roll back', 'Did the transaction remain atomic?')
          `,
        );
      }),
    ).rejects.toBeInstanceOf(EventConcurrencyError);

    const proposals = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM proposals",
    );
    expect(proposals.rows[0]?.count).toBe(0);
  });

  it("rejects updates and deletes from the append-only event log", async () => {
    const aggregateId = randomUUID();
    const stored = await eventStore.transact(
      command(aggregateId, 0),
      async () => Promise.resolve(),
    );

    await expect(
      database.query(
        "UPDATE domain_events SET event_type = 'tampered' WHERE event_id = $1",
        [stored.event.eventId],
      ),
    ).rejects.toThrow("domain_events is append-only");

    await expect(
      database.query("DELETE FROM domain_events WHERE event_id = $1", [
        stored.event.eventId,
      ]),
    ).rejects.toThrow("domain_events is append-only");
  });

  it("rejects secret and direct-identifier keys before opening a transaction", async () => {
    const aggregateId = randomUUID();

    await expect(
      eventStore.transact(
        command(aggregateId, 0, {
          payload: {
            safe: "value",
            nested: { apiToken: "must-not-be-recorded" },
          },
        }),
        async () => Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(UnsafeEventPayloadError);

    const streams = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM aggregate_streams",
    );
    expect(streams.rows[0]?.count).toBe(0);
  });

  it("processes redelivered events exactly once", async () => {
    const aggregateId = randomUUID();
    const { event } = await eventStore.transact(
      command(aggregateId, 0),
      async () => Promise.resolve(),
    );
    const consumer = new IdempotentEventConsumer(transactionalDatabase);
    const consumerName = "analytics.event_counter";

    const first = await consumer.process(
      consumerName,
      event,
      async (transaction, storedEvent) =>
        updateAggregateEventCount(transaction, consumerName, storedEvent),
    );
    const duplicate = await consumer.process(
      consumerName,
      event,
      async (transaction, storedEvent) =>
        updateAggregateEventCount(transaction, consumerName, storedEvent),
    );

    expect(first).toBe("PROCESSED");
    expect(duplicate).toBe("DUPLICATE");

    const projection = await database.query<{
      event_count: string;
      last_sequence: string;
    }>(
      `
        SELECT event_count, last_sequence
        FROM aggregate_event_counts
        WHERE consumer_name = $1 AND aggregate_id = $2
      `,
      [consumerName, aggregateId],
    );
    expect(Number(projection.rows[0]?.event_count)).toBe(1);
    expect(Number(projection.rows[0]?.last_sequence)).toBe(1);
  });

  it("rolls back a consumer receipt when its handler fails", async () => {
    const aggregateId = randomUUID();
    const { event } = await eventStore.transact(
      command(aggregateId, 0),
      async () => Promise.resolve(),
    );
    const consumer = new IdempotentEventConsumer(transactionalDatabase);

    await expect(
      consumer.process("failing.consumer", event, async () => {
        throw new Error("projection failed");
      }),
    ).rejects.toThrow("projection failed");

    const retry = await consumer.process(
      "failing.consumer",
      event,
      async () => Promise.resolve(),
    );
    expect(retry).toBe("PROCESSED");
  });

  it("keeps separate sequence streams per aggregate", async () => {
    const firstAggregate = randomUUID();
    const secondAggregate = randomUUID();

    const events: StoredEvent[] = [];
    for (const aggregateId of [firstAggregate, secondAggregate]) {
      const stored = await eventStore.transact(
        command(aggregateId, 0),
        async () => Promise.resolve(),
      );
      events.push(stored.event);
    }

    expect(events.map((event) => event.sequence)).toEqual([1, 1]);
  });

  it("leases and publishes each outbox message once", async () => {
    const aggregateId = randomUUID();
    await eventStore.transact(
      command(aggregateId, 0),
      async () => Promise.resolve(),
    );
    const outbox = new Outbox(transactionalDatabase);

    const claimed = await outbox.claim("worker-1", 10, 60);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempts).toBe(1);

    const unavailable = await outbox.claim("worker-2", 10, 60);
    expect(unavailable).toHaveLength(0);

    const message = claimed[0];
    if (!message) throw new Error("Expected one claimed message");
    await outbox.markPublished(message.id, "worker-1");

    const published = await database.query<{
      status: string;
      published_at: Date;
    }>(
      "SELECT status, published_at FROM outbox_messages WHERE id = $1",
      [message.id],
    );
    expect(published.rows[0]?.status).toBe("PUBLISHED");
    expect(published.rows[0]?.published_at).toBeInstanceOf(Date);
  });

  it("rejects completion by a worker that does not own the lease", async () => {
    const aggregateId = randomUUID();
    await eventStore.transact(
      command(aggregateId, 0),
      async () => Promise.resolve(),
    );
    const outbox = new Outbox(transactionalDatabase);
    const claimed = await outbox.claim("worker-1", 1, 60);
    const message = claimed[0];
    if (!message) throw new Error("Expected one claimed message");

    await expect(
      outbox.markPublished(message.id, "worker-2"),
    ).rejects.toBeInstanceOf(OutboxLeaseError);
  });

  it("makes failed messages available only after their retry delay", async () => {
    const aggregateId = randomUUID();
    await eventStore.transact(
      command(aggregateId, 0),
      async () => Promise.resolve(),
    );
    const outbox = new Outbox(transactionalDatabase);
    const claimed = await outbox.claim("worker-1", 1, 60);
    const message = claimed[0];
    if (!message) throw new Error("Expected one claimed message");

    await outbox.markFailed(message.id, "worker-1", "DELIVERY_FAILED", 60);
    expect(await outbox.claim("worker-2", 1, 60)).toHaveLength(0);

    await database.query(
      `
        UPDATE outbox_messages
        SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE id = $1
      `,
      [message.id],
    );
    const retried = await outbox.claim("worker-2", 1, 60);
    expect(retried).toHaveLength(1);
    expect(retried[0]?.attempts).toBe(2);
  });
});
