import { describe, expect, it } from "vitest";

import { TokenomicsAnalyzer } from "../src/blockchain/tokenomics-analyzer.js";
import type { AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import type { TronTokenInfo } from "../src/blockchain/audit-model.js";

function makeToken(overrides: Partial<TronTokenInfo> = {}): TronTokenInfo {
  return {
    contractAddress: "TToken1",
    name: "TestToken",
    symbol: "TEST",
    decimals: 18,
    totalSupply: "1000000000000000000000000",
    holderCount: 5000,
    transferCount: 100000,
    issuerAddress: null,
    iconUrl: null,
    description: null,
    priceUsd: null,
    marketCapUsd: null,
    volume24hUsd: null,
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

function snapshot(tokens: Map<string, TronTokenInfo>): AuditSnapshot {
  return {
    accounts: new Map(),
    tokens,
    contracts: new Map(),
    staking: new Map(),
    governance: null,
    collectedAt: new Date(),
  };
}

describe("TokenomicsAnalyzer", () => {
  const analyzer = new TokenomicsAnalyzer();

  it("flags zero total supply", () => {
    const tokens = new Map([["T1", makeToken({ totalSupply: "0" })]]);
    const findings = analyzer.analyze(snapshot(tokens));

    const zeroSupply = findings.find((f) => f.category === "zero-supply");
    expect(zeroSupply).toBeDefined();
    expect(zeroSupply!.severity).toBe("HIGH");
  });

  it("flags very few holders (< 10)", () => {
    const tokens = new Map([["T1", makeToken({ holderCount: 5 })]]);
    const findings = analyzer.analyze(snapshot(tokens));

    const fewHolders = findings.find((f) => f.category === "very-few-holders");
    expect(fewHolders).toBeDefined();
    expect(fewHolders!.severity).toBe("HIGH");
  });

  it("flags low holder count (10-99)", () => {
    const tokens = new Map([["T1", makeToken({ holderCount: 50 })]]);
    const findings = analyzer.analyze(snapshot(tokens));

    const lowHolders = findings.find((f) => f.category === "low-holder-count");
    expect(lowHolders).toBeDefined();
    expect(lowHolders!.severity).toBe("MEDIUM");
  });

  it("does not flag healthy holder count", () => {
    const tokens = new Map([["T1", makeToken({ holderCount: 10000 })]]);
    const findings = analyzer.analyze(snapshot(tokens));

    const holderFindings = findings.filter(
      (f) => f.category === "very-few-holders" || f.category === "low-holder-count",
    );
    expect(holderFindings).toHaveLength(0);
  });

  it("flags extremely low volume relative to market cap", () => {
    const tokens = new Map([
      ["T1", makeToken({
        priceUsd: 1.0,
        marketCapUsd: 100_000_000,
        volume24hUsd: 50_000,
      })],
    ]);
    const findings = analyzer.analyze(snapshot(tokens));

    const lowVol = findings.find((f) => f.category === "extremely-low-volume");
    expect(lowVol).toBeDefined();
    expect(lowVol!.severity).toBe("MEDIUM");
  });

  it("does not flag adequate volume", () => {
    const tokens = new Map([
      ["T1", makeToken({
        priceUsd: 1.0,
        marketCapUsd: 100_000_000,
        volume24hUsd: 5_000_000,
      })],
    ]);
    const findings = analyzer.analyze(snapshot(tokens));

    const lowVol = findings.find((f) => f.category === "extremely-low-volume");
    expect(lowVol).toBeUndefined();
  });

  it("flags stale token with holders but no transfers", () => {
    const tokens = new Map([
      ["T1", makeToken({ holderCount: 500, transferCount: 0 })],
    ]);
    const findings = analyzer.analyze(snapshot(tokens));

    const noTransfers = findings.find((f) => f.category === "no-recent-transfers");
    expect(noTransfers).toBeDefined();
    expect(noTransfers!.severity).toBe("MEDIUM");
  });

  it("produces no findings for a healthy token", () => {
    const tokens = new Map([
      ["T1", makeToken({
        holderCount: 50000,
        transferCount: 1_000_000,
        totalSupply: "1000000000000000000",
      })],
    ]);
    const findings = analyzer.analyze(snapshot(tokens));
    expect(findings).toHaveLength(0);
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("tokenomics");
    expect(analyzer.modules).toContain("FUNDAMENTAL");
    expect(analyzer.modules).toContain("MERCADO");
  });
});
