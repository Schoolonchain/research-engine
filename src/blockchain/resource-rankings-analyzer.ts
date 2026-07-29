import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { ResourceRankingsData } from "./resource-rankings-collector.js";

export class ResourceRankingsAnalyzer {
  readonly analyzerName = "resource-rankings";
  readonly modules: readonly AuditModule[] = ["MERCADO", "INFRA", "FUNDAMENTAL"];

  analyze(data: ResourceRankingsData): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    this.checkEnergyConcentration(data, findings);
    this.checkEnergyUtilization(data, findings);
    this.checkDelegationPatterns(data, findings);
    this.checkStakingImbalance(data, findings);
    this.checkNonParticipatingStakers(data, findings);

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

  private checkEnergyConcentration(
    data: ResourceRankingsData,
    findings: AuditFinding[],
  ): void {
    const stakers = data.topStakers.filter((s) => s.energyLimit > 0);
    if (stakers.length < 2) return;

    const totalEnergy = stakers.reduce((sum, s) => sum + s.energyLimit, 0);
    const topEnergy = stakers[0]!.energyLimit;
    const topPct = (topEnergy / totalEnergy) * 100;

    if (topPct > 40) {
      findings.push(
        this.finding(
          "MERCADO",
          topPct > 60 ? "CRITICAL" : "HIGH",
          "energy-allocation-concentration",
          "Energy allocation heavily concentrated",
          `Top account holds ${topPct.toFixed(1)}% of energy among top stakers. This concentration can lead to energy market manipulation.`,
          {
            topAddress: stakers[0]!.address,
            topEnergy,
            totalEnergy,
            topPct: Math.round(topPct * 100) / 100,
          },
          "Monitor large energy holders for potential market manipulation.",
        ),
      );
    }
  }

  private checkEnergyUtilization(
    data: ResourceRankingsData,
    findings: AuditFinding[],
  ): void {
    const withEnergy = data.topStakers.filter((s) => s.energyLimit > 0);
    if (withEnergy.length < 3) return;

    const lowUtilizers = withEnergy.filter((s) => {
      const utilization = s.energyLimit > 0 ? s.energyUsed / s.energyLimit : 0;
      return utilization < 0.05 && s.energyLimit > 1_000_000;
    });

    const lowUtilPct = (lowUtilizers.length / withEnergy.length) * 100;

    if (lowUtilPct >= 30) {
      findings.push(
        this.finding(
          "INFRA",
          "MEDIUM",
          "energy-underutilization",
          "Large energy holders not using allocated energy",
          `${lowUtilizers.length} of ${withEnergy.length} top energy holders (${lowUtilPct.toFixed(0)}%) are using less than 5% of their energy allocation. Wasted energy reduces network efficiency.`,
          {
            lowUtilCount: lowUtilizers.length,
            totalWithEnergy: withEnergy.length,
            lowUtilPct: Math.round(lowUtilPct),
            addresses: lowUtilizers.map((s) => s.address),
          },
          "Accounts holding large energy allocations without using them may benefit from delegating to active users.",
        ),
      );
    }
  }

