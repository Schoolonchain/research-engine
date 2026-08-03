import { describe, expect, it } from "vitest";

import { OnchainAnalytics } from "../src/blockchain/onchain-analytics.js";
import type { TronNetworkMetrics } from "../src/blockchain/network-metrics-collector.js";
import type { Trc20RankingsData, Trc20TokenSummary, Trc20TokenAnalysis } from "../src/blockchain/trc20-rankings-collector.js";

function makeNetworkMetrics(overrides: Partial<TronNetworkMetrics> = {}): TronNetworkMetrics {
  return {
    energy: {
      energyFee: 280,
      totalEnergyLimit: 50_000_000_000,
      totalEnergyWeight: 30_000_000_000_000,
      dynamicIncreaseFactor: 0,
      dynamicMaxFactor: 0,
      energyYieldPerTrx: 1.67,
    },
    bandwidth: {
      transactionFee: 1000,
      totalNetLimit: 43_200_000_000,
      totalNetWeight: 15_000_000_000_000,
      bandwidthYieldPerTrx: 2.88,
    },
    economics: {
      createAccountFee: 100_000,
      burnTrxAmount: 1_000_000,
      witnessPayPerBlock: 16_000_000,
      witness127PayPerBlock: 160_000,
      maintenanceIntervalMs: 21_600_000,
      proposalExpireTime: 259_200_000,
    },
    topHolders: [],
    staking: {
      stakedForEnergyTrx: 30_000_000_000,
      stakedForBandwidthTrx: 15_000_000_000,
      totalStakedTrx: 45_000_000_000,
      totalSupplyTrx: 100_000_000_000,
      supplySource: "protocol-constant" as const,
    },
    stakingRatio: 0.5,
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

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

function makeTokenData(overrides: Partial<Trc20RankingsData> = {}): Trc20RankingsData {
  return {
    topTokens: [],
    tokenAnalyses: [],
    collectedAt: new Date(),
    source: "test",
    ...overrides,
  };
}

describe("OnchainAnalytics", () => {
  const analytics = new OnchainAnalytics();

  describe("deflation rate", () => {
    it("computes daily SR emission from block rewards", () => {
      const metrics = makeNetworkMetrics();
      const deflation = analytics.computeDeflation(metrics);

      // 28800 blocks/day * 16 TRX/block = 460,800 TRX/day for SRs
      expect(deflation.dailySrEmissionTrx).toBe(460800);
      // 28800 blocks/day * 0.16 TRX/block = 4,608 TRX/day for partners
      expect(deflation.dailyPartnerEmissionTrx).toBe(4608);
      expect(deflation.totalDailyEmissionTrx).toBe(465408);
      expect(deflation.annualEmissionTrx).toBe(465408 * 365);
    });

    it("estimates burn based on energy utilization", () => {
      const metrics = makeNetworkMetrics();
      const deflation = analytics.computeDeflation(metrics);

      expect(deflation.estimatedDailyBurnTrx).toBeGreaterThan(0);
      expect(deflation.energyFeeSun).toBe(280);
    });

    it("detects deflationary state when burn exceeds emission", () => {
      const metrics = makeNetworkMetrics({
        energy: {
          energyFee: 5000,
          totalEnergyLimit: 50_000_000_000,
          totalEnergyWeight: 50_000_000_000_000,
          dynamicIncreaseFactor: 0,
          dynamicMaxFactor: 0,
          energyYieldPerTrx: 1,
        },
        economics: {
          createAccountFee: 100_000,
          burnTrxAmount: 1_000_000,
          witnessPayPerBlock: 100_000,
          witness127PayPerBlock: 10_000,
          maintenanceIntervalMs: 21_600_000,
          proposalExpireTime: 259_200_000,
        },
      });
      const deflation = analytics.computeDeflation(metrics);

      expect(deflation.isDeflationary).toBe(true);
      expect(deflation.netDailyIssuanceTrx).toBeLessThan(0);
    });

    it("detects inflationary state when emission exceeds burn", () => {
      const metrics = makeNetworkMetrics({
        energy: {
          energyFee: 1,
          totalEnergyLimit: 1_000,
          totalEnergyWeight: 1_000,
          dynamicIncreaseFactor: 0,
          dynamicMaxFactor: 0,
          energyYieldPerTrx: 1,
        },
      });
      const deflation = analytics.computeDeflation(metrics);

      expect(deflation.isDeflationary).toBe(false);
      expect(deflation.netDailyIssuanceTrx).toBeGreaterThan(0);
    });

    it("produces emission status finding", () => {
      const metrics = makeNetworkMetrics();
      const findings = analytics.analyze(metrics);
      const f = findings.find((f) => f.category === "network-emission-status");
      expect(f).toBeDefined();
    });
  });

  describe("token velocity", () => {
    it("classifies high velocity tokens (>= 100 transfers/holder)", () => {
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "USDT", holderCount: 1_000_000, transferCount: 500_000_000 }),
        ],
      });
      const velocities = analytics.computeTokenVelocities(tokenData);

      expect(velocities).toHaveLength(1);
      expect(velocities[0]!.classification).toBe("high");
      expect(velocities[0]!.velocity).toBe(500);
    });

    it("classifies medium velocity tokens (10-100)", () => {
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "MED", holderCount: 10_000, transferCount: 500_000 }),
        ],
      });
      const velocities = analytics.computeTokenVelocities(tokenData);
      expect(velocities[0]!.classification).toBe("medium");
    });

    it("classifies low velocity tokens (2-10)", () => {
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "LOW", holderCount: 10_000, transferCount: 50_000 }),
        ],
      });
      const velocities = analytics.computeTokenVelocities(tokenData);
      expect(velocities[0]!.classification).toBe("low");
    });

    it("classifies dormant tokens (< 2)", () => {
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "DEAD", holderCount: 10_000, transferCount: 5_000 }),
        ],
      });
      const velocities = analytics.computeTokenVelocities(tokenData);
      expect(velocities[0]!.classification).toBe("dormant");
    });

    it("produces finding for dormant tokens", () => {
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "DEAD1", holderCount: 10_000, transferCount: 1_000 }),
          makeToken({ symbol: "DEAD2", holderCount: 5_000, transferCount: 100 }),
        ],
      });
      const findings = analytics.analyze(makeNetworkMetrics(), tokenData);
      const f = findings.find((f) => f.category === "dormant-tokens-detected");
      expect(f).toBeDefined();
      expect(f!.description).toContain("DEAD1");
      expect(f!.description).toContain("DEAD2");
    });

    it("produces finding for high velocity tokens", () => {
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "USDT", holderCount: 1_000, transferCount: 500_000 }),
        ],
      });
      const findings = analytics.analyze(makeNetworkMetrics(), tokenData);
      const f = findings.find((f) => f.category === "high-velocity-tokens");
      expect(f).toBeDefined();
    });
  });

  describe("gini coefficient", () => {
    it("detects extreme concentration (Gini > 0.85)", () => {
      const tokenData = makeTokenData({
        tokenAnalyses: [
          {
            token: makeToken({ symbol: "SCAM", holderCount: 10_000 }),
            topHolders: [
              { address: "TWhale", balance: "900000", balanceNum: 900_000 },
              { address: "TSmall", balance: "1000", balanceNum: 1_000 },
            ],
            totalSupplyNum: 1_000_000,
          },
        ],
      });
      const ginis = analytics.computeGiniCoefficients(tokenData);

      expect(ginis).toHaveLength(1);
      expect(ginis[0]!.classification).toBe("extreme");
      expect(ginis[0]!.giniCoefficient).toBeGreaterThan(0.85);
    });

    it("detects moderate distribution (Gini 0.4-0.6)", () => {
      const holders = Array.from({ length: 20 }, (_, i) => ({
        address: `TH${i}`,
        balance: String((20 - i) * 1000),
        balanceNum: (20 - i) * 1000,
      }));
      const tokenData = makeTokenData({
        tokenAnalyses: [
          {
            token: makeToken({ symbol: "MOD", holderCount: 1_000 }),
            topHolders: holders,
            totalSupplyNum: 500_000,
          },
        ],
      });
      const ginis = analytics.computeGiniCoefficients(tokenData);
      expect(ginis[0]!.giniCoefficient).toBeGreaterThan(0.3);
      expect(ginis[0]!.giniCoefficient).toBeLessThan(0.7);
    });

    it("produces finding for extreme gini", () => {
      const tokenData = makeTokenData({
        topTokens: [],
        tokenAnalyses: [
          {
            token: makeToken({ symbol: "RUG", holderCount: 50_000 }),
            topHolders: [
              { address: "TWhale", balance: "950000", balanceNum: 950_000 },
              { address: "TDust", balance: "100", balanceNum: 100 },
            ],
            totalSupplyNum: 1_000_000,
          },
        ],
      });
      const findings = analytics.analyze(makeNetworkMetrics(), tokenData);
      const f = findings.find((f) => f.category === "extreme-gini-concentration");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("HIGH");
    });

    it("skips tokens with fewer than 2 holders", () => {
      const tokenData = makeTokenData({
        tokenAnalyses: [
          {
            token: makeToken({ symbol: "SOLO", holderCount: 1 }),
            topHolders: [{ address: "TOnly", balance: "1000", balanceNum: 1000 }],
            totalSupplyNum: 1000,
          },
        ],
      });
      const ginis = analytics.computeGiniCoefficients(tokenData);
      expect(ginis).toHaveLength(0);
    });
  });

  describe("health score", () => {
    it("computes high score for healthy network", () => {
      const metrics = makeNetworkMetrics({
        stakingRatio: 0.6,
        economics: {
          createAccountFee: 100_000,
          burnTrxAmount: 1_000_000,
          witnessPayPerBlock: 1_000_000,
          witness127PayPerBlock: 500_000,
          maintenanceIntervalMs: 21_600_000,
          proposalExpireTime: 259_200_000,
        },
      });
      const deflation = analytics.computeDeflation(metrics);
      const score = analytics.computeHealthScore(metrics, deflation, null);

      expect(score.overall).toBeGreaterThanOrEqual(65);
      expect(score.grade).toMatch(/^[AB]$/);
      expect(score.components.stakingHealth).toBe(100);
    });

    it("computes low score for unhealthy network", () => {
      const metrics = makeNetworkMetrics({
        stakingRatio: 0.05,
        energy: {
          energyFee: 2000,
          totalEnergyLimit: 50_000_000_000,
          totalEnergyWeight: 30_000_000_000_000,
          dynamicIncreaseFactor: 5000,
          dynamicMaxFactor: 20,
          energyYieldPerTrx: 1,
        },
        economics: {
          createAccountFee: 100_000,
          burnTrxAmount: 1_000_000,
          witnessPayPerBlock: 50_000_000,
          witness127PayPerBlock: 10_000,
          maintenanceIntervalMs: 21_600_000,
          proposalExpireTime: 259_200_000,
        },
      });
      const deflation = analytics.computeDeflation(metrics);
      const score = analytics.computeHealthScore(metrics, deflation, null);

      expect(score.overall).toBeLessThan(50);
      expect(score.grade).toMatch(/^[DF]$/);
    });

    it("factors in token diversity when data available", () => {
      const metrics = makeNetworkMetrics();
      const deflation = analytics.computeDeflation(metrics);

      const diverseTokens = makeTokenData({
        topTokens: [
          makeToken({ symbol: "T1", marketCap: 200 }),
          makeToken({ symbol: "T2", marketCap: 200 }),
          makeToken({ symbol: "T3", marketCap: 200 }),
          makeToken({ symbol: "T4", marketCap: 200 }),
          makeToken({ symbol: "T5", marketCap: 200 }),
        ],
      });

      const dominatedTokens = makeTokenData({
        topTokens: [
          makeToken({ symbol: "USDT", marketCap: 95 }),
          makeToken({ symbol: "T2", marketCap: 1 }),
          makeToken({ symbol: "T3", marketCap: 1 }),
          makeToken({ symbol: "T4", marketCap: 1 }),
          makeToken({ symbol: "T5", marketCap: 1 }),
        ],
      });

      const diverseScore = analytics.computeHealthScore(metrics, deflation, diverseTokens);
      const dominatedScore = analytics.computeHealthScore(metrics, deflation, dominatedTokens);

      expect(diverseScore.components.tokenDiversity).toBeGreaterThan(
        dominatedScore.components.tokenDiversity,
      );
    });

    it("assigns correct grades", () => {
      const metrics = makeNetworkMetrics({ stakingRatio: 0.6 });
      const deflation = analytics.computeDeflation(metrics);
      const score = analytics.computeHealthScore(metrics, deflation, null);

      const { grade, overall } = score;
      if (overall >= 80) expect(grade).toBe("A");
      else if (overall >= 65) expect(grade).toBe("B");
      else if (overall >= 50) expect(grade).toBe("C");
      else if (overall >= 35) expect(grade).toBe("D");
      else expect(grade).toBe("F");
    });

    it("produces health score finding", () => {
      const findings = analytics.analyze(makeNetworkMetrics());
      const f = findings.find((f) => f.category === "network-health-score");
      expect(f).toBeDefined();
      expect(f!.title).toContain("/100");
    });
  });

  describe("full analysis", () => {
    it("combines all metrics into findings", () => {
      const metrics = makeNetworkMetrics();
      const tokenData = makeTokenData({
        topTokens: [
          makeToken({ symbol: "USDT", holderCount: 1_000_000, transferCount: 500_000_000 }),
          makeToken({ symbol: "DEAD", holderCount: 10_000, transferCount: 1_000 }),
        ],
        tokenAnalyses: [
          {
            token: makeToken({ symbol: "RUG", holderCount: 50_000 }),
            topHolders: [
              { address: "TWhale", balance: "950000", balanceNum: 950_000 },
              { address: "TDust", balance: "100", balanceNum: 100 },
            ],
            totalSupplyNum: 1_000_000,
          },
        ],
      });

      const findings = analytics.analyze(metrics, tokenData);

      const categories = findings.map((f) => f.category);
      expect(categories).toContain("network-emission-status");
      expect(categories).toContain("dormant-tokens-detected");
      expect(categories).toContain("high-velocity-tokens");
      expect(categories).toContain("extreme-gini-concentration");
      expect(categories).toContain("network-health-score");
    });

    it("works without token data", () => {
      const findings = analytics.analyze(makeNetworkMetrics());
      const categories = findings.map((f) => f.category);
      expect(categories).toContain("network-emission-status");
      expect(categories).toContain("network-health-score");
      expect(categories).not.toContain("dormant-tokens-detected");
    });
  });

  it("has correct metadata", () => {
    expect(analytics.analyzerName).toBe("onchain-analytics");
    expect(analytics.modules).toContain("FUNDAMENTAL");
    expect(analytics.modules).toContain("MERCADO");
  });
});
