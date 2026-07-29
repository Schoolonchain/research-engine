import { describe, expect, it } from "vitest";

import {
  METRIC_CATEGORIES,
  METRIC_CONFIDENCES,
  createMetricRecord,
  createMetricBatch,
} from "../src/blockchain/metric-types.js";

describe("metric-types", () => {
  it("defines 16 categories matching the catalog", () => {
    expect(METRIC_CATEGORIES).toHaveLength(16);
    expect(METRIC_CATEGORIES).toContain("NETWORK");
    expect(METRIC_CATEGORIES).toContain("DEFI");
    expect(METRIC_CATEGORIES).toContain("EXCHANGE_FLOW");
    expect(METRIC_CATEGORIES).toContain("DEVELOPER");
  });

  it("defines 3 confidence levels", () => {
    expect(METRIC_CONFIDENCES).toEqual(["DIRECT", "DERIVED", "ESTIMATED"]);
  });

  it("createMetricRecord generates unique IDs", () => {
    const a = createMetricRecord({
      category: "NETWORK",
      metricName: "energy_fee_sun",
      blockchain: "tron",
      source: "trongrid",
      value: 280,
      unit: "SUN",
      timestamp: new Date(),
      blockHeight: null,
      confidence: "DIRECT",
      address: null,
      rawData: null,
      metadata: null,
    });
    const b = createMetricRecord({
      category: "NETWORK",
      metricName: "energy_fee_sun",
      blockchain: "tron",
      source: "trongrid",
      value: 280,
      unit: "SUN",
      timestamp: new Date(),
      blockHeight: null,
      confidence: "DIRECT",
      address: null,
      rawData: null,
      metadata: null,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("createMetricRecord freezes the result", () => {
    const record = createMetricRecord({
      category: "TOKEN",
      metricName: "token_price_usd",
      blockchain: "tron",
      source: "tronscan",
      value: 0.15,
      unit: "USD",
      timestamp: new Date(),
      blockHeight: null,
      confidence: "DIRECT",
      address: "TAddr",
      rawData: null,
      metadata: { symbol: "TRX" },
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("createMetricBatch shares common fields", () => {
    const ts = new Date("2025-01-01");
    const records = createMetricBatch(
      { blockchain: "tron", source: "test", timestamp: ts, blockHeight: 100 },
      [
        { category: "NETWORK", metricName: "a", value: 1, unit: "x", confidence: "DIRECT" },
        { category: "NETWORK", metricName: "b", value: 2, unit: "y", confidence: "DERIVED" },
      ],
    );
    expect(records).toHaveLength(2);
    expect(records[0]!.blockchain).toBe("tron");
    expect(records[0]!.blockHeight).toBe(100);
    expect(records[1]!.source).toBe("test");
    expect(records[0]!.address).toBeNull();
    expect(records[1]!.rawData).toBeNull();
  });

  it("createMetricBatch propagates address and metadata", () => {
    const records = createMetricBatch(
      { blockchain: "eth", source: "s", timestamp: new Date(), blockHeight: null },
      [
        {
          category: "RESOURCE",
          metricName: "x",
          value: 99,
          unit: "u",
          confidence: "DIRECT",
          address: "0xAddr",
          metadata: { note: "test" },
        },
      ],
    );
    expect(records[0]!.address).toBe("0xAddr");
    expect(records[0]!.metadata).toEqual({ note: "test" });
  });
});
