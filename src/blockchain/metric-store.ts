import type { MetricCategory, MetricRecord } from "./metric-types.js";

export interface MetricQuery {
  readonly blockchain?: string;
  readonly category?: MetricCategory;
  readonly metricName?: string;
  readonly address?: string;
  readonly source?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
}

export interface MetricStore {
  insert(record: MetricRecord): Promise<void>;
  insertBatch(records: readonly MetricRecord[]): Promise<void>;
  query(q: MetricQuery): Promise<readonly MetricRecord[]>;
  latest(blockchain: string, metricName: string, address?: string): Promise<MetricRecord | null>;
  count(q: MetricQuery): Promise<number>;
  categories(blockchain: string): Promise<readonly MetricCategory[]>;
}
