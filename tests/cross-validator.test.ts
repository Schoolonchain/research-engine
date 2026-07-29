import { describe, expect, it } from "vitest";

import type { BlockchainBlock, BlockchainTransaction } from "../src/blockchain/model.js";
import {
  compareBlocks,
  compareTransactions,
  crossValidateBlock,
} from "../src/blockchain/cross-validator.js";

function makeBlock(overrides?: Partial<BlockchainBlock>): BlockchainBlock {
  return Object.freeze({
    id: "block-1",
    networkId: "net-1",
    dataSourceId: "ds-1",
    blockNumber: 50_000_000,
    blockHash: "0000000002faf080",
    parentHash: "0000000002faf07f",
    blockTimestamp: new Date("2023-11-14T22:13:20Z"),
    blockProducer: "TWitness",
    txCount: 1,
    sizeBytes: 1024,
    collectionSource: "SourceA",
    collectedAt: new Date(),
    ...overrides,
  });
}

function makeTx(overrides?: Partial<BlockchainTransaction>): BlockchainTransaction {
  return Object.freeze({
    id: "tx-1",
    networkId: "net-1",
    dataSourceId: "ds-1",
    blockId: "block-1",
    txHash: "abc123",
    txType: "TransferContract",
    fromAddress: "TFrom",
    toAddress: "TTo",
    amount: "1000000",
    fee: "100000",
    amountUnit: "SUN",
    feeUnit: "SUN",
    result: "SUCCESS",
    chainData: Object.freeze({ energyUsed: null, bandwidthUsed: 267 }),
    collectedAt: new Date(),
    ...overrides,
  });
}

describe("compareBlocks", () => {
  it("returns empty for a single observation", () => {
    const result = compareBlocks([makeBlock()]);
    expect(result).toEqual([]);
  });

  it("returns empty when observations match", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB" });
    const result = compareBlocks([a, b]);
    expect(result).toEqual([]);
  });

  it("detects blockHash discrepancy", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB", blockHash: "different-hash" });
    const result = compareBlocks([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("blockHash");
    expect(result[0]!.sources).toHaveLength(2);
    expect(result[0]!.sources[0]!.value).toBe("0000000002faf080");
    expect(result[0]!.sources[1]!.value).toBe("different-hash");
  });

  it("detects multiple discrepancies", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({
      id: "b2",
      dataSourceId: "ds-2",
      collectionSource: "SourceB",
      blockHash: "different-hash",
      txCount: 5,
    });
    const result = compareBlocks([a, b]);
    expect(result).toHaveLength(2);
    const fields = result.map((d) => d.field);
    expect(fields).toContain("blockHash");
    expect(fields).toContain("txCount");
  });

  it("handles null vs non-null as discrepancy", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA", blockProducer: "TWitness" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB", blockProducer: null });
    const result = compareBlocks([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("blockProducer");
  });

  it("treats matching nulls as consistent", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA", sizeBytes: null });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB", sizeBytes: null });
    const result = compareBlocks([a, b]);
    expect(result).toEqual([]);
  });

  it("works with three or more observations", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB" });
    const c = makeBlock({ id: "b3", dataSourceId: "ds-3", collectionSource: "SourceC", txCount: 99 });
    const result = compareBlocks([a, b, c]);
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("txCount");
    expect(result[0]!.sources).toHaveLength(3);
  });
});

describe("compareTransactions", () => {
  it("returns empty for a single source", () => {
    const map = new Map([["SourceA", [makeTx()]]]);
    const result = compareTransactions(map);
    expect(result.discrepancies).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("returns empty when all transactions match", () => {
    const map = new Map([
      ["SourceA", [makeTx({ id: "t1", dataSourceId: "ds-1" })]],
      ["SourceB", [makeTx({ id: "t2", dataSourceId: "ds-2" })]],
    ]);
    const result = compareTransactions(map);
    expect(result.discrepancies).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("detects missing transaction", () => {
    const map = new Map([
      ["SourceA", [makeTx({ id: "t1", dataSourceId: "ds-1" })]],
      ["SourceB", [] as BlockchainTransaction[]],
    ]);
    const result = compareTransactions(map);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.txHash).toBe("abc123");
    expect(result.missing[0]!.presentIn).toEqual(["SourceA"]);
    expect(result.missing[0]!.missingFrom).toEqual(["SourceB"]);
  });

  it("detects field discrepancy between transaction observations", () => {
    const map = new Map([
      ["SourceA", [makeTx({ id: "t1", dataSourceId: "ds-1", amount: "1000000" })]],
      ["SourceB", [makeTx({ id: "t2", dataSourceId: "ds-2", amount: "2000000" })]],
    ]);
    const result = compareTransactions(map);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.txHash).toBe("abc123");
    expect(result.discrepancies[0]!.fields).toHaveLength(1);
    expect(result.discrepancies[0]!.fields[0]!.field).toBe("amount");
  });

  it("reports both missing and discrepant transactions", () => {
    const map = new Map([
      [
        "SourceA",
        [
          makeTx({ id: "t1", dataSourceId: "ds-1", txHash: "tx-shared", fee: "100" }),
          makeTx({ id: "t3", dataSourceId: "ds-1", txHash: "tx-only-a" }),
        ],
      ],
      [
        "SourceB",
        [
          makeTx({ id: "t2", dataSourceId: "ds-2", txHash: "tx-shared", fee: "200" }),
        ],
      ],
    ]);
    const result = compareTransactions(map);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.txHash).toBe("tx-only-a");
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.txHash).toBe("tx-shared");
  });
});

