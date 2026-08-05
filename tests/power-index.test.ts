import { describe, expect, it } from "vitest";

import { computePowerIndex } from "../src/blockchain/power-index.js";
import type { WalletRegistryResult, MonitoredWallet, WalletRole } from "../src/blockchain/wallet-registry.js";

function makeRegistry(wallets: MonitoredWallet[]): WalletRegistryResult {
  const map = new Map<string, MonitoredWallet>();
  for (const w of wallets) {
    map.set(w.address, w);
  }
  return {
    wallets: map,
    totalCount: map.size,
    roleBreakdown: { whale: 0, sr: 0, staker: 0, "energy-consumer": 0, delegator: 0 },
    builtAt: new Date(),
  };
}

function makeWallet(
  address: string,
  overrides: {
    roles?: readonly WalletRole[];
    balance?: number;
    votingPower?: number;
    energyLimit?: number;
    delegatedToCount?: number;
  } = {},
): MonitoredWallet {
  return Object.freeze({
    address,
    roles: overrides.roles ?? (["whale"] as const satisfies readonly WalletRole[]),
    balance: overrides.balance ?? 0,
    votingPower: overrides.votingPower ?? 0,
    energyLimit: overrides.energyLimit ?? 0,
    delegatedToCount: overrides.delegatedToCount ?? 0,
  });
}

describe("computePowerIndex", () => {
  it("returns empty rankings for empty registry", () => {
    const result = computePowerIndex(makeRegistry([]));

    expect(result.rankings).toHaveLength(0);
    expect(result.maxBalance).toBe(0);
    expect(result.maxVotingPower).toBe(0);
  });

  it("computes power score with correct weights", () => {
    // A single wallet with max values should score 100
    const wallet = makeWallet("TMax", {
      balance: 1000,
      votingPower: 1000,
      energyLimit: 1000,
      delegatedToCount: 1000,
    });

    const result = computePowerIndex(makeRegistry([wallet]));

    expect(result.rankings).toHaveLength(1);
    // With single wallet, all normalized values are 100
    // power = (100*0.3) + (100*0.4) + (100*0.15) + (100*0.15) = 100
    expect(result.rankings[0]!.powerScore).toBe(100);
    expect(result.rankings[0]!.rank).toBe(1);
  });

  it("ranks wallets by power score descending", () => {
    const wallets = [
      makeWallet("TLow", { balance: 100, votingPower: 100 }),
      makeWallet("THigh", { balance: 1000, votingPower: 1000, energyLimit: 500, delegatedToCount: 10 }),
      makeWallet("TMid", { balance: 500, votingPower: 500, energyLimit: 250, delegatedToCount: 5 }),
    ];

    const result = computePowerIndex(makeRegistry(wallets));

    expect(result.rankings).toHaveLength(3);
    expect(result.rankings[0]!.address).toBe("THigh");
    expect(result.rankings[0]!.rank).toBe(1);
    expect(result.rankings[1]!.address).toBe("TMid");
    expect(result.rankings[1]!.rank).toBe(2);
    expect(result.rankings[2]!.address).toBe("TLow");
    expect(result.rankings[2]!.rank).toBe(3);

    // Higher score first
    expect(result.rankings[0]!.powerScore).toBeGreaterThan(result.rankings[1]!.powerScore);
    expect(result.rankings[1]!.powerScore).toBeGreaterThan(result.rankings[2]!.powerScore);
  });

  it("normalizes components to 0-100 range", () => {
    const wallets = [
      makeWallet("TA", { balance: 1000, votingPower: 500 }),
      makeWallet("TB", { balance: 500, votingPower: 1000 }),
    ];

    const result = computePowerIndex(makeRegistry(wallets));

    for (const r of result.rankings) {
      expect(r.normalizedBalance).toBeGreaterThanOrEqual(0);
      expect(r.normalizedBalance).toBeLessThanOrEqual(100);
      expect(r.normalizedVotingPower).toBeGreaterThanOrEqual(0);
      expect(r.normalizedVotingPower).toBeLessThanOrEqual(100);
      expect(r.normalizedDelegations).toBeGreaterThanOrEqual(0);
      expect(r.normalizedDelegations).toBeLessThanOrEqual(100);
      expect(r.normalizedEnergy).toBeGreaterThanOrEqual(0);
      expect(r.normalizedEnergy).toBeLessThanOrEqual(100);
    }
  });

  it("voting power has highest weight (0.4)", () => {
    // Two wallets: one with only votingPower, one with only balance
    const voteWallet = makeWallet("TVote", { votingPower: 1000 });
    const balanceWallet = makeWallet("TBalance", { balance: 1000 });

    const result = computePowerIndex(makeRegistry([voteWallet, balanceWallet]));

    // Vote wallet should rank higher because votingPower weight (0.4) > balance weight (0.3)
    expect(result.rankings[0]!.address).toBe("TVote");
    expect(result.rankings[1]!.address).toBe("TBalance");
  });

  it("preserves raw values in the output", () => {
    const wallet = makeWallet("TRaw", {
      balance: 5_000_000,
      votingPower: 3_000_000,
      energyLimit: 1_000_000,
      delegatedToCount: 42,
    });

    const result = computePowerIndex(makeRegistry([wallet]));

    expect(result.rankings[0]!.rawBalance).toBe(5_000_000);
    expect(result.rankings[0]!.rawVotingPower).toBe(3_000_000);
    expect(result.rankings[0]!.rawEnergy).toBe(1_000_000);
    expect(result.rankings[0]!.rawDelegations).toBe(42);
  });

  it("records max values used for normalization", () => {
    const wallets = [
      makeWallet("TA", { balance: 100, votingPower: 200, energyLimit: 300, delegatedToCount: 5 }),
      makeWallet("TB", { balance: 400, votingPower: 50, energyLimit: 150, delegatedToCount: 10 }),
    ];

    const result = computePowerIndex(makeRegistry(wallets));

    expect(result.maxBalance).toBe(400);
    expect(result.maxVotingPower).toBe(200);
    expect(result.maxEnergy).toBe(300);
    expect(result.maxDelegations).toBe(10);
  });

  it("handles wallets with zero values", () => {
    const wallet = makeWallet("TZero", {
      balance: 0,
      votingPower: 0,
      energyLimit: 0,
      delegatedToCount: 0,
    });

    const result = computePowerIndex(makeRegistry([wallet]));

    expect(result.rankings).toHaveLength(1);
    // All zeros -> all normalized to 0, score = 0
    expect(result.rankings[0]!.powerScore).toBe(0);
  });
});
