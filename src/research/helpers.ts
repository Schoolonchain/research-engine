import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../db/database.js";
import { ResearchValidationError } from "./errors.js";

export function boundedKey(value: string): string {
  const key = value.trim().normalize("NFC");
  if (key.length < 8 || key.length > 200) throw new ResearchValidationError("Invalid idempotency key");
  return key;
}
export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function eventSequence(
  tx: DatabaseExecutor, aggregateType: string, aggregateId: string,
): Promise<number> {
  const result = await tx.query<{ current_sequence: string }>(
    `SELECT current_sequence FROM aggregate_streams
     WHERE aggregate_type = $1 AND aggregate_id = $2`, [aggregateType, aggregateId],
  );
  return Number(result.rows[0]?.current_sequence ?? 0);
}
