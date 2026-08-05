import type { TronNetworkMetrics, AccountRanking } from "./network-metrics-collector.js";
import type { TronGovernanceData, TronWitness } from "./tron-governance-collector.js";
import type { ResourceRankingsData } from "./resource-rankings-collector.js";

export type WalletRole = "whale" | "sr" | "staker" | "energy-consumer" | "delegator";

export interface MonitoredWallet {
  readonly address: string;
  readonly roles: readonly WalletRole[];
  readonly balance: number;
  readonly votingPower: number;
  readonly energyLimit: number;
  readonly delegatedToCount: number;
}

export interface WalletRegistryResult {
  readonly wallets: ReadonlyMap<string, MonitoredWallet>;
  readonly totalCount: number;
  readonly roleBreakdown: Readonly<Record<WalletRole, number>>;
  readonly builtAt: Date;
}

const WHALE_THRESHOLD_TRX = 100_000_000;

export function buildWalletRegistry(
  networkMetrics: TronNetworkMetrics,
  governance: TronGovernanceData | null,
  resourceRankings: ResourceRankingsData,
): WalletRegistryResult {
  const roleMap = new Map<string, Set<WalletRole>>();
  const dataMap = new Map<string, {
    balance: number;
    votingPower: number;
    energyLimit: number;
    delegatedToCount: number;
  }>();

  function ensureEntry(address: string): {
    balance: number;
    votingPower: number;
    energyLimit: number;
    delegatedToCount: number;
  } {
    let entry = dataMap.get(address);
    if (!entry) {
      entry = { balance: 0, votingPower: 0, energyLimit: 0, delegatedToCount: 0 };
      dataMap.set(address, entry);
    }
    return entry;
  }

  function addRole(address: string, role: WalletRole): void {
    let roles = roleMap.get(address);
    if (!roles) {
      roles = new Set();
      roleMap.set(address, roles);
    }
    roles.add(role);
  }

  // Top holders (whales) -- up to 20
  const topHolders = networkMetrics.topHolders
    .filter((h: AccountRanking) => h.balance >= WHALE_THRESHOLD_TRX)
    .slice(0, 20);

  for (const holder of topHolders) {
    addRole(holder.address, "whale");
    const entry = ensureEntry(holder.address);
    entry.balance = Math.max(entry.balance, holder.balance);
    entry.votingPower = Math.max(entry.votingPower, holder.power);
  }

  // Top stakers (by voting power) -- up to 10
  const topStakers = resourceRankings.topStakers.slice(0, 10);
  for (const staker of topStakers) {
    addRole(staker.address, "staker");
    const entry = ensureEntry(staker.address);
    entry.balance = Math.max(entry.balance, staker.balance);
    entry.votingPower = Math.max(entry.votingPower, staker.votingPower);
    entry.energyLimit = Math.max(entry.energyLimit, staker.energyLimit);
  }

  // Elected Super Representatives -- all 27
  if (governance) {
    const electedSRs = governance.witnesses
      .filter((w: TronWitness) => w.isElected)
      .slice(0, 27);

    for (const sr of electedSRs) {
      addRole(sr.address, "sr");
      const entry = ensureEntry(sr.address);
      entry.votingPower = Math.max(entry.votingPower, sr.voteCount);
    }
  }

  // Top energy consumers -- up to 10
  const topEnergyConsumers = resourceRankings.topEnergyConsumers.slice(0, 10);
  for (const consumer of topEnergyConsumers) {
    addRole(consumer.address, "energy-consumer");
    const entry = ensureEntry(consumer.address);
    entry.balance = Math.max(entry.balance, consumer.balance);
    entry.energyLimit = Math.max(entry.energyLimit, consumer.energyLimit);
    entry.votingPower = Math.max(entry.votingPower, consumer.votingPower);
  }

  // Top delegators -- up to 10
  const topDelegators = resourceRankings.topEnergyDelegators.slice(0, 10);
  for (const delegator of topDelegators) {
    addRole(delegator.address, "delegator");
    const entry = ensureEntry(delegator.address);
    entry.balance = Math.max(entry.balance, delegator.balance);
    entry.energyLimit = Math.max(entry.energyLimit, delegator.energyLimit);
    entry.delegatedToCount = Math.max(entry.delegatedToCount, delegator.delegatedToCount);
  }

  // Build final wallets map
  const wallets = new Map<string, MonitoredWallet>();
  const roleBreakdown: Record<WalletRole, number> = {
    whale: 0,
    sr: 0,
    staker: 0,
    "energy-consumer": 0,
    delegator: 0,
  };

  for (const [address, roles] of roleMap) {
    const data = dataMap.get(address)!;
    const rolesArray = [...roles].sort() as WalletRole[];

    for (const role of rolesArray) {
      roleBreakdown[role]++;
    }

    wallets.set(
      address,
      Object.freeze({
        address,
        roles: Object.freeze(rolesArray),
        balance: data.balance,
        votingPower: data.votingPower,
        energyLimit: data.energyLimit,
        delegatedToCount: data.delegatedToCount,
      }),
    );
  }

  return Object.freeze({
    wallets,
    totalCount: wallets.size,
    roleBreakdown: Object.freeze(roleBreakdown),
    builtAt: new Date(),
  });
}
