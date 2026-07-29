import { describe, expect, it } from "vitest";

import { ResourceRankingsAnalyzer } from "../src/blockchain/resource-rankings-analyzer.js";
import type { ResourceRankingsData, ResourceAccountData, DelegationSummary } from "../src/blockchain/resource-rankings-collector.js";

function makeStaker(overrides: Partial<ResourceAccountData> = {}): ResourceAccountData {
  return {
    address: "TDefault",
    balance: 100_000_000,
    frozenForEnergy: 50_000_000,
    frozenForBandwidth: 10_000_000,
    votingPower: 50_000,
    energyLimit: 10_000_000,
    energyUsed: 5_000_000,
    bandwidthLimit: 5_000,
    bandwidthUsed: 2_000,
    ...overrides,
  };
}

function makeDelegation(overrides: Partial<DelegationSummary> = {}): DelegationSummary {
  return {
    address: "TDefault",
    delegatedToCount: 0,
    receivedFromCount: 0,
    ...overrides,
  };
}

function makeData(overrides: Partial<ResourceRankingsData> = {}): ResourceRankingsData {
  return {
    topStakers: [],
    topEnergyConsumers: [],
    topEnergyDelegators: [],
    delegationSummaries: [],
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

describe("ResourceRankingsAnalyzer", () => {
  const analyzer = new ResourceRankingsAnalyzer();

  describe("energy concentration", () => {
    it("flags when top account holds >60% of energy as CRITICAL", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "TWhale", energyLimit: 80_000_000 }),
          makeStaker({ address: "TSmall1", energyLimit: 10_000_000 }),
          makeStaker({ address: "TSmall2", energyLimit: 10_000_000 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "energy-allocation-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("CRITICAL");
    });

    it("flags when top account holds >40% of energy as HIGH", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "TWhale", energyLimit: 50_000_000 }),
          makeStaker({ address: "TSmall1", energyLimit: 30_000_000 }),
          makeStaker({ address: "TSmall2", energyLimit: 20_000_000 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "energy-allocation-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("does not flag distributed energy allocation", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "T1", energyLimit: 30_000_000 }),
          makeStaker({ address: "T2", energyLimit: 30_000_000 }),
          makeStaker({ address: "T3", energyLimit: 40_000_000 }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "energy-allocation-concentration")).toBeUndefined();
    });
  });

  describe("energy utilization", () => {
    it("flags when 30%+ of large holders use <5% of energy", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "TActive1", energyLimit: 10_000_000, energyUsed: 5_000_000 }),
          makeStaker({ address: "TActive2", energyLimit: 10_000_000, energyUsed: 3_000_000 }),
          makeStaker({ address: "TIdle1", energyLimit: 10_000_000, energyUsed: 100 }),
          makeStaker({ address: "TIdle2", energyLimit: 10_000_000, energyUsed: 0 }),
          makeStaker({ address: "TIdle3", energyLimit: 10_000_000, energyUsed: 50 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "energy-underutilization");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });

    it("does not flag when most accounts use their energy", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "T1", energyLimit: 10_000_000, energyUsed: 5_000_000 }),
          makeStaker({ address: "T2", energyLimit: 10_000_000, energyUsed: 3_000_000 }),
          makeStaker({ address: "T3", energyLimit: 10_000_000, energyUsed: 8_000_000 }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "energy-underutilization")).toBeUndefined();
    });
  });

  describe("delegation patterns", () => {
    it("flags large delegator with >20 delegatees", () => {
      const data = makeData({
        delegationSummaries: [
          makeDelegation({ address: "TBigDel", delegatedToCount: 25 }),
          makeDelegation({ address: "TSmall1", delegatedToCount: 2 }),
          makeDelegation({ address: "TSmall2", delegatedToCount: 0 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "large-delegator");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("flags delegation sink receiving from >10 accounts", () => {
      const data = makeData({
        delegationSummaries: [
          makeDelegation({ address: "TSink", receivedFromCount: 15, delegatedToCount: 0 }),
          makeDelegation({ address: "T1", delegatedToCount: 1 }),
          makeDelegation({ address: "T2", delegatedToCount: 1 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "delegation-sink");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });

    it("flags low delegation participation >= 50%", () => {
      const data = makeData({
        delegationSummaries: [
          makeDelegation({ address: "T1", delegatedToCount: 0, receivedFromCount: 0 }),
          makeDelegation({ address: "T2", delegatedToCount: 0, receivedFromCount: 0 }),
          makeDelegation({ address: "T3", delegatedToCount: 5, receivedFromCount: 0 }),
          makeDelegation({ address: "T4", delegatedToCount: 0, receivedFromCount: 0 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "low-delegation-participation");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("LOW");
    });

    it("does not flag delegation when most stakers participate", () => {
      const data = makeData({
        delegationSummaries: [
          makeDelegation({ address: "T1", delegatedToCount: 5 }),
          makeDelegation({ address: "T2", receivedFromCount: 3 }),
          makeDelegation({ address: "T3", delegatedToCount: 2 }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "low-delegation-participation")).toBeUndefined();
    });
  });

  describe("staking imbalance", () => {
    it("flags extreme energy/bandwidth staking ratio", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "T1", frozenForEnergy: 100_000_000, frozenForBandwidth: 1_000_000 }),
          makeStaker({ address: "T2", frozenForEnergy: 80_000_000, frozenForBandwidth: 500_000 }),
          makeStaker({ address: "T3", frozenForEnergy: 50_000_000, frozenForBandwidth: 200_000 }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "staking-resource-imbalance");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("INFO");
    });

    it("does not flag balanced staking", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "T1", frozenForEnergy: 50_000_000, frozenForBandwidth: 10_000_000 }),
          makeStaker({ address: "T2", frozenForEnergy: 30_000_000, frozenForBandwidth: 5_000_000 }),
          makeStaker({ address: "T3", frozenForEnergy: 20_000_000, frozenForBandwidth: 8_000_000 }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "staking-resource-imbalance")).toBeUndefined();
    });
  });

  describe("non-participating stakers", () => {
    it("flags wealthy accounts not staking or voting", () => {
      const data = makeData({
        topStakers: [
          makeStaker({ address: "T1" }),
          makeStaker({ address: "T2" }),
          makeStaker({ address: "T3" }),
          makeStaker({ address: "T4" }),
          makeStaker({
            address: "TRich",
            balance: 50_000_000,
            frozenForEnergy: 0,
            frozenForBandwidth: 0,
            votingPower: 0,
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "wealthy-non-stakers");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });

    it("does not flag when all top accounts stake", () => {
      const stakers = Array.from({ length: 5 }, (_, i) =>
        makeStaker({ address: `T${i}` }),
      );
      const data = makeData({ topStakers: stakers });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "wealthy-non-stakers")).toBeUndefined();
    });
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("resource-rankings");
    expect(analyzer.modules).toContain("MERCADO");
    expect(analyzer.modules).toContain("INFRA");
    expect(analyzer.modules).toContain("FUNDAMENTAL");
  });

  it("produces no findings for healthy data", () => {
    const stakers = Array.from({ length: 5 }, (_, i) =>
      makeStaker({
        address: `T${i}`,
        energyLimit: 10_000_000 + i * 1_000_000,
        energyUsed: 5_000_000,
        frozenForEnergy: 50_000_000,
        frozenForBandwidth: 10_000_000,
      }),
    );
    const delegations = stakers.map((s) =>
      makeDelegation({ address: s.address, delegatedToCount: 3, receivedFromCount: 2 }),
    );
    const data = makeData({
      topStakers: stakers,
      delegationSummaries: delegations,
    });
    const findings = analyzer.analyze(data);
    expect(findings.map((f) => f.category)).toEqual([]);
  });
});
