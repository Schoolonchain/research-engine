import { describe, expect, it } from "vitest";

import { detectRisks } from "../src/blockchain/risk-detector.js";
import type { WalletAuditSnapshot, NetworkSummary } from "../src/blockchain/snapshot-store.js";
import type { WalletRegistryResult, MonitoredWallet, WalletRole } from "../src/blockchain/wallet-registry.js";
import type { PowerIndexResult, WalletPowerScore } from "../src/blockchain/power-index.js";

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

function makeRanking(address: string, powerScore: number, rank: number): WalletPowerScore {
  return Object.freeze({
    address,
    rawBalance: 0,
    rawVotingPower: 0,
    rawDelegations: 0,
    rawEnergy: 0,
    normalizedBalance: 0,
    normalizedVotingPower: 0,
    normalizedDelegations: 0,
    normalizedEnergy: 0,
    powerScore,
    rank,
  });
}

function makeSnapshot(opts: {
  id?: string;
  wallets?: Map<string, MonitoredWallet>;
  rankings?: readonly WalletPowerScore[];
}): WalletAuditSnapshot {
  const walletMap = opts.wallets ?? new Map();
  const rankings = opts.rankings ?? [];

  const registry: WalletRegistryResult = {
    wallets: walletMap,
    totalCount: walletMap.size,
    roleBreakdown: { whale: 0, sr: 0, staker: 0, "energy-consumer": 0, delegator: 0 },
    builtAt: new Date(),
  };

  const powerIndex: PowerIndexResult = {
    rankings,
    maxBalance: 0,
    maxVotingPower: 0,
    maxDelegations: 0,
    maxEnergy: 0,
    computedAt: new Date(),
  };

  const networkSummary: NetworkSummary = {
    totalStakedTrx: 40_000_000_000,
    stakingRatio: 0.4,
    totalVotes: 10_000_000_000,
    electedSRCount: 27,
    topHolderCount: 20,
  };

  return Object.freeze({
    id: opts.id ?? "snap-test-0",
    registry,
    powerIndex,
    networkSummary,
    createdAt: new Date(),
  });
}

