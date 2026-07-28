import type { DataSourceType } from "./model.js";

export interface TronCollector<TTarget, TResult> {
  readonly collectorName: string;
  readonly sourceName: string;
  readonly sourceType: DataSourceType;
  collect(target: TTarget): Promise<TResult>;
  supports(target: TTarget): boolean;
}

export type AnyTronCollector = TronCollector<unknown, unknown>;
