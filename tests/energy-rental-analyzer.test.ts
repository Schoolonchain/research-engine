import { describe, expect, it } from "vitest";

import { EnergyRentalAnalyzer } from "../src/blockchain/energy-rental-analyzer.js";
import type {
  EnergyRentalMarketData,
  PlatformActivity,
  EnergyRentalPlatform,
} from "../src/blockchain/energy-rental-collector.js";
import type { TronNetworkMetrics } from "../src/blockchain/network-metrics-collector.js";

function makePlatform(overrides: Partial<EnergyRentalPlatform> = {}): EnergyRentalPlatform {
  return {
    name: "TestPlatform",
    paymentAddress: "TTestAddr",
    ...overrides,
  };
}

function makeActivity(overrides: Partial<PlatformActivity> = {}): PlatformActivity {
  return {
    platform: makePlatform(),
    accountBalance: 1000,
    outgoingTransfers: [],
    incomingTransfers: [],
    delegation: {
      delegatedToCount: 5,
      receivedFromCount: 10,
      delegatedToAddresses: [],
      receivedFromAddresses: [],
    },
    resources: {
      energyLimit: 1_000_000,
      energyUsed: 500_000,
      bandwidthLimit: 5_000,
      bandwidthUsed: 1_000,
    },
    outgoingVolume: 50_000,
    incomingVolume: 60_000,
    uniquePayees: 20,
    uniquePayers: 30,
    ...overrides,
  };
}

