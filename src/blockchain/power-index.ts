import type { MonitoredWallet, WalletRegistryResult } from "./wallet-registry.js";

export interface WalletPowerScore {
  readonly address: string;
  readonly rawBalance: number;
  readonly rawVotingPower: number;
  readonly rawDelegations: number;
  readonly rawEnergy: number;
  readonly normalizedBalance: number;
  readonly normalizedVotingPower: number;
  readonly normalizedDelegations: number;
  readonly normalizedEnergy: number;
  readonly powerScore: number;
  readonly rank: number;
}

export interface PowerIndexResult {
  readonly rankings: readonly WalletPowerScore[];
  readonly maxBalance: number;
  readonly maxVotingPower: number;
  readonly maxDelegations: number;
  readonly maxEnergy: number;
  readonly computedAt: Date;
}

// H-03: getdelegatedresourceaccountindexV2 returns 405 on TronGrid's public
// API, so delegation data is usually empty (delegatedToCount = 0 for all).
// Until TronGrid re-enables the endpoint or we add a TronScan-based fallback,
// the delegation weight is dead weight.  Redistribute its share to balance and
// energy so the Power Index remains a 100% weighted sum.
//
// Original weights: balance=0.30, voting=0.40, delegation=0.15, energy=0.15
// Adjusted weights: balance=0.35, voting=0.40, delegation=0.05, energy=0.20
//
// Delegation keeps a small token weight (5%) so that if the endpoint starts
// working again, the data isn't completely ignored.
const WEIGHT_BALANCE = 0.35;
const WEIGHT_VOTING_POWER = 0.4;
const WEIGHT_DELEGATIONS = 0.05;
const WEIGHT_ENERGY = 0.20;

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min((value / max) * 100, 100);
}

export function computePowerIndex(registry: WalletRegistryResult): PowerIndexResult {
  const wallets = [...registry.wallets.values()];

  if (wallets.length === 0) {
    return Object.freeze({
      rankings: Object.freeze([]),
      maxBalance: 0,
      maxVotingPower: 0,
      maxDelegations: 0,
      maxEnergy: 0,
      computedAt: new Date(),
    });
  }

  // Find max values for normalization
  let maxBalance = 0;
  let maxVotingPower = 0;
  let maxDelegations = 0;
  let maxEnergy = 0;

  for (const wallet of wallets) {
    maxBalance = Math.max(maxBalance, wallet.balance);
    maxVotingPower = Math.max(maxVotingPower, wallet.votingPower);
    maxDelegations = Math.max(maxDelegations, wallet.delegatedToCount);
    maxEnergy = Math.max(maxEnergy, wallet.energyLimit);
  }

  // Compute power score for each wallet
  const scored: WalletPowerScore[] = wallets.map((wallet: MonitoredWallet) => {
    const normalizedBalance = normalize(wallet.balance, maxBalance);
    const normalizedVotingPower = normalize(wallet.votingPower, maxVotingPower);
    const normalizedDelegations = normalize(wallet.delegatedToCount, maxDelegations);
    const normalizedEnergy = normalize(wallet.energyLimit, maxEnergy);

    const powerScore =
      Math.round(
        (normalizedBalance * WEIGHT_BALANCE +
          normalizedVotingPower * WEIGHT_VOTING_POWER +
          normalizedDelegations * WEIGHT_DELEGATIONS +
          normalizedEnergy * WEIGHT_ENERGY) *
          100,
      ) / 100;

    return {
      address: wallet.address,
      rawBalance: wallet.balance,
      rawVotingPower: wallet.votingPower,
      rawDelegations: wallet.delegatedToCount,
      rawEnergy: wallet.energyLimit,
      normalizedBalance,
      normalizedVotingPower,
      normalizedDelegations,
      normalizedEnergy,
      powerScore,
      rank: 0, // assigned below after sorting
    };
  });

  // Sort by power score descending
  scored.sort((a, b) => b.powerScore - a.powerScore);

  // Assign ranks
  const ranked: WalletPowerScore[] = scored.map((s, i) =>
    Object.freeze({ ...s, rank: i + 1 }),
  );

  return Object.freeze({
    rankings: Object.freeze(ranked),
    maxBalance,
    maxVotingPower,
    maxDelegations,
    maxEnergy,
    computedAt: new Date(),
  });
}
