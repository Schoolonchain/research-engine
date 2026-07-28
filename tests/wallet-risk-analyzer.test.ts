import { describe, expect, it } from "vitest";

import { WalletRiskAnalyzer } from "../src/blockchain/wallet-risk-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type { TronAccountInfo } from "../src/blockchain/audit-model.js";

function makeAccount(overrides: Partial<TronAccountInfo> = {}): TronAccountInfo {
  return {
    address: "TAddr1",
    balanceSun: "10000000",
    balanceTrx: "10",
    createTime: null,
    latestOperationTime: null,
    isContract: false,
    accountName: null,
    frozenBalanceSun: "0",
    energyLimit: 0,
    energyUsed: 0,
    bandwidthLimit: 600,
    bandwidthUsed: 0,
    netLimit: 0,
    netUsed: 0,
    delegatedFrozenBalanceSun: "0",
    trc20Balances: [],
    permissions: [],
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function snapshot(accounts: Map<string, TronAccountInfo>): AuditSnapshot {
  return {
    accounts,
    tokens: new Map(),
    contracts: new Map(),
    staking: new Map(),
    governance: null,
    collectedAt: new Date(),
  };
}

describe("WalletRiskAnalyzer", () => {
  const analyzer = new WalletRiskAnalyzer();

  it("flags energy exhaustion > 95%", () => {
    const accounts = new Map([
      ["T1", makeAccount({ energyLimit: 10000, energyUsed: 9600 })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const exhaustion = findings.find((f) => f.category === "energy-exhaustion");
    expect(exhaustion).toBeDefined();
    expect(exhaustion!.severity).toBe("MEDIUM");
  });

  it("does not flag moderate energy usage", () => {
    const accounts = new Map([
      ["T1", makeAccount({ energyLimit: 10000, energyUsed: 5000 })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const exhaustion = findings.find((f) => f.category === "energy-exhaustion");
    expect(exhaustion).toBeUndefined();
  });

  it("flags bandwidth exhaustion > 95%", () => {
    const accounts = new Map([
      ["T1", makeAccount({ bandwidthLimit: 600, bandwidthUsed: 580 })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const exhaustion = findings.find((f) => f.category === "bandwidth-exhaustion");
    expect(exhaustion).toBeDefined();
    expect(exhaustion!.severity).toBe("LOW");
  });

  it("flags over-delegation > 80%", () => {
    const accounts = new Map([
      ["T1", makeAccount({
        frozenBalanceSun: "5000000",
        delegatedFrozenBalanceSun: "45000000",
      })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const overDeleg = findings.find((f) => f.category === "over-delegation");
    expect(overDeleg).toBeDefined();
    expect(overDeleg!.severity).toBe("MEDIUM");
  });

  it("does not flag low delegation", () => {
    const accounts = new Map([
      ["T1", makeAccount({
        frozenBalanceSun: "40000000",
        delegatedFrozenBalanceSun: "10000000",
      })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const overDeleg = findings.find((f) => f.category === "over-delegation");
    expect(overDeleg).toBeUndefined();
  });

  it("flags dormant high-value accounts", () => {
    const accounts = new Map([
      ["T1", makeAccount({
        balanceSun: "2000000000000",
        balanceTrx: "2000000",
        latestOperationTime: Date.now() - 120 * 24 * 60 * 60 * 1000,
      })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const dormant = findings.find((f) => f.category === "dormant-high-value");
    expect(dormant).toBeDefined();
    expect(dormant!.severity).toBe("MEDIUM");
  });

  it("does not flag active high-value accounts", () => {
    const accounts = new Map([
      ["T1", makeAccount({
        balanceSun: "2000000000000",
        balanceTrx: "2000000",
        latestOperationTime: Date.now() - 5 * 24 * 60 * 60 * 1000,
      })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const dormant = findings.find((f) => f.category === "dormant-high-value");
    expect(dormant).toBeUndefined();
  });

  it("flags many unknown tokens", () => {
    const unknownTokens = Array.from({ length: 8 }, (_, i) => ({
      contractAddress: `TUnknown${i}`,
      symbol: "",
      name: "",
      balance: "1000",
      decimals: 6,
    }));

    const accounts = new Map([
      ["T1", makeAccount({ trc20Balances: unknownTokens })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const manyUnknown = findings.find((f) => f.category === "many-unknown-tokens");
    expect(manyUnknown).toBeDefined();
    expect(manyUnknown!.severity).toBe("LOW");
  });

  it("does not flag few unknown tokens", () => {
    const fewTokens = Array.from({ length: 3 }, (_, i) => ({
      contractAddress: `TUnknown${i}`,
      symbol: "",
      name: "",
      balance: "1000",
      decimals: 6,
    }));

    const accounts = new Map([
      ["T1", makeAccount({ trc20Balances: fewTokens })],
    ]);
    const findings = analyzer.analyze(snapshot(accounts));

    const manyUnknown = findings.find((f) => f.category === "many-unknown-tokens");
    expect(manyUnknown).toBeUndefined();
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("wallet-risk");
    expect(analyzer.modules).toContain("CARTERA");
    expect(analyzer.modules).toContain("RIESGO");
  });
});
