export const METRIC_CATEGORIES = [
  "NETWORK",
  "ADDRESS",
  "MONETARY",
  "RESOURCE",
  "GOVERNANCE",
  "HOLDER",
  "TRANSACTION",
  "CONTRACT",
  "TOKEN",
  "STABLECOIN",
  "DEFI",
  "EXCHANGE_FLOW",
  "VALIDATOR",
  "WHALE",
  "DEVELOPER",
  "ECOSYSTEM",
] as const;

export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

export const METRIC_CONFIDENCES = ["DIRECT", "DERIVED", "ESTIMATED", "FALLBACK"] as const;
export type MetricConfidence = (typeof METRIC_CONFIDENCES)[number];

export interface MetricRecord {
  readonly id: string;
  readonly category: MetricCategory;
  readonly metricName: string;
  readonly blockchain: string;
  readonly source: string;
  readonly value: number | string;
  readonly unit: string;
  readonly timestamp: Date;
  readonly blockHeight: number | null;
  readonly confidence: MetricConfidence;
  readonly address: string | null;
  readonly rawData: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

export interface MetricDefinition {
  readonly name: string;
  readonly category: MetricCategory;
  readonly unit: string;
  readonly description: string;
  readonly confidence: MetricConfidence;
  readonly valueType: "number" | "string";
}

export function createMetricRecord(
  fields: Omit<MetricRecord, "id">,
): MetricRecord {
  return Object.freeze({
    id: generateMetricId(),
    ...fields,
  });
}

export function createMetricBatch(
  shared: {
    readonly blockchain: string;
    readonly source: string;
    readonly timestamp: Date;
    readonly blockHeight: number | null;
  },
  entries: readonly {
    readonly category: MetricCategory;
    readonly metricName: string;
    readonly value: number | string;
    readonly unit: string;
    readonly confidence: MetricConfidence;
    readonly address?: string | null;
    readonly rawData?: Readonly<Record<string, unknown>> | null;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
  }[],
): readonly MetricRecord[] {
  return entries.map((entry) =>
    createMetricRecord({
      category: entry.category,
      metricName: entry.metricName,
      blockchain: shared.blockchain,
      source: shared.source,
      value: entry.value,
      unit: entry.unit,
      timestamp: shared.timestamp,
      blockHeight: shared.blockHeight,
      confidence: entry.confidence,
      address: entry.address ?? null,
      rawData: entry.rawData ?? null,
      metadata: entry.metadata ?? null,
    }),
  );
}

function generateMetricId(): string {
  return crypto.randomUUID();
}
