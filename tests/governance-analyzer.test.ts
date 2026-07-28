import { describe, expect, it } from "vitest";

import { GovernanceAnalyzer } from "../src/blockchain/governance-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type { TronGovernanceData, TronWitness } from "../src/blockchain/tron-governance-collector.js";

function makeWitness(overrides: Partial<TronWitness> = {}): TronWitness {
  return {
    address: "TAddr1",
    url: "https://example.com",
    isElected: true,
    voteCount: 1_000_000,
    totalProduced: 10000,
    totalMissed: 100,
    productivityPct: 99.01,
    latestBlockNum: 60_000_000,
    ...overrides,
  };
}

function makeGovernance(overrides: Partial<TronGovernanceData> = {}): TronGovernanceData {
  return {
    witnesses: [],
    proposals: [],
    chainParameters: {},
    totalVotes: 0,
    electedCount: 0,
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function snapshot(gov: TronGovernanceData | null): AuditSnapshot {
  return {
    accounts: new Map(),
    tokens: new Map(),
    contracts: new Map(),
    staking: new Map(),
    governance: gov,
    collectedAt: new Date(),
  };
}

describe("GovernanceAnalyzer", () => {
  const analyzer = new GovernanceAnalyzer();

  it("flags vote centralization when top-3 > 33%", () => {
    const witnesses = [
      makeWitness({ address: "T1", voteCount: 40_000_000 }),
      makeWitness({ address: "T2", voteCount: 30_000_000 }),
      makeWitness({ address: "T3", voteCount: 20_000_000 }),
      makeWitness({ address: "T4", voteCount: 10_000_000 }),
    ];
    const gov = makeGovernance({
      witnesses,
      totalVotes: 100_000_000,
      electedCount: 4,
    });

    const findings = analyzer.analyze(snapshot(gov));

    const centralization = findings.find((f) => f.category === "vote-centralization");
    expect(centralization).toBeDefined();
    expect(centralization!.severity).toBe("HIGH");
  });

  it("does not flag vote centralization when well-distributed", () => {
    const witnesses = Array.from({ length: 27 }, (_, i) =>
      makeWitness({ address: `T${i}`, voteCount: 1_000_000 }),
    );
    const gov = makeGovernance({
      witnesses,
      totalVotes: 27_000_000,
      electedCount: 27,
    });

    const findings = analyzer.analyze(snapshot(gov));

    const centralization = findings.find((f) => f.category === "vote-centralization");
    expect(centralization).toBeUndefined();
  });

  it("flags low SR productivity", () => {
    const witness = makeWitness({
      productivityPct: 75.0,
      totalProduced: 7500,
      totalMissed: 2500,
    });
    const gov = makeGovernance({
      witnesses: [witness],
      totalVotes: 1_000_000,
      electedCount: 1,
    });

    const findings = analyzer.analyze(snapshot(gov));

    const lowProd = findings.find((f) => f.category === "low-sr-productivity");
    expect(lowProd).toBeDefined();
    expect(lowProd!.severity).toBe("MEDIUM");
  });

  it("does not flag high-productivity SRs", () => {
    const witness = makeWitness({
      productivityPct: 99.5,
      totalProduced: 9950,
      totalMissed: 50,
    });
    const gov = makeGovernance({
      witnesses: [witness],
      totalVotes: 1_000_000,
      electedCount: 1,
    });

    const findings = analyzer.analyze(snapshot(gov));

    const lowProd = findings.find((f) => f.category === "low-sr-productivity");
    expect(lowProd).toBeUndefined();
  });

  it("flags fewer than 27 elected SRs", () => {
    const gov = makeGovernance({ electedCount: 20 });

    const findings = analyzer.analyze(snapshot(gov));

    const lowCount = findings.find((f) => f.category === "low-elected-count");
    expect(lowCount).toBeDefined();
    expect(lowCount!.severity).toBe("MEDIUM");
  });

  it("produces no findings when governance data is null", () => {
    const findings = analyzer.analyze(snapshot(null));
    expect(findings).toHaveLength(0);
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("governance");
    expect(analyzer.modules).toContain("GOBERNANZA");
  });
});
