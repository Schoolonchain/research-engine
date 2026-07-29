import type { DatabaseExecutor } from "../db/database.js";
import type { MetricCategory, MetricRecord } from "./metric-types.js";
import type { MetricQuery, MetricStore } from "./metric-store.js";

interface MetricRow {
  readonly id: string;
  readonly category: string;
  readonly metric_name: string;
  readonly blockchain: string;
  readonly source: string;
  readonly value_num: number | null;
  readonly value_text: string | null;
  readonly unit: string;
  readonly timestamp: Date;
  readonly block_height: number | null;
  readonly confidence: string;
  readonly address: string | null;
  readonly raw_data: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

function toRecord(row: MetricRow): MetricRecord {
  return Object.freeze({
    id: row.id,
    category: row.category as MetricCategory,
    metricName: row.metric_name,
    blockchain: row.blockchain,
    source: row.source,
    value: row.value_num ?? row.value_text ?? "",
    unit: row.unit,
    timestamp: row.timestamp,
    blockHeight: row.block_height,
    confidence: row.confidence as MetricRecord["confidence"],
    address: row.address,
    rawData: row.raw_data ? Object.freeze(row.raw_data) : null,
    metadata: row.metadata ? Object.freeze(row.metadata) : null,
  });
}

const COLUMNS = `
  id, category, metric_name, blockchain, source,
  value_num, value_text, unit, timestamp, block_height,
  confidence, address, raw_data, metadata
`;

export class SqlMetricStore implements MetricStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async insert(record: MetricRecord): Promise<void> {
    const isNumeric = typeof record.value === "number";
    await this.db.query(
      `INSERT INTO onchain_metrics (
        id, category, metric_name, blockchain, source,
        value_num, value_text, unit, timestamp, block_height,
        confidence, address, raw_data, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13::jsonb, $14::jsonb
      )`,
      [
        record.id,
        record.category,
        record.metricName,
        record.blockchain,
        record.source,
        isNumeric ? record.value : null,
        isNumeric ? null : String(record.value),
        record.unit,
        record.timestamp,
        record.blockHeight,
        record.confidence,
        record.address,
        record.rawData ? JSON.stringify(record.rawData) : null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      ],
    );
  }

  async insertBatch(records: readonly MetricRecord[]): Promise<void> {
    if (records.length === 0) return;

    const PARAMS_PER_ROW = 14;
    const chunkSize = 200;

    for (let offset = 0; offset < records.length; offset += chunkSize) {
      const chunk = records.slice(offset, offset + chunkSize);
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const r of chunk) {
        const isNumeric = typeof r.value === "number";
        const slots = Array.from({ length: 14 }, () => `$${idx++}`);
        slots[12] = `${slots[12]}::jsonb`;
        slots[13] = `${slots[13]}::jsonb`;
        placeholders.push(`(${slots.join(", ")})`);
        values.push(
          r.id, r.category, r.metricName, r.blockchain, r.source,
          isNumeric ? r.value : null,
          isNumeric ? null : String(r.value),
          r.unit, r.timestamp, r.blockHeight,
          r.confidence, r.address,
          r.rawData ? JSON.stringify(r.rawData) : null,
          r.metadata ? JSON.stringify(r.metadata) : null,
        );
      }

      await this.db.query(
        `INSERT INTO onchain_metrics (
          id, category, metric_name, blockchain, source,
          value_num, value_text, unit, timestamp, block_height,
          confidence, address, raw_data, metadata
        ) VALUES ${placeholders.join(", ")}`,
        values,
      );
    }
  }

  async query(q: MetricQuery): Promise<readonly MetricRecord[]> {
    const { where, values } = this.buildWhere(q);
    const limit = q.limit ?? 1000;
    values.push(limit);

    const result = await this.db.query<MetricRow>(
      `SELECT ${COLUMNS} FROM onchain_metrics
       ${where}
       ORDER BY timestamp DESC
       LIMIT $${values.length}`,
      values,
    );

    return Object.freeze(result.rows.map(toRecord));
  }

  async latest(
    blockchain: string,
    metricName: string,
    address?: string,
  ): Promise<MetricRecord | null> {
    const values: unknown[] = [blockchain, metricName];
    let addressClause = "";
    if (address !== undefined) {
      values.push(address);
      addressClause = ` AND address = $${values.length}`;
    }

    const result = await this.db.query<MetricRow>(
      `SELECT ${COLUMNS} FROM onchain_metrics
       WHERE blockchain = $1 AND metric_name = $2${addressClause}
       ORDER BY timestamp DESC
       LIMIT 1`,
      values,
    );

    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async count(q: MetricQuery): Promise<number> {
    const { where, values } = this.buildWhere(q);
    const result = await this.db.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM onchain_metrics ${where}`,
      values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async categories(blockchain: string): Promise<readonly MetricCategory[]> {
    const result = await this.db.query<{ readonly category: string }>(
      `SELECT DISTINCT category FROM onchain_metrics
       WHERE blockchain = $1
       ORDER BY category`,
      [blockchain],
    );
    return Object.freeze(
      result.rows.map((r) => r.category as MetricCategory),
    );
  }

  private buildWhere(q: MetricQuery): {
    where: string;
    values: unknown[];
  } {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (q.blockchain !== undefined) {
      values.push(q.blockchain);
      conditions.push(`blockchain = $${values.length}`);
    }
    if (q.category !== undefined) {
      values.push(q.category);
      conditions.push(`category = $${values.length}`);
    }
    if (q.metricName !== undefined) {
      values.push(q.metricName);
      conditions.push(`metric_name = $${values.length}`);
    }
    if (q.address !== undefined) {
      values.push(q.address);
      conditions.push(`address = $${values.length}`);
    }
    if (q.source !== undefined) {
      values.push(q.source);
      conditions.push(`source = $${values.length}`);
    }
    if (q.from !== undefined) {
      values.push(q.from);
      conditions.push(`timestamp >= $${values.length}`);
    }
    if (q.to !== undefined) {
      values.push(q.to);
      conditions.push(`timestamp <= $${values.length}`);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    return { where, values };
  }
}
