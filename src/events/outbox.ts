import type { TransactionalDatabase } from "../db/database.js";

export interface OutboxMessage {
  readonly id: string;
  readonly eventId: string;
  readonly topic: string;
  readonly attempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

interface OutboxMessageRow {
  readonly id: string;
  readonly event_id: string;
  readonly topic: string;
  readonly attempts: number;
  readonly lease_owner: string;
  readonly lease_expires_at: Date;
}

interface UpdatedMessageRow {
  readonly id: string;
}

export class OutboxLeaseError extends Error {
  public constructor(messageId: string) {
    super(`Outbox lease is no longer valid for message ${messageId}`);
    this.name = "OutboxLeaseError";
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export class Outbox {
  public constructor(private readonly database: TransactionalDatabase) {}

  public claim(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<readonly OutboxMessage[]> {
    if (!workerId.trim() || workerId.length > 200) {
      throw new Error("workerId must contain 1 to 200 characters");
    }
    positiveInteger(batchSize, "batchSize");
    positiveInteger(leaseSeconds, "leaseSeconds");

    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<OutboxMessageRow>(
        `
          WITH candidates AS (
            SELECT id
            FROM outbox_messages
            WHERE (
              status IN ('PENDING', 'FAILED')
              AND available_at <= CURRENT_TIMESTAMP
            ) OR (
              status = 'PROCESSING'
              AND lease_expires_at < CURRENT_TIMESTAMP
            )
            ORDER BY created_at, id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox_messages AS message
          SET
            status = 'PROCESSING',
            attempts = message.attempts + 1,
            lease_owner = $2,
            lease_expires_at =
              CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
            updated_at = CURRENT_TIMESTAMP
          FROM candidates
          WHERE message.id = candidates.id
          RETURNING
            message.id,
            message.event_id,
            message.topic,
            message.attempts,
            message.lease_owner,
            message.lease_expires_at
        `,
        [batchSize, workerId, leaseSeconds],
      );

      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            id: row.id,
            eventId: row.event_id,
            topic: row.topic,
            attempts: row.attempts,
            leaseOwner: row.lease_owner,
            leaseExpiresAt: row.lease_expires_at,
          }),
        ),
      );
    });
  }

  public markPublished(messageId: string, workerId: string): Promise<void> {
    return this.updateLeasedMessage(
      messageId,
      workerId,
      `
        status = 'PUBLISHED',
        published_at = CURRENT_TIMESTAMP,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        updated_at = CURRENT_TIMESTAMP
      `,
      [],
    );
  }

  public markFailed(
    messageId: string,
    workerId: string,
    errorCode: string,
    retryDelaySeconds: number,
  ): Promise<void> {
    if (!errorCode.trim() || errorCode.length > 200) {
      throw new Error("errorCode must contain 1 to 200 characters");
    }
    positiveInteger(retryDelaySeconds, "retryDelaySeconds");

    return this.updateLeasedMessage(
      messageId,
      workerId,
      `
        status = 'FAILED',
        available_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = $4,
        updated_at = CURRENT_TIMESTAMP
      `,
      [retryDelaySeconds, errorCode],
    );
  }

  private async updateLeasedMessage(
    messageId: string,
    workerId: string,
    assignments: string,
    extraValues: readonly unknown[],
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query<UpdatedMessageRow>(
        `
          UPDATE outbox_messages
          SET ${assignments}
          WHERE
            id = $1
            AND status = 'PROCESSING'
            AND lease_owner = $2
            AND lease_expires_at >= CURRENT_TIMESTAMP
          RETURNING id
        `,
        [messageId, workerId, ...extraValues],
      );

      if (result.rowCount === 0) {
        throw new OutboxLeaseError(messageId);
      }
    });
  }
}

