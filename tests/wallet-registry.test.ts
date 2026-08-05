import { describe, expect, it } from "vitest";

import { buildWalletRegistry } from "../src/blockchain/wallet-registry.js";
import type { TronNetworkMetrics, AccountRanking } from "../src/blockchain/network-metrics-collector.js";
import type { TronGovernanceData, TronWitness } from "../src/blockchain/tron-governance-collector.js";
import type { ResourceRankingsData, ResourceAccountData, EnergyDelegator, DelegationSummary } from "../src/blockchain/resource-rankings-collector.js";

function makeNetworkMetrics(topHolders: readonly AccountRanking[]): TronNetworkMetrics {
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

function makeGovernance(witnesses: readonly TronWitness[]): TronGovernanceData {
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

function makeResourceAccount(address: string, votingPower: number, energyLimit: number): ResourceAccountData {
  return {
    address,
    balance: 50_000_000,
    frozenForEnergy: 20_000_000,
    frozenForBandwidth: 5_000_000,
    votingPower,
    energyLimit,
    energyUsed: 0,
    bandwidthLimit: 1000,
    bandwidthUsed: 0,
  };
}

function makeResourceRankings(
  opts: {
    topStakers?: readonly ResourceAccountData[];
    topEnergyConsumers?: readonly ResourceAccountData[];
    topEnergyDelegators?: readonly EnergyDelegator[];
    delegationSummaries?: readonly DelegationSummary[];
  } = {},
): ResourceRankingsData {
  return {
    topStakers: opts.topStakers ?? [],
    topEnergyConsumers: opts.topEnergyConsumers ?? [],
    topEnergyDelegators: opts.topEnergyDelegators ?? [],
    delegationSummaries: opts.delegationSummaries ?? [],
    topContracts: [],
    collectedAt: new Date(),
    source: "test",
  };
}

describe("buildWalletRegistry", () => {
  it("registers whale wallets above 100M TRX threshold", () => {
    const topHolders: AccountRanking[] = [
      { address: "TWhale1", balance: 200_000_000, totalFrozen: 0, power: 5000 },
      { address: "TWhale2", balance: 150_000_000, totalFrozen: 0, power: 3000 },
      { address: "TSmall1", balance: 50_000_000, totalFrozen: 0, power: 1000 },
    ];

    const result = buildWalletRegistry(
      makeNetworkMetrics(topHolders),
      null,
      makeResourceRankings(),
    );

    expect(result.wallets.size).toBe(2);
    expect(result.wallets.get("TWhale1")).toBeDefined();
    expect(result.wallets.get("TWhale2")).toBeDefined();
    expect(result.wallets.get("TSmall1")).toBeUndefined();
    expect(result.wallets.get("TWhale1")!.roles).toContain("whale");
    expect(result.roleBreakdown.whale).toBe(2);
  });

  it("registers elected Super Representatives", () => {
    const witnesses: TronWitness[] = [
      makeWitness("TSR1", true, 500_000_000),
      makeWitness("TSR2", true, 400_000_000),
      makeWitness("TCandidate", false, 100_000_000),
    ];

    const result = buildWalletRegistry(
      makeNetworkMetrics([]),
      makeGovernance(witnesses),
      makeResourceRankings(),
    );

    expect(result.wallets.size).toBe(2);
    expect(result.wallets.get("TSR1")!.roles).toContain("sr");
    expect(result.wallets.get("TSR2")!.roles).toContain("sr");
    expect(result.wallets.get("TCandidate")).toBeUndefined();
    expect(result.roleBreakdown.sr).toBe(2);
  });

  it("registers top stakers", () => {
    const stakers: ResourceAccountData[] = [
      makeResourceAccount("TStaker1", 100_000_000, 5000),
      makeResourceAccount("TStaker2", 80_000_000, 3000),
    ];

    const result = buildWalletRegistry(
      makeNetworkMetrics([]),
      null,
      makeResourceRankings({ topStakers: stakers }),
    );

    expect(result.wallets.size).toBe(2);
    expect(result.wallets.get("TStaker1")!.roles).toContain("staker");
    expect(result.roleBreakdown.staker).toBe(2);
  });

  it("registers top energy consumers", () => {
    const consumers: ResourceAccountData[] = [
      makeResourceAccount("TEnergy1", 50_000_000, 90_000_000_000),
    ];

    const result = buildWalletRegistry(
      makeNetworkMetrics([]),
      null,
      makeResourceRankings({ topEnergyConsumers: consumers }),
    );

    expect(result.wallets.size).toBe(1);
    expect(result.wallets.get("TEnergy1")!.roles).toContain("energy-consumer");
    expect(result.roleBreakdown["energy-consumer"]).toBe(1);
  });

  it("registers top delegators", () => {
    const delegators: EnergyDelegator[] = [
      {
        address: "TDelegator1",
        delegatedToCount: 15,
        delegatedToAddresses: Array.from({ length: 15 }, (_, i) => `TTarget${i}`),
        energyLimit: 5000,
        energyUsed: 1000,
        balance: 10_000_000,
      },
    ];

    const result = buildWalletRegistry(
      makeNetworkMetrics([]),
      null,
      makeResourceRankings({ topEnergyDelegators: delegators }),
    );

    expect(result.wallets.size).toBe(1);
    expect(result.wallets.get("TDelegator1")!.roles).toContain("delegator");
    expect(result.wallets.get("TDelegator1")!.delegatedToCount).toBe(15);
    expect(result.roleBreakdown.delegator).toBe(1);
  });

  it("deduplicates wallets across categories and assigns multiple roles", () => {
    const topHolders: AccountRanking[] = [
      { address: "TMultiRole", balance: 200_000_000, totalFrozen: 100_000_000, power: 100_000_000 },
    ];
    const witnesses: TronWitness[] = [
      makeWitness("TMultiRole", true, 500_000_000),
    ];
    const stakers: ResourceAccountData[] = [
      makeResourceAccount("TMultiRole", 100_000_000, 5000),
    ];

    const result = buildWalletRegistry(
      makeNetworkMetrics(topHolders),
      makeGovernance(witnesses),
      makeResourceRankings({ topStakers: stakers }),
    );

    // Should be deduplicated to a single wallet
    expect(result.totalCount).toBe(1);
    const wallet = result.wallets.get("TMultiRole")!;
    expect(wallet.roles).toContain("whale");
    expect(wallet.roles).toContain("sr");
    expect(wallet.roles).toContain("staker");
    // Balance should be the max across sources
    expect(wallet.balance).toBe(200_000_000);
    expect(wallet.votingPower).toBe(500_000_000);
  });

  it("handles null governance gracefully", () => {
    const result = buildWalletRegistry(
      makeNetworkMetrics([]),
      null,
      makeResourceRankings(),
    );

    expect(result.wallets.size).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.roleBreakdown.sr).toBe(0);
  });

  it("limits whales to 20", () => {
    const topHolders: AccountRanking[] = Array.from({ length: 25 }, (_, i) => ({
      address: `TWhale${i}`,
      balance: 200_000_000 - i * 1_000_000,
      totalFrozen: 0,
      power: 0,
    }));

    const result = buildWalletRegistry(
      makeNetworkMetrics(topHolders),
      null,
      makeResourceRankings(),
    );

    expect(result.roleBreakdown.whale).toBe(20);
  });

  it("limits stakers to 10", () => {
    const stakers: ResourceAccountData[] = Array.from({ length: 15 }, (_, i) =>
      makeResourceAccount(`TStaker${i}`, 100_000_000 - i * 1_000_000, 5000),
    );

    const result = buildWalletRegistry(
      makeNetworkMetrics([]),
      null,
      makeResourceRankings({ topStakers: stakers }),
    );

    expect(result.roleBreakdown.staker).toBe(10);
  });
});
