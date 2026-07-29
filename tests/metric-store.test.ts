import { describe, expect, it, beforeEach } from "vitest";

import { InMemoryMetricStore } from "../src/blockchain/in-memory-metric-store.js";
import { createMetricRecord } from "../src/blockchain/metric-types.js";
import type { MetricRecord } from "../src/blockchain/metric-types.js";

function makeRecord(overrides: Partial<Omit<MetricRecord, "id">> = {}): MetricRecord {
  return createMetricRecord({
    category: "NETWORK",
    metricName: "energy_fee_sun",
    blockchain: "tron",
    source: "trongrid",
    value: 280,
    unit: "SUN",
    timestamp: new Date("2025-06-01T00:00:00Z"),
    blockHeight: null,
    confidence: "DIRECT",
    address: null,
    rawData: null,
    metadata: null,
    ...overrides,
  });
}

describe("InMemoryMetricStore", () => {
  let store: InMemoryMetricStore;

  beforeEach(() => {
    store = new InMemoryMetricStore();
  });

  describe("insert and query", () => {
    it("inserts and retrieves a single record", async () => {
      const record = makeRecord();
      await store.insert(record);

      const results = await store.query({ blockchain: "tron" });
      expect(results).toHaveLength(1);
      expect(results[0]!.metricName).toBe("energy_fee_sun");
    });

    it("inserts batch and counts correctly", async () => {
      const records = [
        makeRecord({ metricName: "a" }),
        makeRecord({ metricName: "b" }),
        makeRecord({ metricName: "c" }),
      ];
      await store.insertBatch(records);

      expect(store.size).toBe(3);
      const count = await store.count({ blockchain: "tron" });
      expect(count).toBe(3);
    });

    it("filters by category", async () => {
      await store.insertBatch([
        makeRecord({ category: "NETWORK", metricName: "n1" }),
        makeRecord({ category: "TOKEN", metricName: "t1" }),
        makeRecord({ category: "NETWORK", metricName: "n2" }),
      ]);

      const results = await store.query({ category: "NETWORK" });
      expect(results).toHaveLength(2);
    });

    it("filters by metricName", async () => {
      await store.insertBatch([
        makeRecord({ metricName: "energy_fee_sun", value: 280 }),
        makeRecord({ metricName: "energy_fee_sun", value: 300 }),
        makeRecord({ metricName: "total_energy_limit", value: 50_000 }),
      ]);

      const results = await store.query({ blockchain: "tron", metricName: "energy_fee_sun" });
      expect(results).toHaveLength(2);
    });

    it("filters by address", async () => {
      await store.insertBatch([
        makeRecord({ address: "TAddr1", metricName: "balance" }),
        makeRecord({ address: "TAddr2", metricName: "balance" }),
        makeRecord({ address: "TAddr1", metricName: "energy" }),
      ]);

      const results = await store.query({ address: "TAddr1" });
      expect(results).toHaveLength(2);
    });

    it("filters by source", async () => {
      await store.insertBatch([
        makeRecord({ source: "trongrid" }),
        makeRecord({ source: "tronscan" }),
      ]);

      const results = await store.query({ source: "tronscan" });
      expect(results).toHaveLength(1);
    });

    it("filters by time range", async () => {
      await store.insertBatch([
        makeRecord({ timestamp: new Date("2025-01-01") }),
        makeRecord({ timestamp: new Date("2025-06-01") }),
        makeRecord({ timestamp: new Date("2025-12-01") }),
      ]);

      const results = await store.query({
        from: new Date("2025-03-01"),
        to: new Date("2025-09-01"),
      });
      expect(results).toHaveLength(1);
    });

    it("applies limit", async () => {
      await store.insertBatch([
        makeRecord({ metricName: "a" }),
        makeRecord({ metricName: "b" }),
        makeRecord({ metricName: "c" }),
      ]);

      const results = await store.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("returns results sorted newest first", async () => {
      await store.insertBatch([
        makeRecord({ timestamp: new Date("2025-01-01"), value: 1 }),
        makeRecord({ timestamp: new Date("2025-12-01"), value: 3 }),
        makeRecord({ timestamp: new Date("2025-06-01"), value: 2 }),
      ]);

      const results = await store.query({});
      expect(results[0]!.value).toBe(3);
      expect(results[2]!.value).toBe(1);
    });
  });

  describe("latest", () => {
    it("returns the most recent record", async () => {
      await store.insertBatch([
        makeRecord({ timestamp: new Date("2025-01-01"), value: 200 }),
        makeRecord({ timestamp: new Date("2025-06-01"), value: 280 }),
        makeRecord({ timestamp: new Date("2025-03-01"), value: 250 }),
      ]);

      const latest = await store.latest("tron", "energy_fee_sun");
      expect(latest).not.toBeNull();
      expect(latest!.value).toBe(280);
    });

    it("returns null when no records exist", async () => {
      const latest = await store.latest("tron", "nonexistent");
      expect(latest).toBeNull();
    });

    it("filters by address when provided", async () => {
      await store.insertBatch([
        makeRecord({ address: "TAddr1", timestamp: new Date("2025-06-01"), value: 100 }),
        makeRecord({ address: "TAddr2", timestamp: new Date("2025-12-01"), value: 999 }),
      ]);

      const latest = await store.latest("tron", "energy_fee_sun", "TAddr1");
      expect(latest!.value).toBe(100);
    });
  });

  describe("categories", () => {
    it("returns distinct categories for a blockchain", async () => {
      await store.insertBatch([
        makeRecord({ category: "NETWORK", blockchain: "tron" }),
        makeRecord({ category: "TOKEN", blockchain: "tron" }),
        makeRecord({ category: "NETWORK", blockchain: "tron" }),
        makeRecord({ category: "RESOURCE", blockchain: "ethereum" }),
      ]);

      const cats = await store.categories("tron");
      expect(cats).toHaveLength(2);
      expect(cats).toContain("NETWORK");
      expect(cats).toContain("TOKEN");
    });
  });

  describe("clear", () => {
    it("removes all records", async () => {
      await store.insertBatch([makeRecord(), makeRecord()]);
      expect(store.size).toBe(2);
      store.clear();
      expect(store.size).toBe(0);
      const results = await store.query({});
      expect(results).toHaveLength(0);
    });
  });

  describe("multi-blockchain", () => {
    it("isolates queries by blockchain", async () => {
      await store.insertBatch([
        makeRecord({ blockchain: "tron", metricName: "fee", value: 280 }),
        makeRecord({ blockchain: "ethereum", metricName: "fee", value: 21000 }),
        makeRecord({ blockchain: "solana", metricName: "fee", value: 5000 }),
      ]);

      const tron = await store.query({ blockchain: "tron" });
      expect(tron).toHaveLength(1);

      const eth = await store.latest("ethereum", "fee");
      expect(eth!.value).toBe(21000);
    });
  });
});
