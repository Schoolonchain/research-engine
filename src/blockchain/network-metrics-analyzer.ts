import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { TronNetworkMetrics } from "./network-metrics-collector.js";

export class NetworkMetricsAnalyzer {
  readonly analyzerName = "network-metrics";
  readonly modules: readonly AuditModule[] = ["FUNDAMENTAL", "MERCADO", "INFRA"];

  analyze(metrics: TronNetworkMetrics): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    this.checkEnergyMarket(metrics, findings);
    this.checkBandwidthMarket(metrics, findings);
    this.checkDynamicEnergy(metrics, findings);
    this.checkEconomics(metrics, findings);
    this.checkHolderConcentration(metrics, findings);
    this.checkStakingYield(metrics, findings);

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

  private checkEnergyMarket(
    metrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    const { energyFee, totalEnergyLimit, totalEnergyWeight } = metrics.energy;

    if (energyFee >= 420) {
      findings.push(this.finding(
        "MERCADO",
        energyFee >= 1000 ? "HIGH" : "MEDIUM",
        "high-energy-price",
        "Elevated network energy price",
        `Energy fee is ${energyFee} SUN per unit. High energy prices increase transaction costs for dApps and users.`,
        { energyFee, totalEnergyLimit, totalEnergyWeight },
        "Consider staking TRX for energy instead of paying fees directly.",
      ));
    }

    if (totalEnergyWeight > 0 && totalEnergyLimit > 0) {
      const utilizationRatio = totalEnergyWeight / totalEnergyLimit;
      if (utilizationRatio > 10) {
        findings.push(this.finding(
          "INFRA",
          "MEDIUM",
          "energy-oversaturation",
          "Energy market oversaturated",
          `Total energy weight (${totalEnergyWeight.toLocaleString()}) significantly exceeds energy limit (${totalEnergyLimit.toLocaleString()}). Staking yield is diluted.`,
          { totalEnergyWeight, totalEnergyLimit, ratio: Math.round(utilizationRatio * 100) / 100 },
          "Energy staking returns diminish as more TRX is staked. Evaluate whether direct fee payment is more efficient.",
        ));
      }
    }
  }

  private checkBandwidthMarket(
    metrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    const { transactionFee, totalNetLimit, totalNetWeight } = metrics.bandwidth;

    if (transactionFee >= 1000) {
      findings.push(this.finding(
        "MERCADO",
        "MEDIUM",
        "high-bandwidth-price",
        "Elevated bandwidth transaction fee",
        `Bandwidth transaction fee is ${transactionFee} SUN. High fees increase cost for simple transfers.`,
        { transactionFee, totalNetLimit, totalNetWeight },
      ));
    }
  }

  private checkDynamicEnergy(
    metrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    const { dynamicIncreaseFactor, dynamicMaxFactor, energyFee } = metrics.energy;

    if (dynamicIncreaseFactor > 0 && dynamicMaxFactor > 1) {
      const maxEffectivePrice = energyFee * dynamicMaxFactor;

      findings.push(this.finding(
        "INFRA",
        dynamicMaxFactor >= 10 ? "HIGH" : "LOW",
        "dynamic-energy-pricing",
        "Dynamic energy pricing active",
        `Dynamic energy pricing is enabled with increase factor ${dynamicIncreaseFactor} and max multiplier ${dynamicMaxFactor}x. Actual energy cost can spike to ${maxEffectivePrice} SUN during congestion.`,
        { dynamicIncreaseFactor, dynamicMaxFactor, basePrice: energyFee, maxEffectivePrice },
        "Monitor energy costs during peak usage. Contract calls may cost significantly more during congestion periods.",
      ));
    }
  }

  private checkEconomics(
    metrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    const { createAccountFee, witnessPayPerBlock, witness127PayPerBlock } = metrics.economics;

    if (createAccountFee > 0) {
      const feeInTrx = createAccountFee / 1_000_000;
      if (feeInTrx >= 1) {
        findings.push(this.finding(
          "FUNDAMENTAL",
          "INFO",
          "account-creation-cost",
          "Account creation fee",
          `Creating a new TRON account costs ${feeInTrx} TRX. This is a barrier to entry for new users.`,
          { createAccountFee, feeInTrx },
        ));
      }
    }

    if (witnessPayPerBlock > 0 && witness127PayPerBlock > 0) {
      const rewardRatio = witnessPayPerBlock / witness127PayPerBlock;
      if (rewardRatio > 20) {
        findings.push(this.finding(
          "FUNDAMENTAL",
          "LOW",
          "sr-reward-disparity",
          "High Super Representative reward disparity",
          `Top SRs earn ${witnessPayPerBlock} per block vs ${witness127PayPerBlock} for partners (${Math.round(rewardRatio)}x difference). Heavy centralization of validator incentives.`,
          { witnessPayPerBlock, witness127PayPerBlock, rewardRatio: Math.round(rewardRatio * 100) / 100 },
          "Concentrated rewards may discourage smaller validators from participating.",
        ));
      }
    }
  }