  private checkDelegationPatterns(
    data: ResourceRankingsData,
    findings: AuditFinding[],
  ): void {
    const { delegationSummaries } = data;
    if (delegationSummaries.length < 3) return;

    const activeDelegators = delegationSummaries.filter(
      (d) => d.delegatedToCount > 0,
    );
    const largeReceivers = delegationSummaries.filter(
      (d) => d.receivedFromCount > 10,
    );

    if (activeDelegators.length > 0) {
      const maxDelegator = activeDelegators.reduce((max, d) =>
        d.delegatedToCount > max.delegatedToCount ? d : max,
      );

      if (maxDelegator.delegatedToCount > 20) {
        findings.push(
          this.finding(
            "MERCADO",
            "HIGH",
            "large-delegator",
            "Account delegating resources to many recipients",
            `Account ${maxDelegator.address} delegates resources to ${maxDelegator.delegatedToCount} accounts. Could indicate an energy rental service or centralized resource distribution.`,
            {
              address: maxDelegator.address,
              delegatedToCount: maxDelegator.delegatedToCount,
            },
            "Investigate whether this is a legitimate energy rental service or potential resource manipulation.",
          ),
        );
      }
    }

    if (largeReceivers.length > 0) {
      const topReceiver = largeReceivers.reduce((max, d) =>
        d.receivedFromCount > max.receivedFromCount ? d : max,
      );

      findings.push(
        this.finding(
          "INFRA",
          "MEDIUM",
          "delegation-sink",
          "Account receiving delegation from many sources",
          `Account ${topReceiver.address} receives delegated resources from ${topReceiver.receivedFromCount} accounts. This may indicate a centralized dApp or exchange resource pool.`,
          {
            address: topReceiver.address,
            receivedFromCount: topReceiver.receivedFromCount,
          },
        ),
      );
    }

    const nonDelegating = delegationSummaries.filter(
      (d) => d.delegatedToCount === 0 && d.receivedFromCount === 0,
    );
    const nonDelegatingPct =
      (nonDelegating.length / delegationSummaries.length) * 100;

    if (nonDelegatingPct >= 50) {
      findings.push(
        this.finding(
          "FUNDAMENTAL",
          "LOW",
          "low-delegation-participation",
          "Top stakers not participating in resource delegation",
          `${nonDelegating.length} of ${delegationSummaries.length} top stakers (${nonDelegatingPct.toFixed(0)}%) neither delegate nor receive delegated resources. This limits resource market liquidity.`,
          {
            nonDelegatingCount: nonDelegating.length,
            totalStakers: delegationSummaries.length,
            nonDelegatingPct: Math.round(nonDelegatingPct),
          },
          "Resource delegation improves network efficiency by routing energy to active users.",
        ),
      );
    }
  }

  private checkStakingImbalance(
    data: ResourceRankingsData,
    findings: AuditFinding[],
  ): void {
    const stakers = data.topStakers.filter(
      (s) => s.frozenForEnergy > 0 || s.frozenForBandwidth > 0,
    );
    if (stakers.length < 3) return;

    const totalEnergy = stakers.reduce(
      (sum, s) => sum + s.frozenForEnergy,
      0,
    );
    const totalBandwidth = stakers.reduce(
      (sum, s) => sum + s.frozenForBandwidth,
      0,
    );

    if (totalEnergy > 0 && totalBandwidth > 0) {
      const ratio = totalEnergy / totalBandwidth;
      if (ratio > 20 || ratio < 0.05) {
        const favored = ratio > 20 ? "energy" : "bandwidth";
        findings.push(
          this.finding(
            "MERCADO",
            "INFO",
            "staking-resource-imbalance",
            "Top staker resource allocation heavily skewed",
            `Top stakers have ${totalEnergy.toLocaleString()} TRX frozen for energy vs ${totalBandwidth.toLocaleString()} TRX for bandwidth (${ratio.toFixed(1)}x ratio). Market strongly favors ${favored} staking.`,
            {
              totalFrozenEnergy: totalEnergy,
              totalFrozenBandwidth: totalBandwidth,
              ratio: Math.round(ratio * 100) / 100,
            },
          ),
        );
      }
    }
  }

  private checkNonParticipatingStakers(
    data: ResourceRankingsData,
    findings: AuditFinding[],
  ): void {
    const stakers = data.topStakers;
    if (stakers.length < 5) return;

    const richNonStakers = stakers.filter(
      (s) =>
        s.balance > 10_000_000 &&
        s.frozenForEnergy === 0 &&
        s.frozenForBandwidth === 0 &&
        s.votingPower === 0,
    );

    if (richNonStakers.length > 0) {
      findings.push(
        this.finding(
          "FUNDAMENTAL",
          "MEDIUM",
          "wealthy-non-stakers",
          "High-balance accounts not staking or voting",
          `${richNonStakers.length} of the top ${stakers.length} accounts hold >10M TRX but do not stake or vote. Combined balance: ${richNonStakers.reduce((sum, s) => sum + s.balance, 0).toLocaleString()} TRX.`,
          {
            count: richNonStakers.length,
            totalStakers: stakers.length,
            combinedBalance: richNonStakers.reduce(
              (sum, s) => sum + s.balance,
              0,
            ),
            addresses: richNonStakers.map((s) => s.address),
          },
          "Large uncommitted TRX holdings weaken network governance and security participation.",
        ),
      );
    }
  }
}
