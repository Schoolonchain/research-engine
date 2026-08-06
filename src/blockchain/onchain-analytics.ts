import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { TronNetworkMetrics } from "./network-metrics-collector.js";
import type { Trc20RankingsData, Trc20TokenAnalysis } from "./trc20-rankings-collector.js";

const TRON_BLOCK_TIME_S = 3;
const BLOCKS_PER_DAY = (24 * 60 * 60) / TRON_BLOCK_TIME_S;
const SUN_PER_TRX = 1_000_000;

export interface DeflationMetrics {
  readonly dailySrEmissionTrx: number;
  readonly dailyPartnerEmissionTrx: number;
  readonly totalDailyEmissionTrx: number;
  readonly annualEmissionTrx: number;
  readonly energyFeeSun: number;
  readonly estimatedDailyBurnTrx: number;
  readonly netDailyIssuanceTrx: number;
  readonly isDeflationary: boolean;
}

export interface TokenVelocity {
  readonly symbol: string;
  readonly contractAddress: string;
  readonly holderCount: number;
  readonly transferCount: number;
  readonly velocity: number;
  readonly classification: "high" | "medium" | "low" | "dormant";
}

export interface GiniResult {
  readonly symbol: string;
  readonly contractAddress: string;
  readonly giniCoefficient: number;
  readonly classification: "egalitarian" | "moderate" | "concentrated" | "extreme" | "insufficient-data";
  readonly topHolderCount: number;
  readonly totalHolderCount: number;
}

export interface HealthScoreComponents {
  readonly stakingHealth: number;
  readonly decentralization: number;
  readonly energyMarket: number;
  readonly tokenDiversity: number;
  readonly emissionSustainability: number;
}

export interface NetworkHealthScore {
  readonly overall: number;
  readonly grade: "A" | "B" | "C" | "D" | "F";
  readonly components: HealthScoreComponents;
}

export interface OnchainAnalyticsResult {
  readonly deflation: DeflationMetrics;
  readonly tokenVelocities: readonly TokenVelocity[];
  readonly giniCoefficients: readonly GiniResult[];
  readonly healthScore: NetworkHealthScore;
}

export class OnchainAnalytics {
  readonly analyzerName = "onchain-analytics";
  readonly modules: readonly AuditModule[] = ["FUNDAMENTAL", "MERCADO"];

  compute(
    networkMetrics: TronNetworkMetrics,
    tokenData: Trc20RankingsData | null = null,
  ): OnchainAnalyticsResult {
    const deflation = this.computeDeflation(networkMetrics);
    const tokenVelocities = tokenData
      ? this.computeTokenVelocities(tokenData)
      : [];
    const giniCoefficients = tokenData
      ? this.computeGiniCoefficients(tokenData)
      : [];
    const healthScore = this.computeHealthScore(
      networkMetrics,
      deflation,
      tokenData,
    );

    return Object.freeze({
      deflation: Object.freeze(deflation),
      tokenVelocities: Object.freeze(tokenVelocities),
      giniCoefficients: Object.freeze(giniCoefficients),
      healthScore: Object.freeze(healthScore),
    });
  }

  analyze(
    networkMetrics: TronNetworkMetrics,
    tokenData: Trc20RankingsData | null = null,
  ): readonly AuditFinding[] {
    const result = this.compute(networkMetrics, tokenData);
    const findings: AuditFinding[] = [];

    this.analyzeDeflation(result.deflation, findings);
    this.analyzeTokenVelocities(result.tokenVelocities, findings);
    this.analyzeGini(result.giniCoefficients, findings);
    this.analyzeHealthScore(result.healthScore, findings);

    return Object.freeze(findings);
  }

