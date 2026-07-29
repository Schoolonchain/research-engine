import { describe, expect, it } from "vitest";

import { ContractAnalyzer } from "../src/blockchain/contract-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type { TronContractInfo, TronTokenInfo } from "../src/blockchain/audit-model.js";

function makeContract(overrides: Partial<TronContractInfo> = {}): TronContractInfo {
  return {
    address: "TContract1",
    name: "TestContract",
    creatorAddress: "TCreator",
    creationTxHash: "abc123",
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    isVerified: true,
    compilerVersion: "0.8.0",
    abi: [
      { name: "transfer", type: "Function" },
      { name: "approve", type: "Function" },
      { name: "balanceOf", type: "Function" },
    ],
    energyFactor: null,
    callCount: 1000,
    callerCount: 500,
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function snapshot(
  contracts: Map<string, TronContractInfo>,
  tokens: Map<string, TronTokenInfo> = new Map(),
): AuditSnapshot {
  return {
    accounts: new Map(),
    tokens,
    contracts,
    staking: new Map(),
    governance: null,
    collectedAt: new Date(),
  };
}

describe("ContractAnalyzer", () => {
  const analyzer = new ContractAnalyzer();

  it("flags unverified contracts", () => {
    const contracts = new Map([
      ["T1", makeContract({ address: "T1", isVerified: false })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const unverified = findings.find((f) => f.category === "unverified-source");
    expect(unverified).toBeDefined();
    expect(unverified!.severity).toBe("HIGH");
  });

  it("does not flag verified contracts", () => {
    const contracts = new Map([
      ["T1", makeContract({ address: "T1", isVerified: true })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const unverified = findings.find((f) => f.category === "unverified-source");
    expect(unverified).toBeUndefined();
  });

  it("flags proxy pattern without timelock as CRITICAL", () => {
    const contracts = new Map([
      ["T1", makeContract({
        address: "T1",
        abi: [
          { name: "upgradeTo", type: "Function" },
          { name: "implementation", type: "Function" },
          { name: "transfer", type: "Function" },
        ],
      })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const proxy = findings.find((f) => f.category === "proxy-pattern");
    expect(proxy).toBeDefined();
    expect(proxy!.severity).toBe("CRITICAL");
    expect((proxy!.evidence as Record<string, unknown>)["hasTimelock"]).toBe(false);
  });

  it("flags proxy pattern with timelock as MEDIUM", () => {
    const contracts = new Map([
      ["T1", makeContract({
        address: "T1",
        abi: [
          { name: "upgradeTo", type: "Function" },
          { name: "implementation", type: "Function" },
          { name: "setTimelockDelay", type: "Function" },
        ],
      })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const proxy = findings.find((f) => f.category === "proxy-pattern");
    expect(proxy).toBeDefined();
    expect(proxy!.severity).toBe("MEDIUM");
    expect((proxy!.evidence as Record<string, unknown>)["hasTimelock"]).toBe(true);
  });

  it("flags missing standard ERC20 functions for token contracts", () => {
    const contracts = new Map([
      ["T1", makeContract({
        address: "T1",
        abi: [
          { name: "transfer", type: "Function" },
          { name: "balanceOf", type: "Function" },
        ],
      })],
    ]);

    const tokenInfo: TronTokenInfo = {
      contractAddress: "T1",
      name: "TestToken",
      symbol: "TEST",
      decimals: 18,
      totalSupply: "1000000",
      holderCount: 100,
      transferCount: 1000,
      issuerAddress: null,
      iconUrl: null,
      description: null,
      priceUsd: null,
      marketCapUsd: null,
      volume24hUsd: null,
      collectedAt: new Date(),
      source: "test",
    };
    const tokens = new Map([["T1", tokenInfo]]);

    const findings = analyzer.analyze(snapshot(contracts, tokens));

    const incomplete = findings.find((f) => f.category === "incomplete-token-abi");
    expect(incomplete).toBeDefined();
    expect(incomplete!.severity).toBe("MEDIUM");
    expect((incomplete!.evidence as Record<string, unknown>)["missingFunctions"]).toContain("approve");
  });

  it("flags dangerous functions", () => {
    const contracts = new Map([
      ["T1", makeContract({
        address: "T1",
        abi: [
          { name: "selfdestruct", type: "Function" },
          { name: "transfer", type: "Function" },
        ],
      })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const dangerous = findings.find((f) => f.category === "dangerous-functions");
    expect(dangerous).toBeDefined();
    expect(dangerous!.severity).toBe("HIGH");
  });

  it("flags unused contracts older than 30 days", () => {
    const contracts = new Map([
      ["T1", makeContract({
        address: "T1",
        callCount: 0,
        createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
      })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const unused = findings.find((f) => f.category === "unused-contract");
    expect(unused).toBeDefined();
    expect(unused!.severity).toBe("MEDIUM");
  });

  it("does not flag recent unused contracts", () => {
    const contracts = new Map([
      ["T1", makeContract({
        address: "T1",
        callCount: 0,
        createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      })],
    ]);
    const findings = analyzer.analyze(snapshot(contracts));

    const unused = findings.find((f) => f.category === "unused-contract");
    expect(unused).toBeUndefined();
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("contract");
    expect(analyzer.modules).toContain("DESARROLLO");
    expect(analyzer.modules).toContain("RIESGO");
  });
});
