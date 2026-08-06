import type { BlockchainBlock, BlockchainTransaction } from "./model.js";

export interface SourceValue {
  readonly source: string;
  readonly dataSourceId: string;
  readonly value: unknown;
}

export interface FieldDiscrepancy {
  readonly field: string;
  readonly sources: readonly SourceValue[];
}

export interface TransactionDiscrepancy {
  readonly txHash: string;
  readonly fields: readonly FieldDiscrepancy[];
}

export interface MissingTransaction {
  readonly txHash: string;
  readonly presentIn: readonly string[];
  readonly missingFrom: readonly string[];
}

export const VALIDATION_STATUSES = ["CONSISTENT", "DISCREPANCY", "INSUFFICIENT_SOURCES"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export interface BlockValidationResult {
  readonly blockNumber: number;
  readonly networkId: string;
  readonly sourceCount: number;
  readonly sources: readonly string[];
  readonly status: ValidationStatus;
  readonly blockDiscrepancies: readonly FieldDiscrepancy[];
  readonly transactionDiscrepancies: readonly TransactionDiscrepancy[];
  readonly missingTransactions: readonly MissingTransaction[];
  readonly validatedAt: Date;
}

const BLOCK_COMPARE_FIELDS: readonly (keyof BlockchainBlock)[] = [
  "blockHash",
  "parentHash",
  "blockProducer",
  "txCount",
  "sizeBytes",
];

const TX_COMPARE_FIELDS: readonly (keyof BlockchainTransaction)[] = [
  "txType",
  "fromAddress",
  "toAddress",
  "amount",
  "fee",
  "amountUnit",
  "feeUnit",
  "result",
];

function valuesMatch(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

function compareField(
  field: string,
  observations: readonly { source: string; dataSourceId: string; value: unknown }[],
): FieldDiscrepancy | null {
  const first = observations[0]!;
  const allMatch = observations.every((o) => valuesMatch(o.value, first.value));
  if (allMatch) return null;
  return Object.freeze({
    field,
    sources: Object.freeze(
      observations.map((o) =>
        Object.freeze({ source: o.source, dataSourceId: o.dataSourceId, value: o.value }),
      ),
    ),
  });
}

export function compareBlocks(
  observations: readonly BlockchainBlock[],
): readonly FieldDiscrepancy[] {
  if (observations.length < 2) return Object.freeze([]);

  const discrepancies: FieldDiscrepancy[] = [];
  for (const field of BLOCK_COMPARE_FIELDS) {
    const entries = observations.map((block) => ({
      source: block.collectionSource,
      dataSourceId: block.dataSourceId,
      value: block[field] as unknown,
    }));
    const discrepancy = compareField(field, entries);
    if (discrepancy) discrepancies.push(discrepancy);
  }
  return Object.freeze(discrepancies);
}

export function compareTransactions(
  transactionsBySource: ReadonlyMap<string, readonly BlockchainTransaction[]>,
): {
  discrepancies: readonly TransactionDiscrepancy[];
  missing: readonly MissingTransaction[];
} {
  const sources = [...transactionsBySource.keys()];
  if (sources.length < 2) {
    return { discrepancies: Object.freeze([]), missing: Object.freeze([]) };
  }

  const txHashToSources = new Map<string, Map<string, BlockchainTransaction>>();

  for (const [source, transactions] of transactionsBySource) {
    for (const tx of transactions) {
      let sourceMap = txHashToSources.get(tx.txHash);
      if (!sourceMap) {
        sourceMap = new Map();
        txHashToSources.set(tx.txHash, sourceMap);
      }
      sourceMap.set(source, tx);
    }
  }

  const missing: MissingTransaction[] = [];
  const discrepancies: TransactionDiscrepancy[] = [];

  for (const [txHash, sourceMap] of txHashToSources) {
    const presentIn = [...sourceMap.keys()];
    const missingFrom = sources.filter((s) => !sourceMap.has(s));

    if (missingFrom.length > 0) {
      missing.push(
        Object.freeze({
          txHash,
          presentIn: Object.freeze(presentIn),
          missingFrom: Object.freeze(missingFrom),
        }),
      );
    }

    if (sourceMap.size < 2) continue;

    const txObservations = [...sourceMap.entries()];
    const fieldDiscrepancies: FieldDiscrepancy[] = [];

    for (const field of TX_COMPARE_FIELDS) {
      const entries = txObservations.map(([source, tx]) => ({
        source,
        dataSourceId: tx.dataSourceId,
        value: tx[field] as unknown,
      }));
      const discrepancy = compareField(field, entries);
      if (discrepancy) fieldDiscrepancies.push(discrepancy);
    }

    if (fieldDiscrepancies.length > 0) {
      discrepancies.push(
        Object.freeze({
          txHash,
          fields: Object.freeze(fieldDiscrepancies),
        }),
      );
    }
  }

  return {
    discrepancies: Object.freeze(discrepancies),
    missing: Object.freeze(missing),
  };
}

export function crossValidateBlock(
  blockNumber: number,
  networkId: string,
  observations: readonly BlockchainBlock[],
  transactionsByBlock: ReadonlyMap<string, readonly BlockchainTransaction[]>,
): BlockValidationResult {
  const sourceNames = observations.map((b) => b.collectionSource);

  if (observations.length < 2) {
    return Object.freeze({
      blockNumber,
      networkId,
      sourceCount: observations.length,
      sources: Object.freeze(sourceNames),
      status: "INSUFFICIENT_SOURCES" as const,
      blockDiscrepancies: Object.freeze([]),
      transactionDiscrepancies: Object.freeze([]),
      missingTransactions: Object.freeze([]),
      validatedAt: new Date(),
    });
  }

  const blockDiscrepancies = compareBlocks(observations);

  const transactionsBySource = new Map<string, readonly BlockchainTransaction[]>();
  for (const block of observations) {
    const txs = transactionsByBlock.get(block.id);
    if (txs) {
      transactionsBySource.set(block.collectionSource, txs);
    }
  }

  const { discrepancies: transactionDiscrepancies, missing: missingTransactions } =
    compareTransactions(transactionsBySource);

  const hasDiscrepancies =
    blockDiscrepancies.length > 0 ||
    transactionDiscrepancies.length > 0 ||
    missingTransactions.length > 0;

  return Object.freeze({
    blockNumber,
    networkId,
    sourceCount: observations.length,
    sources: Object.freeze(sourceNames),
    status: hasDiscrepancies ? ("DISCREPANCY" as const) : ("CONSISTENT" as const),
    blockDiscrepancies,
    transactionDiscrepancies,
    missingTransactions,
    validatedAt: new Date(),
  });
}
