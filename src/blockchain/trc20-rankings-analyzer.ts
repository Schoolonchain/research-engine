import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { Trc20RankingsData, Trc20TokenAnalysis } from "./trc20-rankings-collector.js";

export class Trc20RankingsAnalyzer {
  readonly analyzerName = "trc20-rankings";
  readonly modules: readonly AuditModule[] = ["MERCADO", "RIESGO", "FUNDAMENTAL"];

  analyze(data: Trc20RankingsData): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const analysis of data.tokenAnalyses) {
      this.checkHolderConcentration(analysis, findings);
      this.checkDormantToken(analysis, findings);
      this.checkLowHolderToken(analysis, findings);
    }

    this.checkEcosystemMetrics(data, findings);

    return Object.freeze(findings);
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

  private checkHolderConcentration(
    analysis: Trc20TokenAnalysis,
    findings: AuditFinding[],
  ): void {
    const { token, topHolders, totalSupplyNum } = analysis;
    if (topHolders.length < 2 || totalSupplyNum <= 0) return;

    const topBalance = topHolders[0]!.balanceNum;
    const topPct = (topBalance / totalSupplyNum) * 100;

    if (topPct > 50) {
      findings.push(
        this.finding(
          "RIESGO",
          "CRITICAL",
          "trc20-supply-concentration",
          `${token.symbol}: single holder controls >50% of supply`,
          `Top holder of ${token.name} (${token.symbol}) controls ${topPct.toFixed(1)}% of total supply. Extreme rug-pull or price manipulation risk.`,
          {
            token: token.symbol,
            contractAddress: token.contractAddress,
            topHolderAddress: topHolders[0]!.address,
            topHolderPct: Math.round(topPct * 100) / 100,
            totalSupply: totalSupplyNum,
          },
          "Avoid holding or interacting with tokens where a single address controls the majority of supply.",
        ),
      );
      return;
    }

    const top5Balance = topHolders
      .slice(0, 5)
      .reduce((sum, h) => sum + h.balanceNum, 0);
    const top5Pct = (top5Balance / totalSupplyNum) * 100;

    if (top5Pct > 80) {
      findings.push(
        this.finding(
          "RIESGO",
          "HIGH",
          "trc20-supply-concentration",
          `${token.symbol}: top 5 holders control >80% of supply`,
          `Top 5 holders of ${token.name} (${token.symbol}) control ${top5Pct.toFixed(1)}% of total supply. High price manipulation risk.`,
          {
            token: token.symbol,
            contractAddress: token.contractAddress,
            top5Pct: Math.round(top5Pct * 100) / 100,
            holderCount: token.holderCount,
          },
          "Concentrated token ownership increases volatility and exit risk.",
        ),
      );
    } else if (top5Pct > 50) {
      findings.push(
        this.finding(
          "RIESGO",
          "MEDIUM",
          "trc20-supply-concentration",
          `${token.symbol}: top 5 holders control >50% of supply`,
          `Top 5 holders of ${token.name} (${token.symbol}) control ${top5Pct.toFixed(1)}% of total supply.`,
          {
            token: token.symbol,
            contractAddress: token.contractAddress,
            top5Pct: Math.round(top5Pct * 100) / 100,
            holderCount: token.holderCount,
          },
        ),
      );
    }
  }

  private checkDormantToken(
    analysis: Trc20TokenAnalysis,
    findings: AuditFinding[],
  ): void {
    const { token } = analysis;
    if (token.holderCount < 100) return;

    const transfersPerHolder = token.transferCount / token.holderCount;

    if (transfersPerHolder < 2) {
      findings.push(
        this.finding(
          "MERCADO",
          "LOW",
          "trc20-dormant-token",
          `${token.symbol}: low activity relative to holder count`,
          `${token.name} (${token.symbol}) has ${token.holderCount.toLocaleString()} holders but only ${token.transferCount.toLocaleString()} total transfers (${transfersPerHolder.toFixed(1)} per holder). Token may be dormant or abandoned.`,
          {
            token: token.symbol,
            contractAddress: token.contractAddress,
            holderCount: token.holderCount,
            transferCount: token.transferCount,
            transfersPerHolder: Math.round(transfersPerHolder * 100) / 100,
          },
          "Low activity tokens may have liquidity issues. Verify the project is still active before interacting.",
        ),
      );
    }
  }

  private checkLowHolderToken(
    analysis: Trc20TokenAnalysis,
    findings: AuditFinding[],
  ): void {
    const { token } = analysis;

    if (token.marketCap > 1_000_000 && token.holderCount < 500) {
      findings.push(
        this.finding(
          "RIESGO",
          "HIGH",
          "trc20-low-holder-high-mcap",
          `${token.symbol}: high market cap with few holders`,
          `${token.name} (${token.symbol}) has a market cap of $${token.marketCap.toLocaleString()} but only ${token.holderCount} holders. Potential wash trading or artificial valuation.`,
          {
            token: token.symbol,
            contractAddress: token.contractAddress,
            marketCap: token.marketCap,
            holderCount: token.holderCount,
            mcapPerHolder: Math.round(token.marketCap / token.holderCount),
          },
          "Tokens with high valuations and few holders are high-risk. Market cap may be artificially inflated.",
        ),
      );
    }
  }

  private checkEcosystemMetrics(
    data: Trc20RankingsData,
    findings: AuditFinding[],
  ): void {
    const tokens = data.topTokens;
    if (tokens.length < 5) return;

    const totalMcap = tokens.reduce((sum, t) => sum + t.marketCap, 0);
    if (totalMcap <= 0) return;

    const topMcap = tokens[0]!.marketCap;
    const topMcapPct = (topMcap / totalMcap) * 100;

    if (topMcapPct > 70) {
      findings.push(
        this.finding(
          "MERCADO",
          "INFO",
          "trc20-ecosystem-dominance",
          `TRC20 ecosystem dominated by ${tokens[0]!.symbol}`,
          `${tokens[0]!.name} (${tokens[0]!.symbol}) represents ${topMcapPct.toFixed(1)}% of the top ${tokens.length} TRC20 tokens by market cap. Limited token ecosystem diversity.`,
          {
            dominantToken: tokens[0]!.symbol,
            dominantMcap: topMcap,
            totalMcap,
            topMcapPct: Math.round(topMcapPct * 100) / 100,
          },
        ),
      );
    }

    const stablecoins = tokens.filter((t) =>
      /^(USDT|USDC|USDD|TUSD|BUSD|DAI|USDJ)$/i.test(t.symbol),
    );
    const stableMcap = stablecoins.reduce((sum, t) => sum + t.marketCap, 0);
    const stablePct = (stableMcap / totalMcap) * 100;

    if (stablePct > 80) {
      findings.push(
        this.finding(
          "FUNDAMENTAL",
          "INFO",
          "trc20-stablecoin-dominance",
          "TRC20 ecosystem heavily stablecoin-dependent",
          `Stablecoins represent ${stablePct.toFixed(1)}% of top TRC20 market cap. The ecosystem relies heavily on stablecoin transfers rather than diverse token utility.`,
          {
            stablecoinCount: stablecoins.length,
            stableMcap,
            totalMcap,
            stablePct: Math.round(stablePct * 100) / 100,
            stablecoins: stablecoins.map((s) => s.symbol),
          },
        ),
      );
    }
  }
}
