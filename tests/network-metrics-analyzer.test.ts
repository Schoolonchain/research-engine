import { describe, expect, it } from "vitest";

import { NetworkMetricsAnalyzer } from "../src/blockchain/network-metrics-analyzer.js";
import type { TronNetworkMetrics } from "../src/blockchain/network-metrics-collector.js";

function makeMetrics(overrides: Partial<TronNetworkMetrics> = {}): TronNetworkMetrics {
  return {
    energy: {
      energyFee: 280,
      totalEnergyLimit: 50_000_000_000,
      totalEnergyWeight: 30_000_000_000_000,
      dynamicIncreaseFactor: 0,
      dynamicMaxFactor: 0,
      energyYieldPerTrx: 1.67,
    },
    bandwidth: {
      transactionFee: 1000,
      totalNetLimit: 43_200_000_000,
      totalNetWeight: 15_000_000_000_000,
      bandwidthYieldPerTrx: 2.88,
    },
    economics: {
      createAccountFee: 100_000,
      burnTrxAmount: 1_000_000,
      witnessPayPerBlock: 16_000_000,
      witness127PayPerBlock: 160_000,
      maintenanceIntervalMs: 21_600_000,
      proposalExpireTime: 259_200_000,
    },
    topHolders: [],
    staking: {
      stakedForEnergyTrx: 30_000_000_000,
      stakedForBandwidthTrx: 15_000_000_000,
      totalStakedTrx: 45_000_000_000,
      totalSupplyTrx: 100_000_000_000,
      supplySource: "protocol-constant" as const,
    },
    stakingRatio: 0.5,
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

describe("NetworkMetricsAnalyzer", () => {
  const analyzer = new NetworkMetricsAnalyzer();

  describe("energy market", () => {
    it("flags high energy price >= 420", () => {
      const metrics = makeMetrics({
        energy: { ...makeMetrics().energy, energyFee: 420 },
      });
      const findings = analyzer.analyze(metrics);

      const highPrice = findings.find((f) => f.category === "high-energy-price");
      expect(highPrice).toBeDefined();
      expect(highPrice!.severity).toBe("MEDIUM");
    });

    it("flags very high energy price >= 1000 as HIGH", () => {
      const metrics = makeMetrics({
        energy: { ...makeMetrics().energy, energyFee: 1200 },
      });
      const findings = analyzer.analyze(metrics);

      const highPrice = findings.find((f) => f.category === "high-energy-price");
      expect(highPrice).toBeDefined();
      expect(highPrice!.severity).toBe("HIGH");
    });

    it("does not flag normal energy price", () => {
      const metrics = makeMetrics({
        energy: { ...makeMetrics().energy, energyFee: 280 },
      });
      const findings = analyzer.analyze(metrics);

      expect(findings.find((f) => f.category === "high-energy-price")).toBeUndefined();
    });

    it("flags energy oversaturation when weight/limit > 10", () => {
      const metrics = makeMetrics({
        energy: {
          ...makeMetrics().energy,
          totalEnergyWeight: 600_000_000_000,
          totalEnergyLimit: 50_000_000_000,
        },
      });
      const findings = analyzer.analyze(metrics);

      const oversat = findings.find((f) => f.category === "energy-oversaturation");
      expect(oversat).toBeDefined();
      expect(oversat!.severity).toBe("MEDIUM");
    });
  });

  describe("bandwidth market", () => {
    it("flags high bandwidth price >= 1000", () => {
      const metrics = makeMetrics({
        bandwidth: { ...makeMetrics().bandwidth, transactionFee: 1500 },
      });
      const findings = analyzer.analyze(metrics);

      const highBw = findings.find((f) => f.category === "high-bandwidth-price");
      expect(highBw).toBeDefined();
      expect(highBw!.severity).toBe("MEDIUM");
    });

    it("does not flag normal bandwidth price", () => {
      const metrics = makeMetrics({
        bandwidth: { ...makeMetrics().bandwidth, transactionFee: 500 },
      });
      const findings = analyzer.analyze(metrics);

      expect(findings.find((f) => f.category === "high-bandwidth-price")).toBeUndefined();
    });
  });

  describe("dynamic energy pricing", () => {
    it("flags active dynamic energy pricing", () => {
      const metrics = makeMetrics({
        energy: {
          ...makeMetrics().energy,
          energyFee: 280,
          dynamicIncreaseFactor: 2000,
          dynamicMaxFactor: 12,
        },
      });
      const findings = analyzer.analyze(metrics);

      const dynamic = findings.find((f) => f.category === "dynamic-energy-pricing");
      expect(dynamic).toBeDefined();
      expect(dynamic!.severity).toBe("HIGH");
    });

    it("flags low severity when max factor < 10", () => {
      const metrics = makeMetrics({
        energy: {
          ...makeMetrics().energy,
          dynamicIncreaseFactor: 500,
          dynamicMaxFactor: 3,
        },
      });
      const findings = analyzer.analyze(metrics);

      const dynamic = findings.find((f) => f.category === "dynamic-energy-pricing");
      expect(dynamic).toBeDefined();
      expect(dynamic!.severity).toBe("LOW");
    });

    it("does not flag when dynamic pricing disabled", () => {
      const metrics = makeMetrics({
        energy: {
          ...makeMetrics().energy,
          dynamicIncreaseFactor: 0,
          dynamicMaxFactor: 0,
        },
      });
      const findings = analyzer.analyze(metrics);

      expect(findings.find((f) => f.category === "dynamic-energy-pricing")).toBeUndefined();
    });
  });

  describe("economics", () => {
    it("flags SR reward disparity > 20x", () => {
      const metrics = makeMetrics({
        economics: {
          ...makeMetrics().economics,
          witnessPayPerBlock: 16_000_000,
          witness127PayPerBlock: 160_000,
        },
      });
      const findings = analyzer.analyze(metrics);

      const disparity = findings.find((f) => f.category === "sr-reward-disparity");
      expect(disparity).toBeDefined();
      expect(disparity!.severity).toBe("LOW");
    });

    it("does not flag equal rewards", () => {
      const metrics = makeMetrics({
        economics: {
          ...makeMetrics().economics,
          witnessPayPerBlock: 1_000_000,
          witness127PayPerBlock: 500_000,
        },
      });
      const findings = analyzer.analyze(metrics);

      expect(findings.find((f) => f.category === "sr-reward-disparity")).toBeUndefined();
    });

    it("flags account creation cost >= 1 TRX", () => {
      const metrics = makeMetrics({
        economics: {
          ...makeMetrics().economics,
          createAccountFee: 1_000_000,
        },
      });
      const findings = analyzer.analyze(metrics);

      const cost = findings.find((f) => f.category === "account-creation-cost");
      expect(cost).toBeDefined();
      expect(cost!.severity).toBe("INFO");
    });
  });

  describe("holder concentration", () => {
    it("flags whale concentration > 50% as CRITICAL", () => {
      const metrics = makeMetrics({
        topHolders: [
          { address: "TWhale1", balance: 70_000_000, totalFrozen: 10_000_000, power: 10_000_000 },
          { address: "TWhale2", balance: 20_000_000, totalFrozen: 5_000_000, power: 5_000_000 },
          { address: "TWhale3", balance: 10_000_000, totalFrozen: 0, power: 0 },
        ],
      });
      const findings = analyzer.analyze(metrics);

      const whale = findings.find((f) => f.category === "whale-concentration");
      expect(whale).toBeDefined();
      expect(whale!.severity).toBe("CRITICAL");
    });

    it("flags whale concentration > 30% as HIGH", () => {
      const metrics = makeMetrics({
        topHolders: [
          { address: "TWhale1", balance: 40_000_000, totalFrozen: 10_000_000, power: 10_000_000 },
          { address: "TWhale2", balance: 35_000_000, totalFrozen: 5_000_000, power: 5_000_000 },
          { address: "TWhale3", balance: 25_000_000, totalFrozen: 0, power: 0 },
        ],
      });
      const findings = analyzer.analyze(metrics);

      const whale = findings.find((f) => f.category === "whale-concentration");
      expect(whale).toBeDefined();
      expect(whale!.severity).toBe("HIGH");
    });

    it("does not flag well-distributed holders", () => {
      const metrics = makeMetrics({
        topHolders: [
          { address: "TH1", balance: 25_000_000, totalFrozen: 5_000_000, power: 5_000_000 },
          { address: "TH2", balance: 25_000_000, totalFrozen: 5_000_000, power: 5_000_000 },
          { address: "TH3", balance: 25_000_000, totalFrozen: 5_000_000, power: 5_000_000 },
          { address: "TH4", balance: 25_000_000, totalFrozen: 5_000_000, power: 5_000_000 },
        ],
      });
      const findings = analyzer.analyze(metrics);

      expect(findings.find((f) => f.category === "whale-concentration")).toBeUndefined();
    });

    it("flags large non-staking holders", () => {
      const holders = Array.from({ length: 10 }, (_, i) => ({
        address: `THolder${i}`,
        balance: 2_000_000,
        totalFrozen: i < 4 ? 0 : 500_000,
        power: i < 4 ? 0 : 500_000,
      }));
      const metrics = makeMetrics({ topHolders: holders });
      const findings = analyzer.analyze(metrics);

      const nonStaking = findings.find((f) => f.category === "whale-non-staking");
      expect(nonStaking).toBeDefined();
      expect(nonStaking!.severity).toBe("MEDIUM");
    });

    it("skips holder analysis with fewer than 2 holders", () => {
      const metrics = makeMetrics({
        topHolders: [
          { address: "TOnly", balance: 100_000_000, totalFrozen: 0, power: 0 },
        ],
      });
      const findings = analyzer.analyze(metrics);

      expect(findings.find((f) => f.category === "whale-concentration")).toBeUndefined();
    });
  });

  describe("staking yield", () => {
    it("flags low energy staking yield < 3%", () => {
      const metrics = makeMetrics({
        energy: {
          energyFee: 10,
          totalEnergyLimit: 50_000_000_000,
          totalEnergyWeight: 30_000_000_000_000,
          dynamicIncreaseFactor: 0,
          dynamicMaxFactor: 0,
          energyYieldPerTrx: 0.5,
        },
      });
      const findings = analyzer.analyze(metrics);

      const lowYield = findings.find((f) => f.category === "low-energy-staking-yield");
      expect(lowYield).toBeDefined();
      expect(lowYield!.severity).toBe("LOW");
    });

    it("flags unusually high energy staking yield > 50%", () => {
      const metrics = makeMetrics({
        energy: {
          energyFee: 5000,
          totalEnergyLimit: 50_000_000_000,
          totalEnergyWeight: 1_000_000_000,
          dynamicIncreaseFactor: 0,
          dynamicMaxFactor: 0,
          energyYieldPerTrx: 50000,
        },
      });
      const findings = analyzer.analyze(metrics);

      const highYield = findings.find((f) => f.category === "high-energy-staking-yield");
      expect(highYield).toBeDefined();
      expect(highYield!.severity).toBe("MEDIUM");
    });

    it("flags resource yield imbalance", () => {
      const metrics = makeMetrics({
        energy: { ...makeMetrics().energy, energyYieldPerTrx: 30 },
        bandwidth: { ...makeMetrics().bandwidth, bandwidthYieldPerTrx: 2 },
      });
      const findings = analyzer.analyze(metrics);

      const imbalance = findings.find((f) => f.category === "resource-yield-imbalance");
      expect(imbalance).toBeDefined();
      expect(imbalance!.severity).toBe("INFO");
    });
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("network-metrics");
    expect(analyzer.modules).toContain("FUNDAMENTAL");
    expect(analyzer.modules).toContain("MERCADO");
    expect(analyzer.modules).toContain("INFRA");
  });

  it("produces no findings for healthy metrics", () => {
    const metrics = makeMetrics({
      energy: {
        energyFee: 280,
        totalEnergyLimit: 50_000_000_000,
        totalEnergyWeight: 100_000_000_000,
        dynamicIncreaseFactor: 0,
        dynamicMaxFactor: 0,
        energyYieldPerTrx: 1,
      },
      bandwidth: {
        transactionFee: 500,
        totalNetLimit: 43_200_000_000,
        totalNetWeight: 15_000_000_000_000,
        bandwidthYieldPerTrx: 1,
      },
      economics: {
        createAccountFee: 100_000,
        burnTrxAmount: 1_000_000,
        witnessPayPerBlock: 1_000_000,
        witness127PayPerBlock: 500_000,
        maintenanceIntervalMs: 21_600_000,
        proposalExpireTime: 259_200_000,
      },
      topHolders: [],
    });
    const findings = analyzer.analyze(metrics);
    expect(findings.map((f) => f.category)).toEqual([]);
  });
});
