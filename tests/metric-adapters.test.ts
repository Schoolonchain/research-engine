import { describe, expect, it } from "vitest";

import {
  networkMetricsToRecords,
  resourceRankingsToRecords,
  trc20RankingsToRecords,
  energyRentalToRecords,
  onchainAnalyticsToRecords,
  governanceToRecords,
  findingsToRecords,
} from "../src/blockchain/metric-adapters.js";
import type { TronNetworkMetrics } from "../src/blockchain/network-metrics-collector.js";
import type { ResourceRankingsData } from "../src/blockchain/resource-rankings-collector.js";
import type { Trc20RankingsData, Trc20TokenSummary } from "../src/blockchain/trc20-rankings-collector.js";
import type { EnergyRentalMarketData, PlatformActivity } from "../src/blockchain/energy-rental-collector.js";
import type { OnchainAnalyticsResult } from "../src/blockchain/onchain-analytics.js";
import type { TronGovernanceData } from "../src/blockchain/tron-governance-collector.js";
import type { AuditFinding } from "../src/blockchain/audit-analyzer.js";

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
    collectedAt: new Date("2025-06-01"),
    source: "trongrid",
  };
}

describe("metric-adapters", () => {
  describe("networkMetricsToRecords", () => {
    it("produces records for all network fields", () => {
      const records = networkMetricsToRecords(makeNetworkMetrics());

      expect(records.length).toBeGreaterThanOrEqual(16);

      const names = records.map((r) => r.metricName);
      expect(names).toContain("energy_fee_sun");
      expect(names).toContain("total_energy_limit");
      expect(names).toContain("staking_ratio");
      expect(names).toContain("witness_pay_per_block");
      expect(names).toContain("whale_balance");

      const energyFee = records.find((r) => r.metricName === "energy_fee_sun")!;
      expect(energyFee.value).toBe(280);
      expect(energyFee.unit).toBe("SUN");
      expect(energyFee.blockchain).toBe("tron");
      expect(energyFee.source).toBe("trongrid");
      expect(energyFee.confidence).toBe("DIRECT");
    });

    it("creates whale records with addresses", () => {
      const records = networkMetricsToRecords(makeNetworkMetrics());
      const whale = records.find((r) => r.metricName === "whale_balance")!;
      expect(whale.address).toBe("TWhale1");
      expect(whale.value).toBe(1_000_000);
    });
  });

  describe("resourceRankingsToRecords", () => {
    it("produces records for stakers and delegations", () => {
      const data: ResourceRankingsData = {
        topStakers: [
          {
            address: "TStaker1",
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
        delegationSummaries: [
          { address: "TStaker1", delegatedToCount: 5, receivedFromCount: 10 },
        ],
        collectedAt: new Date(),
        source: "trongrid",
      };

      const records = resourceRankingsToRecords(data);
      expect(records.length).toBe(9);

      const energyLimit = records.find(
        (r) => r.metricName === "account_energy_limit" && r.address === "TStaker1",
      )!;
      expect(energyLimit.value).toBe(100_000);

      const delegTo = records.find(
        (r) => r.metricName === "delegation_to_count",
      )!;
      expect(delegTo.value).toBe(5);
    });
  });

  describe("trc20RankingsToRecords", () => {
    it("produces records for tokens and holders", () => {
      const token: Trc20TokenSummary = {
        contractAddress: "TUSDT",
        name: "Tether",
        symbol: "USDT",
        decimals: 6,
        holderCount: 1_000_000,
        transferCount: 500_000_000,
        totalSupply: "10000000000",
        marketCap: 50_000_000_000,
        priceUsd: 1.0,
      };
      const data: Trc20RankingsData = {
        topTokens: [token],
        tokenAnalyses: [
          {
            token,
            topHolders: [
              { address: "THold1", balance: "900000", balanceNum: 900_000 },
            ],
            totalSupplyNum: 10_000_000_000,
          },
        ],
        collectedAt: new Date(),
        source: "tronscan",
      };

      const records = trc20RankingsToRecords(data);

      const holderCount = records.find(
        (r) => r.metricName === "token_holder_count" && r.address === "TUSDT",
      )!;
      expect(holderCount.value).toBe(1_000_000);
      expect(holderCount.metadata).toEqual({ symbol: "USDT", name: "Tether" });

      const topHolder = records.find(
        (r) => r.metricName === "top_holder_balance" && r.address === "THold1",
      )!;
      expect(topHolder.value).toBe(900_000);
      expect(topHolder.category).toBe("HOLDER");
    });
  });

  describe("energyRentalToRecords", () => {
    it("produces records for platforms", () => {
      const data: EnergyRentalMarketData = {
        platforms: [
          {
            platform: { name: "Brutus", paymentAddress: "TBrutus" },
            accountBalance: 100_000,
            outgoingTransfers: [],
            incomingTransfers: [],
            delegation: {
              delegatedToCount: 50,
              receivedFromCount: 20,
              delegatedToAddresses: [],
              receivedFromAddresses: [],
            },
            resources: {
              energyLimit: 500_000,
              energyUsed: 200_000,
              bandwidthLimit: 0,
              bandwidthUsed: 0,
            },
            outgoingVolume: 300_000,
            incomingVolume: 200_000,
            uniquePayees: 30,
            uniquePayers: 15,
          } as PlatformActivity,
        ],
        collectedAt: new Date(),
        source: "tronscan",
      };

      const records = energyRentalToRecords(data, null);

      const volume = records.find(
        (r) => r.metricName === "rental_platform_volume",
      )!;
      expect(volume.value).toBe(500_000);
      expect(volume.address).toBe("TBrutus");
    });

    it("includes comparison metrics when provided", () => {
      const data: EnergyRentalMarketData = {
        platforms: [],
        collectedAt: new Date(),
        source: "test",
      };
      const comparison = {
        directFeeCostPer100k: 28,
        selfStakeRequiredFor100k: 59880,
        rentalMarketVolume: 100_000,
        rentalProviderCount: 50,
        rentalConsumerCount: 200,
        platformCount: 1,
      };

      const records = energyRentalToRecords(data, comparison);
      const cost = records.find(
        (r) => r.metricName === "direct_fee_cost_per_100k",
      )!;
      expect(cost.value).toBe(28);
      expect(cost.confidence).toBe("DERIVED");
    });
  });

  describe("onchainAnalyticsToRecords", () => {
    it("produces records for deflation, health, velocity, gini", () => {
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
        tokenVelocities: [
          {
            symbol: "USDT",
            contractAddress: "TUSDT",
            holderCount: 1_000_000,
            transferCount: 500_000_000,
            velocity: 500,
            classification: "high",
          },
        ],
        giniCoefficients: [
          {
            symbol: "SCAM",
            contractAddress: "TSCAM",
            giniCoefficient: 0.95,
            classification: "extreme",
            topHolderCount: 10,
            totalHolderCount: 1_000,
          },
        ],
      };

      const records = onchainAnalyticsToRecords(data, "test", new Date());

      const names = records.map((r) => r.metricName);
      expect(names).toContain("daily_sr_emission_trx");
      expect(names).toContain("network_health_score");
      expect(names).toContain("health_staking");
      expect(names).toContain("token_velocity");
      expect(names).toContain("gini_coefficient");

      const healthScore = records.find(
        (r) => r.metricName === "network_health_score",
      )!;
      expect(healthScore.value).toBe(72);
      expect(healthScore.category).toBe("NETWORK");

      const gini = records.find(
        (r) => r.metricName === "gini_coefficient",
      )!;
      expect(gini.value).toBe(0.95);
      expect(gini.address).toBe("TSCAM");
    });
  });

  describe("governanceToRecords", () => {
    it("produces records for witnesses and proposals", () => {
      const data: TronGovernanceData = {
        witnesses: [
          {
            address: "TSR1",
            url: "https://sr1.tron.network",
            isElected: true,
            voteCount: 1_000_000,
            totalProduced: 50_000,
            totalMissed: 100,
            productivityPct: 99.8,
            latestBlockNum: 60_000_000,
          },
        ],
        proposals: [
          {
            proposalId: 1,
            proposerAddress: "TSR1",
            state: "APPROVED",
            parameters: { "0": "420" },
            approvalCount: 15,
            createTime: 1700000000000,
            expirationTime: 1700100000000,
          },
        ],
        chainParameters: {},
        totalVotes: 10_000_000,
        electedCount: 27,
        collectedAt: new Date(),
        source: "trongrid",
      };

      const records = governanceToRecords(data);

      const totalVotes = records.find(
        (r) => r.metricName === "total_votes",
      )!;
      expect(totalVotes.value).toBe(10_000_000);

      const witVotes = records.find(
        (r) => r.metricName === "witness_vote_count" && r.address === "TSR1",
      )!;
      expect(witVotes.value).toBe(1_000_000);

      const productivity = records.find(
        (r) => r.metricName === "witness_productivity",
      )!;
      expect(productivity.value).toBe(99.8);

      expect(records.find((r) => r.metricName === "proposal_count")!.value).toBe(1);
      expect(records.find((r) => r.metricName === "active_proposal_count")!.value).toBe(1);
    });
  });

  describe("findingsToRecords", () => {
    it("converts audit findings to metric records", () => {
      const findings: AuditFinding[] = [
        {
          analyzerName: "onchain-analytics",
          module: "FUNDAMENTAL",
          severity: "INFO",
          category: "network-emission-status",
          title: "Network is inflationary",
          description: "Test description",
          evidence: { totalDailyEmissionTrx: 465_408 },
          recommendation: null,
        },
      ];

      const records = findingsToRecords(findings, "tron", new Date());
      expect(records).toHaveLength(1);

      const r = records[0]!;
      expect(r.metricName).toBe("finding_network-emission-status");
      expect(r.value).toBe("INFO");
      expect(r.category).toBe("MONETARY");
      expect(r.confidence).toBe("DERIVED");
      expect(r.metadata).toBeDefined();
    });
  });
});
