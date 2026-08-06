import { describe, expect, it } from "vitest";

import { ConcentrationAnalyzer } from "../src/blockchain/concentration-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type { TronAccountInfo, TronTokenInfo } from "../src/blockchain/audit-model.js";

function makeAccount(address: string, balanceSun: string, trc20: TronAccountInfo["trc20Balances"] = []): TronAccountInfo {
  return {
    address,
    balanceSun,
    balanceTrx: "0",
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
    trc20Balances: trc20,
    permissions: [],
    collectedAt: new Date(),
    source: "test",
  };
}

function snapshot(
  accounts: Map<string, TronAccountInfo>,
  tokens: Map<string, TronTokenInfo> = new Map(),
): AuditSnapshot {
  return {
    accounts,
    tokens,
    contracts: new Map(),
    staking: new Map(),
    governance: null,
    collectedAt: new Date(),
  };
}

describe("ConcentrationAnalyzer", () => {
  const analyzer = new ConcentrationAnalyzer();

  it("flags single holder with majority TRX", () => {
    const accounts = new Map([
      ["T1", makeAccount("T1", "90000000")],
      ["T2", makeAccount("T2", "5000000")],
      ["T3", makeAccount("T3", "5000000")],
    ]);

    const findings = analyzer.analyze(snapshot(accounts));

    const majority = findings.find((f) => f.category === "single-holder-majority");
    expect(majority).toBeDefined();
    expect(majority!.severity).toBe("CRITICAL");
  });

  it("does not flag well-distributed TRX", () => {
    const accounts = new Map([
      ["T1", makeAccount("T1", "30000000")],
      ["T2", makeAccount("T2", "35000000")],
      ["T3", makeAccount("T3", "35000000")],
    ]);

    const findings = analyzer.analyze(snapshot(accounts));

    const majority = findings.find((f) => f.category === "single-holder-majority");
    expect(majority).toBeUndefined();
  });

  it("flags token concentration > 80%", () => {
    const trc20whale = [{ contractAddress: "TToken1", symbol: "USDT", name: "Tether", balance: "9000", decimals: 6 }];
    const trc20small = [{ contractAddress: "TToken1", symbol: "USDT", name: "Tether", balance: "1000", decimals: 6 }];

    const accounts = new Map([
      ["T1", makeAccount("T1", "0", trc20whale)],
      ["T2", makeAccount("T2", "0", trc20small)],
    ]);

    const tokenInfo: TronTokenInfo = {
      contractAddress: "TToken1",
      name: "Tether",
      symbol: "USDT",
      decimals: 6,
      totalSupply: "10000000",
      holderCount: 1000,
      transferCount: 50000,
      issuerAddress: null,
      iconUrl: null,
      description: null,
      priceUsd: null,
      marketCapUsd: null,
      volume24hUsd: null,
      collectedAt: new Date(),
      source: "test",
    };
    const tokens = new Map([["TToken1", tokenInfo]]);

    const findings = analyzer.analyze(snapshot(accounts, tokens));

    const concentration = findings.find((f) => f.category === "token-concentration");
    expect(concentration).toBeDefined();
    expect(concentration!.severity).toBe("HIGH");
  });

  it("does not flag token concentration when single holder", () => {
    const trc20 = [{ contractAddress: "TToken1", symbol: "TEST", name: "Test", balance: "1000", decimals: 6 }];

    const accounts = new Map([
      ["T1", makeAccount("T1", "0", trc20)],
    ]);

    const findings = analyzer.analyze(snapshot(accounts));

    const concentration = findings.find((f) => f.category === "token-concentration");
    expect(concentration).toBeUndefined();
  });

  it("skips analysis with fewer than 2 accounts for TRX", () => {
    const accounts = new Map([
      ["T1", makeAccount("T1", "100000000")],
    ]);

    const findings = analyzer.analyze(snapshot(accounts));

    const majority = findings.find((f) => f.category === "single-holder-majority");
    expect(majority).toBeUndefined();
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("concentration");
    expect(analyzer.modules).toContain("RIESGO");
    expect(analyzer.modules).toContain("OSINT");
  });
});