  computeDeflation(metrics: TronNetworkMetrics): DeflationMetrics {
    const { witnessPayPerBlock, witness127PayPerBlock } = metrics.economics;
    const { energyFee, totalEnergyLimit, totalEnergyWeight } = metrics.energy;

    const dailySrEmissionTrx =
      (witnessPayPerBlock * BLOCKS_PER_DAY) / SUN_PER_TRX;
    const dailyPartnerEmissionTrx =
      (witness127PayPerBlock * BLOCKS_PER_DAY) / SUN_PER_TRX;
    const totalDailyEmissionTrx = dailySrEmissionTrx + dailyPartnerEmissionTrx;
    const annualEmissionTrx = totalDailyEmissionTrx * 365;

    const utilizationRatio =
      totalEnergyLimit > 0 && totalEnergyWeight > 0
        ? Math.min(totalEnergyWeight / totalEnergyLimit, 100)
        : 0;
    const estimatedDailyEnergyUsed = totalEnergyLimit * Math.min(utilizationRatio * 0.1, 1);
    const estimatedDailyBurnTrx =
      (estimatedDailyEnergyUsed * energyFee) / SUN_PER_TRX;

    const netDailyIssuanceTrx = totalDailyEmissionTrx - estimatedDailyBurnTrx;

    return {
      dailySrEmissionTrx: Math.round(dailySrEmissionTrx),
      dailyPartnerEmissionTrx: Math.round(dailyPartnerEmissionTrx),
      totalDailyEmissionTrx: Math.round(totalDailyEmissionTrx),
      annualEmissionTrx: Math.round(annualEmissionTrx),
      energyFeeSun: energyFee,
      estimatedDailyBurnTrx: Math.round(estimatedDailyBurnTrx),
      netDailyIssuanceTrx: Math.round(netDailyIssuanceTrx),
      isDeflationary: netDailyIssuanceTrx < 0,
    };
  }

  computeTokenVelocities(
    tokenData: Trc20RankingsData,
  ): readonly TokenVelocity[] {
    return tokenData.topTokens
      .filter((t) => t.holderCount > 0)
      .map((t) => {
        const velocity = t.transferCount / t.holderCount;
        let classification: TokenVelocity["classification"];
        if (velocity >= 100) classification = "high";
        else if (velocity >= 10) classification = "medium";
        else if (velocity >= 2) classification = "low";
        else classification = "dormant";

        return Object.freeze({
          symbol: t.symbol,
          contractAddress: t.contractAddress,
          holderCount: t.holderCount,
          transferCount: t.transferCount,
          velocity: Math.round(velocity * 100) / 100,
          classification,
        });
      });
  }

  computeGiniCoefficients(
    tokenData: Trc20RankingsData,
  ): readonly GiniResult[] {
    return tokenData.tokenAnalyses
      .filter((a) => a.topHolders.length >= 2 && a.totalSupplyNum > 0)
      .map((analysis) => {
        const gini = this.approximateGini(analysis);

        // M-04: -1 sentinel means all observed balances were 0 (data missing).
        // Report as "insufficient-data" so consumers don't confuse it with equality.
        if (gini < 0) {
          return Object.freeze({
            symbol: analysis.token.symbol,
            contractAddress: analysis.token.contractAddress,
            giniCoefficient: -1,
            classification: "insufficient-data" as const,
            topHolderCount: analysis.topHolders.length,
            totalHolderCount: analysis.token.holderCount,
          });
        }

        let classification: GiniResult["classification"];
        if (gini < 0.4) classification = "egalitarian";
        else if (gini < 0.6) classification = "moderate";
        else if (gini < 0.85) classification = "concentrated";
        else classification = "extreme";

        return Object.freeze({
          symbol: analysis.token.symbol,
          contractAddress: analysis.token.contractAddress,
          giniCoefficient: Math.round(gini * 10000) / 10000,
          classification,
          topHolderCount: analysis.topHolders.length,
          totalHolderCount: analysis.token.holderCount,
        });
      });
  }

  private approximateGini(analysis: Trc20TokenAnalysis): number {
    const { topHolders, totalSupplyNum } = analysis;
    const totalHolderCount = analysis.token.holderCount;
    if (totalHolderCount < 2 || totalSupplyNum <= 0) return 0;

    // M-04: If every observed holder has balanceNum 0, the Gini is meaningless —
    // the data is missing, not "perfectly equal".  Return -1 as a sentinel.
    const topSum = topHolders.reduce((s, h) => s + h.balanceNum, 0);
    if (topHolders.length > 0 && topSum === 0) return -1;
    const remainingSupply = Math.max(0, totalSupplyNum - topSum);
    const remainingHolders = Math.max(1, totalHolderCount - topHolders.length);
    const avgRemaining = remainingSupply / remainingHolders;

    const balances: number[] = [];
    for (const h of topHolders) {
      balances.push(h.balanceNum);
    }
    for (let i = 0; i < Math.min(remainingHolders, 1000); i++) {
      balances.push(avgRemaining);
    }

    balances.sort((a, b) => a - b);
    const n = balances.length;
    const total = balances.reduce((s, b) => s + b, 0);
    if (total === 0) return 0;

    let cumulativeSum = 0;
    let weightedSum = 0;
    for (let i = 0; i < n; i++) {
      cumulativeSum += balances[i]!;
      weightedSum += (2 * (i + 1) - n - 1) * balances[i]!;
    }

    return Math.max(0, Math.min(1, weightedSum / (n * total)));
  }

