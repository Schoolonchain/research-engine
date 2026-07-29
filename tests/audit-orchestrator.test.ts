import { describe, expect, it } from "vitest";

import { AuditOrchestrator } from "../src/blockchain/audit-orchestrator.js";
import { SecurityAnalyzer } from "../src/blockchain/security-analyzer.js";
import { GovernanceAnalyzer } from "../src/blockchain/governance-analyzer.js";
import { StakingAnalyzer } from "../src/blockchain/staking-analyzer.js";
import { TronCollectorRegistry } from "../src/blockchain/tron-collector-registry.js";
import type { TronCollector } from "../src/blockchain/tron-collector.js";
import type { DataSourceType } from "../src/blockchain/model.js";
import type { AccountTarget, TronAccountInfo } from "../src/blockchain/audit-model.js";
import type { StakingTarget, TronStakingInfo } from "../src/blockchain/tron-staking-collector.js";
import type { GovernanceTarget, TronGovernanceData } from "../src/blockchain/tron-governance-collector.js";

function stubAccountCollector(): TronCollector<AccountTarget, TronAccountInfo> {
  return {
    collectorName: "stub-account",
    sourceName: "stub",
    sourceType: "API" as DataSourceType,
    supports() { return true; },
    async collect(target: AccountTarget): Promise<TronAccountInfo> {
      return {
        address: target.address,
        balanceSun: "50000000",
        balanceTrx: "50",
        createTime: 1_700_000_000_000,
        latestOperationTime: null,
        isContract: false,
        accountName: null,
        frozenBalanceSun: "0",
        energyLimit: 1000,
        energyUsed: 100,
        bandwidthLimit: 600,
        bandwidthUsed: 50,
        netLimit: 0,
        netUsed: 0,
        delegatedFrozenBalanceSun: "0",
        trc20Balances: [],
        permissions: [
          {
            type: "owner",
            permissionName: "owner",
            threshold: 1,
            keys: [{ address: target.address, weight: 1 }],
            operations: null,
          },
        ],
        collectedAt: new Date(),
        source: "stub",
      };
    },
  };
}

function stubStakingCollector(): TronCollector<StakingTarget, TronStakingInfo> {
  return {
    collectorName: "stub-staking",
    sourceName: "stub",
    sourceType: "API" as DataSourceType,
    supports() { return true; },
    async collect(target: StakingTarget): Promise<TronStakingInfo> {
      return {
        address: target.address,
        frozenBalanceV2Sun: "10000000",
        frozenBandwidthSun: "5000000",
        frozenEnergySun: "5000000",
        delegatedBandwidthSun: "0",
        delegatedEnergySun: "0",
        canWithdrawSun: "0",
        tronPower: 10,
        rewardsPendingSun: "0",
        votedWitnesses: [],
        collectedAt: new Date(),
        source: "stub",
      };
    },
  };
}

function stubGovernanceCollector(): TronCollector<GovernanceTarget, TronGovernanceData> {
  return {
    collectorName: "stub-governance",
    sourceName: "stub",
    sourceType: "API" as DataSourceType,
    supports() { return true; },
    async collect(): Promise<TronGovernanceData> {
      return {
        witnesses: [
          {
            address: "TSR1",
            url: "https://sr1.example.com",
            isElected: true,
            voteCount: 60_000_000,
            totalProduced: 10000,
            totalMissed: 100,
            productivityPct: 99.01,
            latestBlockNum: 60_000_000,
          },
          {
            address: "TSR2",
            url: "https://sr2.example.com",
            isElected: true,
            voteCount: 30_000_000,
            totalProduced: 5000,
            totalMissed: 50,
            productivityPct: 99.01,
            latestBlockNum: 59_990_000,
          },
        ],
        proposals: [],
        chainParameters: {},
        totalVotes: 90_000_000,
        electedCount: 2,
        collectedAt: new Date(),
        source: "stub",
      };
    },
  };
}

describe("AuditOrchestrator", () => {
  describe("auditAccount", () => {
    it("produces an audit report with findings", async () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubAccountCollector());
      registry.register("staking", stubStakingCollector());

      const orchestrator = new AuditOrchestrator(
        registry,
        [new SecurityAnalyzer(), new StakingAnalyzer()],
      );

      const report = await orchestrator.auditAccount("TTestAddr");

      expect(report.auditType).toBe("ACCOUNT");
      expect(report.targetAddress).toBe("TTestAddr");
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.sourcesUsed).toContain("stub");
      expect(report.dataPointsCollected).toBeGreaterThan(0);
      expect(report.completedAt.getTime()).toBeGreaterThanOrEqual(report.startedAt.getTime());
    });

    it("detects single-key owner via SecurityAnalyzer", async () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubAccountCollector());

      const orchestrator = new AuditOrchestrator(registry, [new SecurityAnalyzer()]);
      const report = await orchestrator.auditAccount("TTestAddr");

      const singleKey = report.findings.find((f) => f.category === "single-key-owner");
      expect(singleKey).toBeDefined();
      expect(report.overallRisk).toBe("HIGH");
      expect(report.findingCounts.high).toBeGreaterThan(0);
    });

    it("handles collector errors gracefully", async () => {
      const failingCollector: TronCollector<AccountTarget, TronAccountInfo> = {
        collectorName: "failing",
        sourceName: "failing",
        sourceType: "API",
        supports() { return true; },
        async collect(): Promise<TronAccountInfo> {
          throw new Error("Network error");
        },
      };

      const registry = new TronCollectorRegistry();
      registry.register("account", failingCollector);

      const orchestrator = new AuditOrchestrator(registry, [new SecurityAnalyzer()]);
      const report = await orchestrator.auditAccount("TTestAddr");

      expect(report.auditType).toBe("ACCOUNT");
      expect(report.findings).toHaveLength(0);
    });
  });

  describe("auditFull", () => {
    it("runs governance analysis on full audit", async () => {
      const registry = new TronCollectorRegistry();
      registry.register("governance", stubGovernanceCollector());

      const orchestrator = new AuditOrchestrator(
        registry,
        [new GovernanceAnalyzer()],
      );

      const report = await orchestrator.auditFull();

      expect(report.auditType).toBe("FULL");
      expect(report.targetAddress).toBeNull();

      const voteCentralization = report.findings.find((f) => f.category === "vote-centralization");
      expect(voteCentralization).toBeDefined();

      const lowElected = report.findings.find((f) => f.category === "low-elected-count");
      expect(lowElected).toBeDefined();
    });
  });

  describe("report structure", () => {
    it("sorts findings by severity descending", async () => {
      const registry = new TronCollectorRegistry();
      registry.register("account", stubAccountCollector());
      registry.register("staking", stubStakingCollector());

      const orchestrator = new AuditOrchestrator(
        registry,
        [new SecurityAnalyzer(), new StakingAnalyzer()],
      );

      const report = await orchestrator.auditAccount("TTestAddr");

      for (let i = 1; i < report.findings.length; i++) {
        const prevSev = severityOrder(report.findings[i - 1]!.severity);
        const currSev = severityOrder(report.findings[i]!.severity);
        expect(prevSev).toBeGreaterThanOrEqual(currSev);
      }
    });
  });
});

function severityOrder(sev: string): number {
  const order: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  return order[sev] ?? -1;
}
