import { describe, expect, it } from "vitest";

import { Trc20RankingsAnalyzer } from "../src/blockchain/trc20-rankings-analyzer.js";
import type {
  Trc20RankingsData,
  Trc20TokenSummary,
  Trc20TokenAnalysis,
  Trc20HolderEntry,
} from "../src/blockchain/trc20-rankings-collector.js";

function makeToken(overrides: Partial<Trc20TokenSummary> = {}): Trc20TokenSummary {
  return {
    contractAddress: "TDefault",
    name: "DefaultToken",
    symbol: "DFLT",
    decimals: 6,
    holderCount: 100_000,
    transferCount: 5_000_000,
    totalSupply: "1000000000000",
    marketCap: 10_000_000,
    priceUsd: 1.0,
    ...overrides,
  };
}

function makeHolder(overrides: Partial<Trc20HolderEntry> = {}): Trc20HolderEntry {
  return {
    address: "THolder",
    balance: "1000000",
    balanceNum: 1_000,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<Trc20TokenAnalysis> = {}): Trc20TokenAnalysis {
  return {
    token: makeToken(),
    topHolders: [],
    totalSupplyNum: 1_000_000,
    ...overrides,
  };
}

function makeData(overrides: Partial<Trc20RankingsData> = {}): Trc20RankingsData {
  return {
    topTokens: [],
    tokenAnalyses: [],
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

describe("Trc20RankingsAnalyzer", () => {
  const analyzer = new Trc20RankingsAnalyzer();

  describe("holder concentration", () => {
    it("flags CRITICAL when single holder controls >50% of supply", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({ symbol: "SCAM" }),
            topHolders: [
              makeHolder({ address: "TWhale", balanceNum: 600_000 }),
              makeHolder({ address: "TSmall", balanceNum: 100_000 }),
            ],
            totalSupplyNum: 1_000_000,
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-supply-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("CRITICAL");
      expect(f!.description).toContain("SCAM");
    });

    it("flags HIGH when top 5 holders control >80% of supply", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({ symbol: "CONC" }),
            topHolders: [
              makeHolder({ balanceNum: 200_000 }),
              makeHolder({ balanceNum: 200_000 }),
              makeHolder({ balanceNum: 200_000 }),
              makeHolder({ balanceNum: 150_000 }),
              makeHolder({ balanceNum: 100_000 }),
            ],
            totalSupplyNum: 1_000_000,
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-supply-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("flags MEDIUM when top 5 holders control >50% of supply", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({ symbol: "MED" }),
            topHolders: [
              makeHolder({ balanceNum: 150_000 }),
              makeHolder({ balanceNum: 120_000 }),
              makeHolder({ balanceNum: 100_000 }),
              makeHolder({ balanceNum: 80_000 }),
              makeHolder({ balanceNum: 60_000 }),
            ],
            totalSupplyNum: 1_000_000,
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-supply-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("MEDIUM");
    });

    it("does not flag well-distributed tokens", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({ symbol: "SAFE" }),
            topHolders: [
              makeHolder({ balanceNum: 50_000 }),
              makeHolder({ balanceNum: 40_000 }),
              makeHolder({ balanceNum: 30_000 }),
              makeHolder({ balanceNum: 20_000 }),
              makeHolder({ balanceNum: 10_000 }),
            ],
            totalSupplyNum: 1_000_000,
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "trc20-supply-concentration")).toBeUndefined();
    });
  });

  describe("dormant tokens", () => {
    it("flags tokens with low transfers per holder", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({
              symbol: "DEAD",
              holderCount: 10_000,
              transferCount: 5_000,
            }),
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-dormant-token");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("LOW");
    });

    it("does not flag active tokens", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({
              symbol: "ACTIVE",
              holderCount: 10_000,
              transferCount: 500_000,
            }),
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "trc20-dormant-token")).toBeUndefined();
    });

    it("skips tokens with fewer than 100 holders", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({
              symbol: "TINY",
              holderCount: 50,
              transferCount: 10,
            }),
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "trc20-dormant-token")).toBeUndefined();
    });
  });

  describe("low holder high mcap", () => {
    it("flags tokens with high mcap but few holders", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({
              symbol: "FAKE",
              marketCap: 5_000_000,
              holderCount: 100,
            }),
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-low-holder-high-mcap");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("does not flag tokens with proportional holders", () => {
      const data = makeData({
        tokenAnalyses: [
          makeAnalysis({
            token: makeToken({
              symbol: "LEGIT",
              marketCap: 5_000_000,
              holderCount: 50_000,
            }),
          }),
        ],
      });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "trc20-low-holder-high-mcap")).toBeUndefined();
    });
  });

  describe("ecosystem metrics", () => {
    it("flags ecosystem dominance when top token >70% mcap", () => {
      const tokens = [
        makeToken({ symbol: "USDT", marketCap: 60_000_000_000 }),
        makeToken({ symbol: "USDC", marketCap: 500_000_000 }),
        makeToken({ symbol: "T1", marketCap: 100_000_000 }),
        makeToken({ symbol: "T2", marketCap: 50_000_000 }),
        makeToken({ symbol: "T3", marketCap: 10_000_000 }),
      ];
      const data = makeData({ topTokens: tokens });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-ecosystem-dominance");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("INFO");
      expect(f!.description).toContain("USDT");
    });

    it("flags stablecoin dominance when stablecoins >80% mcap", () => {
      const tokens = [
        makeToken({ symbol: "USDT", marketCap: 60_000_000_000 }),
        makeToken({ symbol: "USDC", marketCap: 5_000_000_000 }),
        makeToken({ symbol: "USDD", marketCap: 1_000_000_000 }),
        makeToken({ symbol: "T1", marketCap: 100_000_000 }),
        makeToken({ symbol: "T2", marketCap: 50_000_000 }),
      ];
      const data = makeData({ topTokens: tokens });
      const findings = analyzer.analyze(data);
      const f = findings.find((f) => f.category === "trc20-stablecoin-dominance");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("INFO");
    });

    it("does not flag diverse ecosystem", () => {
      const tokens = [
        makeToken({ symbol: "T1", marketCap: 300_000_000 }),
        makeToken({ symbol: "T2", marketCap: 250_000_000 }),
        makeToken({ symbol: "T3", marketCap: 200_000_000 }),
        makeToken({ symbol: "T4", marketCap: 150_000_000 }),
        makeToken({ symbol: "T5", marketCap: 100_000_000 }),
      ];
      const data = makeData({ topTokens: tokens });
      const findings = analyzer.analyze(data);
      expect(findings.find((f) => f.category === "trc20-ecosystem-dominance")).toBeUndefined();
      expect(findings.find((f) => f.category === "trc20-stablecoin-dominance")).toBeUndefined();
    });
  });

  it("has correct metadata", () => {
    expect(analyzer.analyzerName).toBe("trc20-rankings");
    expect(analyzer.modules).toContain("MERCADO");
    expect(analyzer.modules).toContain("RIESGO");
    expect(analyzer.modules).toContain("FUNDAMENTAL");
  });

  it("produces no findings for healthy token data", () => {
    const tokens = [
      makeToken({ symbol: "T1", marketCap: 300_000_000, holderCount: 100_000 }),
      makeToken({ symbol: "T2", marketCap: 250_000_000, holderCount: 80_000 }),
      makeToken({ symbol: "T3", marketCap: 200_000_000, holderCount: 60_000 }),
      makeToken({ symbol: "T4", marketCap: 150_000_000, holderCount: 50_000 }),
      makeToken({ symbol: "T5", marketCap: 100_000_000, holderCount: 40_000 }),
    ];
    const analyses = tokens.map((t) =>
      makeAnalysis({
        token: t,
        topHolders: Array.from({ length: 5 }, (_, i) =>
          makeHolder({ address: `TH${i}`, balanceNum: 10_000 }),
        ),
        totalSupplyNum: 1_000_000,
      }),
    );
    const data = makeData({ topTokens: tokens, tokenAnalyses: analyses });
    const findings = analyzer.analyze(data);
    expect(findings.map((f) => f.category)).toEqual([]);
  });
});
