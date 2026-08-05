import { describe, expect, it } from "vitest";

import { runWalletAudit } from "../src/blockchain/wallet-audit-runner.js";
import type { WalletAuditInput } from "../src/blockchain/wallet-audit-runner.js";
import { InMemorySnapshotStore } from "../src/blockchain/snapshot-store.js";
import type { TronNetworkMetrics, AccountRanking } from "../src/blockchain/network-metrics-collector.js";
import type { TronGovernanceData, TronWitness } from "../src/blockchain/tron-governance-collector.js";
import type { ResourceRankingsData, ResourceAccountData } from "../src/blockchain/resource-rankings-collector.js";

function makeNetworkMetrics(topHolders: readonly AccountRanking[] = []): TronNetworkMetrics {
  return {
    energy: {
      energyFee: 420,
      totalEnergyLimit: 90_000_000_000,
      totalEnergyWeight: 50_000_000_000,
      dynamicIncreaseFactor: 2000,
      dynamicMaxFactor: 12000,
      energyYieldPerTrx: 1800,
    },
    bandwidth: {
      transactionFee: 1000,
      totalNetLimit: 43_200_000_000,
      totalNetWeight: 10_000_000_000,
      bandwidthYieldPerTrx: 4320,
    },
    economics: {
      createAccountFee: 100000,
      burnTrxAmount: 1000000,
      witnessPayPerBlock: 16000000,
      witness127PayPerBlock: 160000,
      maintenanceIntervalMs: 21600000,
      proposalExpireTime: 259200000,
    },
    topHolders,
    staking: {
      stakedForEnergyTrx: 30_000_000_000,
      stakedForBandwidthTrx: 10_000_000_000,
      totalStakedTrx: 40_000_000_000,
      totalSupplyTrx: 100_000_000_000,
      supplySource: "tronscan",
    },
    stakingRatio: 0.4,
    collectedAt: new Date(),
    source: "test",
  };
}

function makeGovernance(witnesses: readonly TronWitness[] = []): TronGovernanceData {
  return {
    witnesses,
    proposals: [],
    chainParameters: {},
    totalVotes: witnesses.reduce((sum, w) => sum + w.voteCount, 0),
    electedCount: witnesses.filter((w) => w.isElected).length,
    collectedAt: new Date(),
    source: "test",
  };
}

function makeWitness(address: string, isElected: boolean, voteCount: number): TronWitness {
  return {
    address,
    url: `https://sr-${address}.example.com`,
    isElected,
    voteCount,
    totalProduced: 100000,
    totalMissed: 100,
    productivityPct: 99.9,
    latestBlockNum: 50000000,
  };
}

function makeResourceRankings(
  topStakers: readonly ResourceAccountData[] = [],
): ResourceRankingsData {
  return {
    topStakers,
    topEnergyConsumers: [],
    topEnergyDelegators: [],
    delegationSummaries: [],
    topContracts: [],
    collectedAt: new Date(),
    source: "test",
  };
}

function makeInput(overrides: Partial<WalletAuditInput> = {}): WalletAuditInput {
  const topHolders: AccountRanking[] = [
    { address: "TWhale1", balance: 200_000_000, totalFrozen: 100_000_000, power: 500_000_000 },
    { address: "TWhale2", balance: 150_000_000, totalFrozen: 80_000_000, power: 400_000_000 },
  ];
  const witnesses: TronWitness[] = [
    makeWitness("TSR1", true, 600_000_000),
    makeWitness("TSR2", true, 500_000_000),
    makeWitness("TSR3", true, 400_000_000),
  ];

  return {
    networkMetrics: overrides.networkMetrics ?? makeNetworkMetrics(topHolders),
    governance: overrides.governance !== undefined ? overrides.governance : makeGovernance(witnesses),
    resourceRankings: overrides.resourceRankings ?? makeResourceRankings(),
  };
}