  computeHealthScore(
    metrics: TronNetworkMetrics,
    deflation: DeflationMetrics,
    tokenData: Trc20RankingsData | null,
  ): NetworkHealthScore {
    const stakingHealth = this.scoreStaking(metrics);
    const decentralization = this.scoreDecentralization(metrics);
    const energyMarket = this.scoreEnergyMarket(metrics);
    const tokenDiversity = tokenData
      ? this.scoreTokenDiversity(tokenData)
      : 50;
    const emissionSustainability = this.scoreEmission(deflation);

    const overall = Math.round(
      stakingHealth * 0.2 +
        decentralization * 0.2 +
        energyMarket * 0.2 +
        tokenDiversity * 0.15 +
        emissionSustainability * 0.25,
    );

    let grade: NetworkHealthScore["grade"];
    if (overall >= 80) grade = "A";
    else if (overall >= 65) grade = "B";
    else if (overall >= 50) grade = "C";
    else if (overall >= 35) grade = "D";
    else grade = "F";

    return {
      overall,
      grade,
      components: Object.freeze({
        stakingHealth,
        decentralization,
        energyMarket,
        tokenDiversity,
        emissionSustainability,
      }),
    };
  }

  private scoreStaking(metrics: TronNetworkMetrics): number {
    const ratio = metrics.stakingRatio;
    if (ratio >= 0.5) return 100;
    if (ratio >= 0.3) return 70 + ((ratio - 0.3) / 0.2) * 30;
    if (ratio >= 0.1) return 30 + ((ratio - 0.1) / 0.2) * 40;
    return Math.round(ratio * 300);
  }

  private scoreDecentralization(metrics: TronNetworkMetrics): number {
    const { witnessPayPerBlock, witness127PayPerBlock } = metrics.economics;
    if (witnessPayPerBlock === 0 || witness127PayPerBlock === 0) return 50;

    const ratio = witnessPayPerBlock / witness127PayPerBlock;
    if (ratio <= 5) return 100;
    if (ratio <= 20) return 60 + ((20 - ratio) / 15) * 40;
    if (ratio <= 100) return 20 + ((100 - ratio) / 80) * 40;
    return 10;
  }

  private scoreEnergyMarket(metrics: TronNetworkMetrics): number {
    const { energyFee, dynamicMaxFactor } = metrics.energy;
    let score = 100;

    if (energyFee >= 1000) score -= 40;
    else if (energyFee >= 420) score -= 20;

    if (dynamicMaxFactor >= 10) score -= 30;
    else if (dynamicMaxFactor > 1) score -= 10;

    return Math.max(0, score);
  }

  private scoreTokenDiversity(tokenData: Trc20RankingsData): number {
    const tokens = tokenData.topTokens;
    if (tokens.length < 2) return 30;

    const totalMcap = tokens.reduce((s, t) => s + t.marketCap, 0);
    if (totalMcap === 0) return 50;

    const topPct = (tokens[0]!.marketCap / totalMcap) * 100;

    if (topPct > 90) return 15;
    if (topPct > 70) return 35;
    if (topPct > 50) return 55;
    return 80;
  }

  private scoreEmission(deflation: DeflationMetrics): number {
    if (deflation.isDeflationary) return 100;

    const { totalDailyEmissionTrx, estimatedDailyBurnTrx } = deflation;
    if (totalDailyEmissionTrx === 0) return 50;

    const burnRatio = estimatedDailyBurnTrx / totalDailyEmissionTrx;
    if (burnRatio >= 0.8) return 85;
    if (burnRatio >= 0.5) return 65;
    if (burnRatio >= 0.2) return 45;
    return 25;
  }

  private finding(
    module: AuditModule,
    severity: Severity,
    category: string,
    title: string,
    description: string,
    evidence: Record<string, unknown>,
    recommendation: string | null = null,
  ): AuditFinding {
    return {
      analyzerName: this.analyzerName,
      module,
      severity,
      category,
      title,
      description,
      evidence,
      recommendation,
    };
  }