describe("detectRisks", () => {
  describe("power concentration", () => {
    it("flags CRITICAL when top 5 wallets control >50% of power", () => {
      // 10 wallets, top 5 have high power
      const rankings = [
        makeRanking("T1", 80, 1),
        makeRanking("T2", 70, 2),
        makeRanking("T3", 60, 3),
        makeRanking("T4", 50, 4),
        makeRanking("T5", 40, 5),
        makeRanking("T6", 5, 6),
        makeRanking("T7", 4, 7),
        makeRanking("T8", 3, 8),
        makeRanking("T9", 2, 9),
        makeRanking("T10", 1, 10),
      ];
      // Top 5 sum = 300, total = 315, concentration = 95.2%

      const snapshot = makeSnapshot({ rankings });
      const findings = detectRisks(snapshot, null);

      const concentration = findings.find((f) => f.category === "power-concentration");
      expect(concentration).toBeDefined();
      expect(concentration!.severity).toBe("CRITICAL");
      expect(concentration!.module).toBe("FUNDAMENTAL");
    });

    it("does not flag when power is well-distributed", () => {
      const rankings = Array.from({ length: 20 }, (_, i) =>
        makeRanking(`T${i}`, 10, i + 1),
      );
      // Top 5 sum = 50, total = 200, concentration = 25%

      const snapshot = makeSnapshot({ rankings });
      const findings = detectRisks(snapshot, null);

      const concentration = findings.find((f) => f.category === "power-concentration");
      expect(concentration).toBeUndefined();
    });
  });

  describe("massive unstaking", () => {
    it("flags CRITICAL when a wallet reduces stake >20%", () => {
      const prevWallets = new Map([
        ["TUnstaker", makeWallet("TUnstaker", { votingPower: 1_000_000 })],
      ]);
      const currWallets = new Map([
        ["TUnstaker", makeWallet("TUnstaker", { votingPower: 700_000 })],
      ]);

      const previous = makeSnapshot({ id: "snap-prev", wallets: prevWallets });
      const current = makeSnapshot({ id: "snap-curr", wallets: currWallets });

      const findings = detectRisks(current, previous);

      const unstaking = findings.find((f) => f.category === "massive-unstaking");
      expect(unstaking).toBeDefined();
      expect(unstaking!.severity).toBe("CRITICAL");
      expect(unstaking!.module).toBe("INFRA");
      expect(unstaking!.evidence).toHaveProperty("address", "TUnstaker");
    });

    it("does not flag small stake reductions", () => {
      const prevWallets = new Map([
        ["TSmallReduce", makeWallet("TSmallReduce", { votingPower: 1_000_000 })],
      ]);
      const currWallets = new Map([
        ["TSmallReduce", makeWallet("TSmallReduce", { votingPower: 900_000 })],
      ]);

      const previous = makeSnapshot({ wallets: prevWallets });
      const current = makeSnapshot({ wallets: currWallets });

      const findings = detectRisks(current, previous);

      const unstaking = findings.find((f) => f.category === "massive-unstaking");
      expect(unstaking).toBeUndefined();
    });
  });

  describe("SR rotation", () => {
    it("flags HIGH when an SR loses >30% of votes", () => {
      const prevWallets = new Map([
        ["TSR1", makeWallet("TSR1", { roles: ["sr"] as const satisfies readonly WalletRole[], votingPower: 1_000_000 })],
      ]);
      const currWallets = new Map([
        ["TSR1", makeWallet("TSR1", { roles: ["sr"] as const satisfies readonly WalletRole[], votingPower: 600_000 })],
      ]);

      const previous = makeSnapshot({ wallets: prevWallets });
      const current = makeSnapshot({ wallets: currWallets });

      const findings = detectRisks(current, previous);

      const rotation = findings.find((f) => f.category === "sr-rotation");
      expect(rotation).toBeDefined();
      expect(rotation!.severity).toBe("HIGH");
      expect(rotation!.module).toBe("INFRA");
    });

    it("does not flag non-SR wallets losing votes", () => {
      const prevWallets = new Map([
        ["TNotSR", makeWallet("TNotSR", { roles: ["whale"] as const satisfies readonly WalletRole[], votingPower: 1_000_000 })],
      ]);
      const currWallets = new Map([
        ["TNotSR", makeWallet("TNotSR", { roles: ["whale"] as const satisfies readonly WalletRole[], votingPower: 500_000 })],
      ]);

      const previous = makeSnapshot({ wallets: prevWallets });
      const current = makeSnapshot({ wallets: currWallets });

      const findings = detectRisks(current, previous);

      const rotation = findings.find((f) => f.category === "sr-rotation");
      expect(rotation).toBeUndefined();
    });

    it("does not flag SR with small vote loss", () => {
      const prevWallets = new Map([
        ["TSR2", makeWallet("TSR2", { roles: ["sr"] as const satisfies readonly WalletRole[], votingPower: 1_000_000 })],
      ]);
      const currWallets = new Map([
        ["TSR2", makeWallet("TSR2", { roles: ["sr"] as const satisfies readonly WalletRole[], votingPower: 800_000 })],
      ]);

      const previous = makeSnapshot({ wallets: prevWallets });
      const current = makeSnapshot({ wallets: currWallets });

      const findings = detectRisks(current, previous);

      const rotation = findings.find((f) => f.category === "sr-rotation");
      expect(rotation).toBeUndefined();
    });
  });

  describe("silent accumulation", () => {
    it("flags HIGH when new wallet enters top 20", () => {
      const prevRankings = Array.from({ length: 20 }, (_, i) =>
        makeRanking(`TOld${i}`, 100 - i, i + 1),
      );
      const currRankings = [
        makeRanking("TNewWhale", 95, 2),
        ...prevRankings.slice(0, 19).map((r, i) =>
          makeRanking(r.address, r.powerScore, i === 0 ? 1 : i + 2),
        ),
      ];

      const previous = makeSnapshot({ rankings: prevRankings });
      const current = makeSnapshot({ rankings: currRankings });

      const findings = detectRisks(current, previous);

      const accumulation = findings.find((f) => f.category === "silent-accumulation");
      expect(accumulation).toBeDefined();
      expect(accumulation!.severity).toBe("HIGH");
      expect(accumulation!.module).toBe("FUNDAMENTAL");
      expect(accumulation!.evidence).toHaveProperty("address", "TNewWhale");
    });

    it("does not flag wallets already in top 20", () => {
      const rankings = Array.from({ length: 20 }, (_, i) =>
        makeRanking(`TWallet${i}`, 100 - i, i + 1),
      );

      const previous = makeSnapshot({ rankings });
      const current = makeSnapshot({ rankings });

      const findings = detectRisks(current, previous);

      const accumulation = findings.find((f) => f.category === "silent-accumulation");
      expect(accumulation).toBeUndefined();
    });
  });

  describe("healthy distribution", () => {
    it("flags INFO when power disperses below threshold", () => {
      // Previous: top 5 have 55%, current: top 5 have 40%
      const prevRankings = [
        ...Array.from({ length: 5 }, (_, i) => makeRanking(`TTop${i}`, 22, i + 1)),
        ...Array.from({ length: 5 }, (_, i) => makeRanking(`TBot${i}`, 18, i + 6)),
      ];
      // prev top 5 = 110, total = 200, concentration = 55%

      const currRankings = [
        ...Array.from({ length: 5 }, (_, i) => makeRanking(`TTop${i}`, 16, i + 1)),
        ...Array.from({ length: 5 }, (_, i) => makeRanking(`TBot${i}`, 24, i + 6)),
      ];
      // curr top 5 = 80, total = 200, concentration = 40%

      const previous = makeSnapshot({ rankings: prevRankings });
      const current = makeSnapshot({ rankings: currRankings });

      const findings = detectRisks(current, previous);

      const healthy = findings.find((f) => f.category === "healthy-distribution");
      expect(healthy).toBeDefined();
      expect(healthy!.severity).toBe("INFO");
      expect(healthy!.module).toBe("FUNDAMENTAL");
    });

    it("does not flag when concentration is increasing", () => {
      const prevRankings = Array.from({ length: 10 }, (_, i) =>
        makeRanking(`T${i}`, 10, i + 1),
      );
      const currRankings = [
        makeRanking("T0", 80, 1),
        ...Array.from({ length: 9 }, (_, i) =>
          makeRanking(`T${i + 1}`, 2.22, i + 2),
        ),
      ];

      const previous = makeSnapshot({ rankings: prevRankings });
      const current = makeSnapshot({ rankings: currRankings });

      const findings = detectRisks(current, previous);

      const healthy = findings.find((f) => f.category === "healthy-distribution");
      expect(healthy).toBeUndefined();
    });
  });

  it("returns no findings when there is no previous snapshot", () => {
    // Only concentration check runs without a previous snapshot
    const rankings = Array.from({ length: 20 }, (_, i) =>
      makeRanking(`T${i}`, 10, i + 1),
    );
    const snapshot = makeSnapshot({ rankings });
    const findings = detectRisks(snapshot, null);

    // No concentration alert because power is distributed (25%)
    expect(findings.filter((f) => f.category !== "power-concentration")).toHaveLength(0);
  });

  it("produces findings compatible with AuditFinding interface", () => {
    const rankings = [
      makeRanking("T1", 80, 1),
      makeRanking("T2", 70, 2),
      makeRanking("T3", 60, 3),
      makeRanking("T4", 50, 4),
      makeRanking("T5", 40, 5),
      makeRanking("T6", 1, 6),
    ];

    const snapshot = makeSnapshot({ rankings });
    const findings = detectRisks(snapshot, null);

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toHaveProperty("analyzerName", "risk-detector");
      expect(finding).toHaveProperty("module");
      expect(finding).toHaveProperty("severity");
      expect(finding).toHaveProperty("category");
      expect(finding).toHaveProperty("title");
      expect(finding).toHaveProperty("description");
      expect(finding).toHaveProperty("evidence");
      expect(finding).toHaveProperty("recommendation");
    }
  });
});