describe("runWalletAudit", () => {
  it("orchestrates full audit pipeline and returns result", () => {
    const store = new InMemorySnapshotStore();
    const input = makeInput();

    const result = runWalletAudit(input, store);

    // Has a registry with wallets
    expect(result.registry.totalCount).toBeGreaterThan(0);

    // Has power index rankings
    expect(result.powerIndex.rankings.length).toBeGreaterThan(0);

    // Has a snapshot ID
    expect(result.snapshotId).toMatch(/^snap-/);

    // No previous snapshot on first run
    expect(result.previousSnapshotId).toBeNull();

    // Alerts is an array (may or may not have findings)
    expect(Array.isArray(result.alerts)).toBe(true);
  });

  it("stores snapshot in the store", () => {
    const store = new InMemorySnapshotStore();
    const input = makeInput();

    const result = runWalletAudit(input, store);

    expect(store.count()).toBe(1);
    const saved = store.getById(result.snapshotId);
    expect(saved).not.toBeNull();
    expect(saved!.registry.totalCount).toBe(result.registry.totalCount);
  });

  it("references previous snapshot on second run", () => {
    const store = new InMemorySnapshotStore();
    const input = makeInput();

    const first = runWalletAudit(input, store);
    const second = runWalletAudit(input, store);

    expect(second.previousSnapshotId).toBe(first.snapshotId);
    expect(store.count()).toBe(2);
  });

  it("detects risks by comparing current and previous snapshots", () => {
    const store = new InMemorySnapshotStore();

    // First run: SR has high votes
    const witnesses1: TronWitness[] = [
      makeWitness("TSRRisk", true, 1_000_000_000),
    ];
    const input1 = makeInput({ governance: makeGovernance(witnesses1) });
    runWalletAudit(input1, store);

    // Second run: SR lost >30% of votes
    const witnesses2: TronWitness[] = [
      makeWitness("TSRRisk", true, 600_000_000),
    ];
    const input2 = makeInput({ governance: makeGovernance(witnesses2) });
    const result2 = runWalletAudit(input2, store);

    const srRotation = result2.alerts.find((a) => a.category === "sr-rotation");
    expect(srRotation).toBeDefined();
    expect(srRotation!.severity).toBe("HIGH");
  });

  it("includes network summary in snapshot", () => {
    const store = new InMemorySnapshotStore();
    const input = makeInput();

    const result = runWalletAudit(input, store);

    const snapshot = store.getById(result.snapshotId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.networkSummary.totalStakedTrx).toBe(40_000_000_000);
    expect(snapshot!.networkSummary.stakingRatio).toBe(0.4);
    expect(snapshot!.networkSummary.electedSRCount).toBe(3);
  });

  it("handles null governance input", () => {
    const store = new InMemorySnapshotStore();
    const input = makeInput({ governance: null });

    const result = runWalletAudit(input, store);

    expect(result.registry.roleBreakdown.sr).toBe(0);
    const snapshot = store.getById(result.snapshotId);
    expect(snapshot!.networkSummary.totalVotes).toBe(0);
    expect(snapshot!.networkSummary.electedSRCount).toBe(0);
  });

  it("handles empty data gracefully", () => {
    const store = new InMemorySnapshotStore();
    const input: WalletAuditInput = {
      networkMetrics: makeNetworkMetrics([]),
      governance: null,
      resourceRankings: makeResourceRankings(),
    };

    const result = runWalletAudit(input, store);

    expect(result.registry.totalCount).toBe(0);
    expect(result.powerIndex.rankings).toHaveLength(0);
    expect(result.alerts).toHaveLength(0);
  });

  it("generates unique snapshot IDs across runs", () => {
    const store = new InMemorySnapshotStore();
    const input = makeInput();

    const r1 = runWalletAudit(input, store);
    const r2 = runWalletAudit(input, store);
    const r3 = runWalletAudit(input, store);

    const ids = new Set([r1.snapshotId, r2.snapshotId, r3.snapshotId]);
    expect(ids.size).toBe(3);
  });
});
