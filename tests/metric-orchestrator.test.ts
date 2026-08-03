import { describe, expect, it, beforeEach } from "vitest";

import { InMemoryMetricStore } from "../src/blockchain/in-memory-metric-store.js";
import { MetricCollectionOrchestrator } from "../src/blockchain/metric-orchestrator.js";
import type { TronNetworkMetrics } from "../src/blockchain/network-metrics-collector.js";
import type { ResourceRankingsData } from "../src/blockchain/resource-rankings-collector.js";
import type { Trc20RankingsData } from "../src/blockchain/trc20-rankings-collector.js";
import type { OnchainAnalyticsResult } from "../src/blockchain/onchain-analytics.js";
import type { TronGovernanceData } from "../src/blockchain/tron-governance-collector.js";

function makeNetworkMetrics(): TronNetworkMetrics {
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
    topHolders: [
      { address: "TWhale1", balance: 1_000_000, totalFrozen: 500_000, power: 500_000 },
    ],
    stakingRatio: 0.5,
    collectedAt: new Date(),
    source: "trongrid",
  };
}

describe("MetricCollectionOrchestrator", () => {
  let store: InMemoryMetricStore;
  let orchestrator: MetricCollectionOrchestrator;

  beforeEach(() => {
    store = new InMemoryMetricStore();
    orchestrator = new MetricCollectionOrchestrator(store, "tron");
  });

  it("ingests network metrics and returns count", async () => {
    const count = await orchestrator.ingestNetworkMetrics(makeNetworkMetrics());
    expect(count).toBeGreaterThanOrEqual(16);
    expect(store.size).toBe(count);

    const latest = await store.latest("tron", "energy_fee_sun");
    expect(latest).not.toBeNull();
    expect(latest!.value).toBe(280);
  });

  it("ingests resource rankings", async () => {
    const data: ResourceRankingsData = {
      topStakers: [
        {
          address: "TS1",
          balance: 10_000,
          frozenForEnergy: 5_000,
          frozenForBandwidth: 2_000,
          votingPower: 7_000,
          energyLimit: 100_000,
          energyUsed: 50_000,
          bandwidthLimit: 5_000,
          bandwidthUsed: 1_000,
        },
      ],
      topEnergyConsumers: [],
      topEnergyDelegators: [],
      delegationSummaries: [
        { address: "TS1", delegatedToCount: 5, receivedFromCount: 10 },
      ],
      topContracts: [],
      collectedAt: new Date(),
      source: "trongrid",
    };

    const count = await orchestrator.ingestResourceRankings(data);
    expect(count).toBe(9);

    const cats = await store.categories("tron");
    expect(cats).toContain("RESOURCE");
  });

  it("ingests TRC20 rankings", async () => {
    const data: Trc20RankingsData = {
      topTokens: [
        {
          contractAddress: "TUSDT",
          name: "Tether",
          symbol: "USDT",
          decimals: 6,
          holderCount: 1_000_000,
          transferCount: 500_000_000,
          totalSupply: "10000000000",
          marketCap: 50_000_000_000,
          priceUsd: 1.0,
        },
      ],
      tokenAnalyses: [],
      collectedAt: new Date(),
      source: "tronscan",
    };

    const count = await orchestrator.ingestTrc20Rankings(data);
    expect(count).toBe(5);

    const latest = await store.latest("tron", "token_holder_count", "TUSDT");
    expect(latest!.value).toBe(1_000_000);
  });

  it("ingests analytics results", async () => {
    const data: OnchainAnalyticsResult = {
      deflation: {
        dailySrEmissionTrx: 460_800,
        dailyPartnerEmissionTrx: 4_608,
        totalDailyEmissionTrx: 465_408,
        annualEmissionTrx: 169_873_920,
        energyFeeSun: 280,
        estimatedDailyBurnTrx: 100_000,
        netDailyIssuanceTrx: 365_408,
        isDeflationary: false,
      },
      healthScore: {
        overall: 72,
        grade: "B",
        components: {
          stakingHealth: 100,
          decentralization: 60,
          energyMarket: 80,
          tokenDiversity: 50,
          emissionSustainability: 45,
        },
      },
      tokenVelocities: [],
      giniCoefficients: [],
    };

    const count = await orchestrator.ingestAnalytics(data, "test", new Date());
    expect(count).toBeGreaterThanOrEqual(14);

    const health = await store.latest("tron", "network_health_score");
    expect(health!.value).toBe(72);
  });

  it("ingests governance data", async () => {
    const data: TronGovernanceData = {
      witnesses: [
        {
          address: "TSR1",
          url: "https://sr1.example",
          isElected: true,
          voteCount: 500_000,
          totalProduced: 10_000,
          totalMissed: 50,
          productivityPct: 99.5,
          latestBlockNum: 60_000_000,
        },
      ],
      proposals: [],
      chainParameters: {},
      totalVotes: 5_000_000,
      electedCount: 27,
      collectedAt: new Date(),
      source: "trongrid",
    };

    const count = await orchestrator.ingestGovernance(data);
    expect(count).toBeGreaterThanOrEqual(10);

    const cats = await store.categories("tron");
    expect(cats).toContain("GOVERNANCE");
    expect(cats).toContain("VALIDATOR");
  });

  it("ingests findings", async () => {
    const findings = [
      {
        analyzerName: "test",
        module: "FUNDAMENTAL" as const,
        severity: "HIGH" as const,
        category: "network-emission-status",
        title: "Test",
        description: "Test finding",
        evidence: {},
        recommendation: null,
      },
    ];

    const count = await orchestrator.ingestFindings(findings);
    expect(count).toBe(1);
    expect(store.size).toBe(1);
  });

  it("accumulates records across multiple ingestions", async () => {
    await orchestrator.ingestNetworkMetrics(makeNetworkMetrics());
    const firstCount = store.size;

    await orchestrator.ingestNetworkMetrics(makeNetworkMetrics());
    expect(store.size).toBe(firstCount * 2);
  });

  it("queries across all ingested data", async () => {
    await orchestrator.ingestNetworkMetrics(makeNetworkMetrics());
    await orchestrator.ingestFindings([
      {
        analyzerName: "test",
        module: "FUNDAMENTAL" as const,
        severity: "INFO" as const,
        category: "network-health-score",
        title: "Health",
        description: "Good",
        evidence: {},
        recommendation: null,
      },
    ]);

    const all = await store.query({ blockchain: "tron" });
    expect(all.length).toBeGreaterThan(16);

    const ecosystem = await store.query({ blockchain: "tron", category: "ECOSYSTEM" });
    expect(ecosystem.length).toBeGreaterThanOrEqual(1);
  });
});