describe("crossValidateBlock", () => {
  it("returns INSUFFICIENT_SOURCES for zero observations", () => {
    const result = crossValidateBlock(50_000_000, "net-1", [], new Map());
    expect(result.status).toBe("INSUFFICIENT_SOURCES");
    expect(result.sourceCount).toBe(0);
    expect(result.blockDiscrepancies).toEqual([]);
  });

  it("returns INSUFFICIENT_SOURCES for one observation", () => {
    const block = makeBlock();
    const txMap = new Map([[block.id, [makeTx()]]]);
    const result = crossValidateBlock(50_000_000, "net-1", [block], txMap);
    expect(result.status).toBe("INSUFFICIENT_SOURCES");
    expect(result.sourceCount).toBe(1);
    expect(result.sources).toEqual(["SourceA"]);
  });

  it("returns CONSISTENT when two sources agree", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB" });
    const txMap = new Map([
      [a.id, [makeTx({ id: "t1", dataSourceId: "ds-1" })]],
      [b.id, [makeTx({ id: "t2", dataSourceId: "ds-2" })]],
    ]);
    const result = crossValidateBlock(50_000_000, "net-1", [a, b], txMap);
    expect(result.status).toBe("CONSISTENT");
    expect(result.sourceCount).toBe(2);
    expect(result.sources).toEqual(["SourceA", "SourceB"]);
    expect(result.blockDiscrepancies).toEqual([]);
    expect(result.transactionDiscrepancies).toEqual([]);
    expect(result.missingTransactions).toEqual([]);
  });

  it("returns DISCREPANCY for block-level difference", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB", blockHash: "bad-hash" });
    const txMap = new Map([
      [a.id, [makeTx({ id: "t1", dataSourceId: "ds-1" })]],
      [b.id, [makeTx({ id: "t2", dataSourceId: "ds-2" })]],
    ]);
    const result = crossValidateBlock(50_000_000, "net-1", [a, b], txMap);
    expect(result.status).toBe("DISCREPANCY");
    expect(result.blockDiscrepancies).toHaveLength(1);
  });

  it("returns DISCREPANCY for transaction-level difference", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA" });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB" });
    const txMap = new Map([
      [a.id, [makeTx({ id: "t1", dataSourceId: "ds-1", amount: "1000000" })]],
      [b.id, [makeTx({ id: "t2", dataSourceId: "ds-2", amount: "9999999" })]],
    ]);
    const result = crossValidateBlock(50_000_000, "net-1", [a, b], txMap);
    expect(result.status).toBe("DISCREPANCY");
    expect(result.transactionDiscrepancies).toHaveLength(1);
  });

  it("returns DISCREPANCY for missing transaction", () => {
    const a = makeBlock({ id: "b1", dataSourceId: "ds-1", collectionSource: "SourceA", txCount: 1 });
    const b = makeBlock({ id: "b2", dataSourceId: "ds-2", collectionSource: "SourceB", txCount: 0 });
    const txMap = new Map([
      [a.id, [makeTx({ id: "t1", dataSourceId: "ds-1" })]],
      [b.id, [] as BlockchainTransaction[]],
    ]);
    const result = crossValidateBlock(50_000_000, "net-1", [a, b], txMap);
    expect(result.status).toBe("DISCREPANCY");
    expect(result.missingTransactions).toHaveLength(1);
    expect(result.missingTransactions[0]!.txHash).toBe("abc123");
  });

  it("includes validatedAt timestamp", () => {
    const before = new Date();
    const result = crossValidateBlock(50_000_000, "net-1", [], new Map());
    const after = new Date();
    expect(result.validatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.validatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
