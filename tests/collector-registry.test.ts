import { describe, expect, it } from "vitest";

import { TronCollectorRegistry } from "../src/blockchain/tron-collector-registry.js";
import type { TronCollector } from "../src/blockchain/tron-collector.js";
import type { DataSourceType } from "../src/blockchain/model.js";
import { BlockchainValidationError } from "../src/blockchain/errors.js";

function stubCollector(
  name: string,
  source: string,
  sourceType: DataSourceType = "API",
): TronCollector<string, string> {
  return {
    collectorName: name,
    sourceName: source,
    sourceType,
    async collect(target: string) { return `${name}:${target}`; },
    supports() { return true; },
  };
}

describe("TronCollectorRegistry", () => {
  describe("register and resolve", () => {
    it("registers and resolves a collector by type", () => {
      const registry = new TronCollectorRegistry();
      const collector = stubCollector("account-collector", "trongrid");

      registry.register("account", collector);
      const resolved = registry.resolve("account");

      expect(resolved).toBe(collector);
    });

    it("resolves by type and source name", () => {
      const registry = new TronCollectorRegistry();
      const trongrid = stubCollector("account-trongrid", "trongrid");
      const tronscan = stubCollector("account-tronscan", "tronscan");

      registry.register("account", trongrid);
      registry.register("account", tronscan);

      expect(registry.resolve("account", "tronscan")).toBe(tronscan);
      expect(registry.resolve("account", "trongrid")).toBe(trongrid);
    });

    it("returns first registered when no source specified", () => {
      const registry = new TronCollectorRegistry();
      const first = stubCollector("first", "source-a");
      const second = stubCollector("second", "source-b");

      registry.register("token", first);
      registry.register("token", second);

      expect(registry.resolve("token")).toBe(first);
    });

    it("throws on unregistered type", () => {
      const registry = new TronCollectorRegistry();

      expect(() => registry.resolve("nonexistent")).toThrow(BlockchainValidationError);
      expect(() => registry.resolve("nonexistent")).toThrow("No collectors registered");
    });

    it("throws on unregistered source name", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("col", "trongrid"));

      expect(() => registry.resolve("account", "tronscan")).toThrow(BlockchainValidationError);
      expect(() => registry.resolve("account", "tronscan")).toThrow("No collector from source");
    });

    it("prevents duplicate source registration for same type", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("first", "trongrid"));

      expect(() =>
        registry.register("account", stubCollector("second", "trongrid")),
      ).toThrow(BlockchainValidationError);
    });

    it("allows same source name for different types", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("account-col", "trongrid"));
      registry.register("token", stubCollector("token-col", "trongrid"));

      expect(registry.resolve("account", "trongrid").collectorName).toBe("account-col");
      expect(registry.resolve("token", "trongrid").collectorName).toBe("token-col");
    });
  });

  describe("all", () => {
    it("returns all collectors for a type", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("a", "src-a"));
      registry.register("account", stubCollector("b", "src-b"));

      const all = registry.all("account");
      expect(all).toHaveLength(2);
    });

    it("returns frozen array", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("a", "src-a"));

      const all = registry.all("account");
      expect(Object.isFrozen(all)).toBe(true);
    });

    it("returns empty array for unregistered type", () => {
      const registry = new TronCollectorRegistry();
      expect(registry.all("nonexistent")).toHaveLength(0);
    });
  });

  describe("canCollect", () => {
    it("returns true for registered types", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("a", "src-a"));

      expect(registry.canCollect("account")).toBe(true);
    });

    it("returns false for unregistered types", () => {
      const registry = new TronCollectorRegistry();

      expect(registry.canCollect("account")).toBe(false);
    });
  });

  describe("registeredTypes", () => {
    it("returns all registered type keys", () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubCollector("a", "src-a"));
      registry.register("token", stubCollector("b", "src-b"));
      registry.register("contract", stubCollector("c", "src-c"));

      const types = registry.registeredTypes();
      expect(types).toContain("account");
      expect(types).toContain("token");
      expect(types).toContain("contract");
      expect(types).toHaveLength(3);
    });

    it("returns frozen array", () => {
      const registry = new TronCollectorRegistry();
      expect(Object.isFrozen(registry.registeredTypes())).toBe(true);
    });

    it("returns empty for fresh registry", () => {
      const registry = new TronCollectorRegistry();
      expect(registry.registeredTypes()).toHaveLength(0);
    });
  });
});