function makeRentalData(overrides: Partial<EnergyRentalMarketData> = {}): EnergyRentalMarketData {
  return {
    platforms: [],
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function makeNetworkMetrics(overrides: Partial<TronNetworkMetrics> = {}): TronNetworkMetrics {
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

describe("EnergyRentalAnalyzer", () => {
  const analyzer = new EnergyRentalAnalyzer();

  describe("platform volume", () => {
    it("flags high volume platform (>1M TRX)", () => {
      const data = makeRentalData({
        platforms: [makeActivity({ outgoingVolume: 600_000, incomingVolume: 500_000 })],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      const f = findings.find((f) => f.category === "energy-rental-high-volume");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("INFO");
    });

    it("flags outflow imbalance (outgoing > 1.5x incoming)", () => {
      const data = makeRentalData({
        platforms: [makeActivity({ outgoingVolume: 300_000, incomingVolume: 100_000 })],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      const f = findings.find((f) => f.category === "energy-rental-outflow-imbalance");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });

    it("does not flag balanced volume", () => {
      const data = makeRentalData({
        platforms: [makeActivity({ outgoingVolume: 100_000, incomingVolume: 90_000 })],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      expect(findings.find((f) => f.category === "energy-rental-outflow-imbalance")).toBeUndefined();
    });
  });

  describe("delegation concentration", () => {
    it("flags large provider pool (>50 providers)", () => {
      const data = makeRentalData({
        platforms: [
          makeActivity({
            delegation: {
              delegatedToCount: 10,
              receivedFromCount: 60,
              delegatedToAddresses: [],
              receivedFromAddresses: [],
            },
          }),
        ],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      const f = findings.find((f) => f.category === "energy-rental-provider-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("flags large consumer base (>100 consumers)", () => {
      const data = makeRentalData({
        platforms: [
          makeActivity({
            delegation: {
              delegatedToCount: 150,
              receivedFromCount: 20,
              delegatedToAddresses: [],
              receivedFromAddresses: [],
            },
          }),
        ],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      const f = findings.find((f) => f.category === "energy-rental-consumer-base");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });
  });

  describe("payment patterns", () => {
    it("flags irregular payments (max > 10x average)", () => {
      const transfers = Array.from({ length: 10 }, (_, i) => ({
        txId: `t${i}`,
        from: "TPlat",
        to: `TProv${i}`,
        amount: 100,
        timestamp: i,
      }));
      transfers.push({ txId: "tbig", from: "TPlat", to: "TWhale", amount: 50_000, timestamp: 11 });
      const data = makeRentalData({
        platforms: [makeActivity({ outgoingTransfers: transfers })],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      const f = findings.find((f) => f.category === "energy-rental-irregular-payment");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("LOW");
    });

    it("does not flag consistent payments", () => {
      const transfers = Array.from({ length: 10 }, (_, i) => ({
        txId: `t${i}`,
        from: "TPlat",
        to: `TProv${i}`,
        amount: 100 + i * 5,
        timestamp: i,
      }));
      const data = makeRentalData({
        platforms: [makeActivity({ outgoingTransfers: transfers })],
      });
      const findings = analyzer.analyze(data, makeNetworkMetrics());
      expect(findings.find((f) => f.category === "energy-rental-irregular-payment")).toBeUndefined();
    });
  });

  describe("market comparison", () => {
    it("produces energy cost comparison finding", () => {
      const data = makeRentalData({
        platforms: [makeActivity()],
      });
      const metrics = makeNetworkMetrics();
      const findings = analyzer.analyze(data, metrics);
      const f = findings.find((f) => f.category === "energy-cost-comparison");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("INFO");
      expect(f!.description).toContain("100k energy");
    });

    it("computes correct market comparison values", () => {
      const data = makeRentalData({
        platforms: [
          makeActivity({
            outgoingVolume: 100_000,
            uniquePayees: 50,
            delegation: {
              delegatedToCount: 200,
              receivedFromCount: 30,
              delegatedToAddresses: [],
              receivedFromAddresses: [],
            },
          }),
        ],
      });
      const metrics = makeNetworkMetrics({
        energy: {
          energyFee: 420,
          totalEnergyLimit: 50_000_000_000,
          totalEnergyWeight: 30_000_000_000_000,
          dynamicIncreaseFactor: 0,
          dynamicMaxFactor: 0,
          energyYieldPerTrx: 1.67,
        },
      });

      const comparison = analyzer.computeMarketComparison(data, metrics);
      expect(comparison.directFeeCostPer100k).toBe(42);
      expect(comparison.selfStakeRequiredFor100k).toBeCloseTo(59880.24, 0);
      expect(comparison.rentalMarketVolume).toBe(100_000);
      expect(comparison.rentalProviderCount).toBe(50);
      expect(comparison.rentalConsumerCount).toBe(200);
    });
  });

  describe("rental market size", () => {
    it("flags when rental platforms hold >5% of network energy as HIGH", () => {
      const data = makeRentalData({
        platforms: [
          makeActivity({
            resources: {
              energyLimit: 3_000_000_000,
              energyUsed: 1_000_000_000,
              bandwidthLimit: 0,
              bandwidthUsed: 0,
            },
          }),
        ],
      });
      const metrics = makeNetworkMetrics();
      const findings = analyzer.analyze(data, metrics);
      const f = findings.find((f) => f.category === "energy-rental-market-share");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("flags when rental platforms hold >1% as MEDIUM", () => {
      const data = makeRentalData({
        platforms: [
          makeActivity({
            resources: {
              energyLimit: 600_000_000,
              energyUsed: 200_000_000,
              bandwidthLimit: 0,
              bandwidthUsed: 0,
            },
          }),
        ],
      });
      const metrics = makeNetworkMetrics();
      const findings = analyzer.analyze(data, metrics);
      const f = findings.find((f) => f.category === "energy-rental-market-share");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });

    it("does not flag negligible market share", () => {
      const data = makeRentalData({
        platforms: [
          makeActivity({
            resources: {
              energyLimit: 100_000,
              energyUsed: 50_000,
              bandwidthLimit: 0,
              bandwidthUsed: 0,
            },
          }),
        ],
      });
      const metrics = makeNetworkMetrics();
      const findings = analyzer.analyze(data, metrics);
      expect(findings.find((f) => f.category === "energy-rental-market-share")).toBeUndefined();
    });
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("energy-rental");
    expect(analyzer.modules).toContain("MERCADO");
    expect(analyzer.modules).toContain("INFRA");
  });

  it("handles empty platform list", () => {
    const data = makeRentalData({ platforms: [] });
    const findings = analyzer.analyze(data, makeNetworkMetrics());
    expect(findings).toHaveLength(0);
  });
});