  private analyzeDeflation(
    deflation: DeflationMetrics,
    findings: AuditFinding[],
  ): void {
    findings.push(
      this.finding(
        "FUNDAMENTAL",
        deflation.isDeflationary ? "INFO" : "LOW",
        "network-emission-status",
        deflation.isDeflationary
          ? "Network is deflationary"
          : "Network is inflationary",
        deflation.isDeflationary
          ? `TRON is currently deflationary: estimated daily burn (${deflation.estimatedDailyBurnTrx.toLocaleString()} TRX) exceeds block reward emission (${deflation.totalDailyEmissionTrx.toLocaleString()} TRX). Net daily reduction: ${Math.abs(deflation.netDailyIssuanceTrx).toLocaleString()} TRX.`
          : `TRON is currently inflationary: block rewards emit ${deflation.totalDailyEmissionTrx.toLocaleString()} TRX/day while estimated burns are ${deflation.estimatedDailyBurnTrx.toLocaleString()} TRX/day. Net daily issuance: ${deflation.netDailyIssuanceTrx.toLocaleString()} TRX.`,
        {
          dailySrEmissionTrx: deflation.dailySrEmissionTrx,
          dailyPartnerEmissionTrx: deflation.dailyPartnerEmissionTrx,
          totalDailyEmissionTrx: deflation.totalDailyEmissionTrx,
          estimatedDailyBurnTrx: deflation.estimatedDailyBurnTrx,
          netDailyIssuanceTrx: deflation.netDailyIssuanceTrx,
          annualEmissionTrx: deflation.annualEmissionTrx,
          isDeflationary: deflation.isDeflationary,
        },
      ),
    );
  }

  private analyzeTokenVelocities(
    velocities: readonly TokenVelocity[],
    findings: AuditFinding[],
  ): void {
    const dormant = velocities.filter((v) => v.classification === "dormant");
    if (dormant.length > 0) {
      findings.push(
        this.finding(
          "MERCADO",
          "LOW",
          "dormant-tokens-detected",
          `${dormant.length} top token(s) with near-zero velocity`,
          `${dormant.map((d) => d.symbol).join(", ")} have fewer than 2 transfers per holder, indicating minimal on-chain usage despite holder presence.`,
          {
            dormantTokens: dormant.map((d) => ({
              symbol: d.symbol,
              velocity: d.velocity,
              holderCount: d.holderCount,
            })),
          },
        ),
      );
    }

    const high = velocities.filter((v) => v.classification === "high");
    if (high.length > 0) {
      findings.push(
        this.finding(
          "MERCADO",
          "INFO",
          "high-velocity-tokens",
          `${high.length} token(s) with high transaction velocity`,
          `${high.map((h) => `${h.symbol} (${h.velocity}x)`).join(", ")} show strong transactional usage — each holder has made 100+ transfers on average.`,
          {
            highVelocityTokens: high.map((h) => ({
              symbol: h.symbol,
              velocity: h.velocity,
              holderCount: h.holderCount,
            })),
          },
        ),
      );
    }
  }

  private analyzeGini(
    ginis: readonly GiniResult[],
    findings: AuditFinding[],
  ): void {
    const extreme = ginis.filter((g) => g.classification === "extreme");
    if (extreme.length > 0) {
      findings.push(
        this.finding(
          "MERCADO",
          "HIGH",
          "extreme-gini-concentration",
          `${extreme.length} token(s) with extreme wealth concentration (Gini > 0.85)`,
          `${extreme.map((e) => `${e.symbol} (Gini=${e.giniCoefficient})`).join(", ")} have extremely concentrated ownership. High manipulation and rug-pull risk.`,
          {
            tokens: extreme.map((e) => ({
              symbol: e.symbol,
              gini: e.giniCoefficient,
              classification: e.classification,
            })),
          },
          "Tokens with Gini coefficients above 0.85 are at high risk of price manipulation by a small group of holders.",
        ),
      );
    }
  }

  private analyzeHealthScore(
    score: NetworkHealthScore,
    findings: AuditFinding[],
  ): void {
    let severity: Severity;
    if (score.overall >= 65) severity = "INFO";
    else if (score.overall >= 50) severity = "LOW";
    else if (score.overall >= 35) severity = "MEDIUM";
    else severity = "HIGH";

    findings.push(
      this.finding(
        "FUNDAMENTAL",
        severity,
        "network-health-score",
        `TRON Network Health Score: ${score.overall}/100 (${score.grade})`,
        `Composite score: staking ${score.components.stakingHealth}, decentralization ${score.components.decentralization}, energy market ${score.components.energyMarket}, token diversity ${score.components.tokenDiversity}, emission sustainability ${score.components.emissionSustainability}.`,
        {
          overall: score.overall,
          grade: score.grade,
          ...score.components,
        },
      ),
    );
  }
}