  private checkHolderConcentration(
    metrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    const { topHolders } = metrics;
    if (topHolders.length < 2) return;

    const topBalance = topHolders[0]!.balance;
    const totalAudited = topHolders.reduce((sum, h) => sum + h.balance, 0);

    if (totalAudited > 0) {
      const top1Pct = (topBalance / totalAudited) * 100;
      if (top1Pct > 30) {
        findings.push(this.finding(
          "MERCADO",
          top1Pct > 50 ? "CRITICAL" : "HIGH",
          "whale-concentration",
          "Extreme TRX holder concentration",
          `Top holder controls ${top1Pct.toFixed(1)}% of audited TRX balance. Risk of market manipulation.`,
          {
            topAddress: topHolders[0]!.address,
            topBalance,
            totalAudited,
            top1Pct: Math.round(top1Pct * 100) / 100,
          },
          "Monitor large holder movements for potential market impact.",
        ));
      }

      const top5Balance = topHolders.slice(0, 5).reduce((sum, h) => sum + h.balance, 0);
      const top5Pct = (top5Balance / totalAudited) * 100;
      if (top5Pct > 60 && top1Pct <= 30) {
        findings.push(this.finding(
          "MERCADO",
          "HIGH",
          "top5-concentration",
          "Top 5 holder concentration",
          `Top 5 holders control ${top5Pct.toFixed(1)}% of audited TRX balance.`,
          {
            top5Balance,
            totalAudited,
            top5Pct: Math.round(top5Pct * 100) / 100,
          },
        ));
      }
    }

    const frozenHolders = topHolders.filter((h) => h.totalFrozen > 0);
    const nonStakers = topHolders.filter((h) => h.balance > 1_000_000 && h.totalFrozen === 0);
    if (nonStakers.length > 0 && topHolders.length >= 5) {
      const nonStakingPct = (nonStakers.length / topHolders.length) * 100;
      if (nonStakingPct >= 30) {
        findings.push(this.finding(
          "FUNDAMENTAL",
          "MEDIUM",
          "whale-non-staking",
          "Large holders not staking",
          `${nonStakers.length} of ${topHolders.length} top holders (${nonStakingPct.toFixed(0)}%) with >1M TRX are not staking. This reduces network security.`,
          {
            nonStakingCount: nonStakers.length,
            totalTopHolders: topHolders.length,
            nonStakingPct: Math.round(nonStakingPct),
            frozenCount: frozenHolders.length,
          },
          "Whale engagement in staking strengthens network security and decentralization.",
        ));
      }
    }
  }

  private checkStakingYield(
    metrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    const { energyYieldPerTrx, energyFee } = metrics.energy;
    const { bandwidthYieldPerTrx } = metrics.bandwidth;

    if (energyYieldPerTrx > 0 && energyFee > 0) {
      const dailyEnergyCycles = (24 * 60 * 60 * 1000) / (metrics.economics.maintenanceIntervalMs || 21_600_000);
      const dailyEnergyPerTrx = energyYieldPerTrx * dailyEnergyCycles;
      const dailyFeeEquivalent = dailyEnergyPerTrx * energyFee;
      const annualizedRoi = ((dailyFeeEquivalent * 365) / 1_000_000) * 100;

      if (annualizedRoi < 3) {
        findings.push(this.finding(
          "MERCADO",
          "LOW",
          "low-energy-staking-yield",
          "Low energy staking yield",
          `Annualized energy staking ROI is approximately ${annualizedRoi.toFixed(2)}%. Direct fee payment may be more capital-efficient for low-usage accounts.`,
          {
            energyYieldPerTrx,
            energyFee,
            dailyEnergyPerTrx: Math.round(dailyEnergyPerTrx),
            annualizedRoiPct: Math.round(annualizedRoi * 100) / 100,
          },
          "Compare staking costs vs direct energy fees based on your expected transaction volume.",
        ));
      }

      if (annualizedRoi > 50) {
        findings.push(this.finding(
          "MERCADO",
          "MEDIUM",
          "high-energy-staking-yield",
          "Unusually high energy staking yield",
          `Annualized energy staking ROI is approximately ${annualizedRoi.toFixed(2)}%. This may indicate an energy price spike or low staking competition.`,
          {
            energyYieldPerTrx,
            energyFee,
            annualizedRoiPct: Math.round(annualizedRoi * 100) / 100,
          },
          "High yields attract more stakers, which dilutes returns over time. Consider staking now if yield is attractive.",
        ));
      }
    }

    if (bandwidthYieldPerTrx > 0 && energyYieldPerTrx > 0) {
      const ratio = energyYieldPerTrx / bandwidthYieldPerTrx;
      if (ratio > 5 || ratio < 0.2) {
        const favored = ratio > 5 ? "energy" : "bandwidth";
        findings.push(this.finding(
          "MERCADO",
          "INFO",
          "resource-yield-imbalance",
          "Resource staking yield imbalance",
          `Energy yield per TRX is ${energyYieldPerTrx.toFixed(2)} vs bandwidth ${bandwidthYieldPerTrx.toFixed(2)} (${ratio.toFixed(1)}x ratio). Staking for ${favored} is currently more rewarding.`,
          {
            energyYieldPerTrx,
            bandwidthYieldPerTrx,
            ratio: Math.round(ratio * 100) / 100,
          },
        ));
      }
    }
  }
}
