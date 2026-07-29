import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { EnergyRentalMarketData, PlatformActivity } from "./energy-rental-collector.js";
import type { TronNetworkMetrics } from "./network-metrics-collector.js";

export interface EnergyMarketComparison {
  readonly directFeeCostPer100k: number;
  readonly selfStakeRequiredFor100k: number;
  readonly rentalMarketVolume: number;
  readonly rentalProviderCount: number;
  readonly rentalConsumerCount: number;
  readonly platformCount: number;
}

export class EnergyRentalAnalyzer {
  readonly analyzerName = "energy-rental";
  readonly modules: readonly AuditModule[] = ["MERCADO", "INFRA"];

  analyze(
    rentalData: EnergyRentalMarketData,
    networkMetrics: TronNetworkMetrics,
  ): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const activity of rentalData.platforms) {
      this.checkPlatformVolume(activity, findings);
      this.checkDelegationConcentration(activity, findings);
      this.checkPaymentPatterns(activity, findings);
    }

    this.checkMarketComparison(rentalData, networkMetrics, findings);
    this.checkRentalMarketSize(rentalData, networkMetrics, findings);

    return Object.freeze(findings);
  }

  computeMarketComparison(
    rentalData: EnergyRentalMarketData,
    networkMetrics: TronNetworkMetrics,
  ): EnergyMarketComparison {
    const { energyFee } = networkMetrics.energy;
    const { energyYieldPerTrx } = networkMetrics.energy;

    const directFeeCostPer100k = (100_000 * energyFee) / 1_000_000;

    const selfStakeRequiredFor100k =
      energyYieldPerTrx > 0 ? 100_000 / energyYieldPerTrx : 0;

    let rentalMarketVolume = 0;
    let rentalProviderCount = 0;
    let rentalConsumerCount = 0;

    for (const activity of rentalData.platforms) {
      rentalMarketVolume += activity.outgoingVolume;
      rentalProviderCount += activity.uniquePayees;
      rentalConsumerCount += activity.delegation.delegatedToCount;
    }

    return Object.freeze({
      directFeeCostPer100k,
      selfStakeRequiredFor100k,
      rentalMarketVolume,
      rentalProviderCount,
      rentalConsumerCount,
      platformCount: rentalData.platforms.length,
    });
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

  private checkPlatformVolume(
    activity: PlatformActivity,
    findings: AuditFinding[],
  ): void {
    const { outgoingVolume, incomingVolume, platform } = activity;
    const totalVolume = outgoingVolume + incomingVolume;

    if (totalVolume > 1_000_000) {
      findings.push(
        this.finding(
          "MERCADO",
          "INFO",
          "energy-rental-high-volume",
          `${platform.name}: high transaction volume`,
          `${platform.name} (${platform.paymentAddress}) has processed ${totalVolume.toLocaleString()} TRX in recent transfers (${outgoingVolume.toLocaleString()} out, ${incomingVolume.toLocaleString()} in). Active energy rental market.`,
          {
            platform: platform.name,
            address: platform.paymentAddress,
            outgoingVolume,
            incomingVolume,
            totalVolume,
          },
        ),
      );
    }

    if (incomingVolume > 0 && outgoingVolume > 0) {
      const ratio = outgoingVolume / incomingVolume;
      if (ratio > 1.5) {
        findings.push(
          this.finding(
            "MERCADO",
            "MEDIUM",
            "energy-rental-outflow-imbalance",
            `${platform.name}: paying out more than receiving`,
            `${platform.name} outgoing volume (${outgoingVolume.toLocaleString()} TRX) is ${ratio.toFixed(1)}x incoming volume (${incomingVolume.toLocaleString()} TRX). Platform may be subsidizing energy costs or depleting reserves.`,
            {
              platform: platform.name,
              outgoingVolume,
              incomingVolume,
              ratio: Math.round(ratio * 100) / 100,
            },
            "Monitor platform solvency — sustained outflow imbalance is unsustainable.",
          ),
        );
      }
    }
  }

  private checkDelegationConcentration(
    activity: PlatformActivity,
    findings: AuditFinding[],
  ): void {
    const { delegation, platform } = activity;

    if (delegation.receivedFromCount > 50) {
      findings.push(
        this.finding(
          "INFRA",
          "HIGH",
          "energy-rental-provider-concentration",
          `${platform.name}: large energy provider pool`,
          `${platform.name} receives delegated resources from ${delegation.receivedFromCount} provider accounts. This represents significant concentration of delegated energy in a single platform.`,
          {
            platform: platform.name,
            address: platform.paymentAddress,
            providerCount: delegation.receivedFromCount,
            consumerCount: delegation.delegatedToCount,
          },
          "If this platform goes down, a large number of energy consumers lose their delegation. Monitor platform reliability.",
        ),
      );
    }

    if (delegation.delegatedToCount > 100) {
      findings.push(
        this.finding(
          "INFRA",
          "MEDIUM",
          "energy-rental-consumer-base",
          `${platform.name}: large consumer base`,
          `${platform.name} delegates resources to ${delegation.delegatedToCount} consumer accounts. The platform is a significant energy distribution hub.`,
          {
            platform: platform.name,
            consumerCount: delegation.delegatedToCount,
          },
        ),
      );
    }
  }

  private checkPaymentPatterns(
    activity: PlatformActivity,
    findings: AuditFinding[],
  ): void {
    const { outgoingTransfers, platform } = activity;
    if (outgoingTransfers.length < 5) return;

    const amounts = outgoingTransfers.map((t) => t.amount);
    const avg = amounts.reduce((sum, a) => sum + a, 0) / amounts.length;
    const maxPayment = Math.max(...amounts);

    if (maxPayment > avg * 10 && avg > 0) {
      findings.push(
        this.finding(
          "MERCADO",
          "LOW",
          "energy-rental-irregular-payment",
          `${platform.name}: irregular payment detected`,
          `${platform.name} has a payment of ${maxPayment.toLocaleString()} TRX while average is ${avg.toFixed(2)} TRX (${(maxPayment / avg).toFixed(0)}x). May indicate a large provider payout or unusual activity.`,
          {
            platform: platform.name,
            maxPayment,
            avgPayment: Math.round(avg * 100) / 100,
            ratio: Math.round((maxPayment / avg) * 100) / 100,
            transactionCount: outgoingTransfers.length,
          },
        ),
      );
    }
  }

  private checkMarketComparison(
    rentalData: EnergyRentalMarketData,
    networkMetrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    if (rentalData.platforms.length === 0) return;

    const comparison = this.computeMarketComparison(rentalData, networkMetrics);
    if (comparison.directFeeCostPer100k <= 0) return;

    const totalDelegations = rentalData.platforms.reduce(
      (sum, p) => sum + p.delegation.delegatedToCount,
      0,
    );

    if (
      comparison.selfStakeRequiredFor100k > 0 &&
      comparison.directFeeCostPer100k > 0
    ) {
      findings.push(
        this.finding(
          "MERCADO",
          "INFO",
          "energy-cost-comparison",
          "Energy acquisition cost comparison",
          `Direct fee for 100k energy: ${comparison.directFeeCostPer100k.toFixed(2)} TRX. Self-stake required: ${comparison.selfStakeRequiredFor100k.toFixed(0)} TRX (locked). Rental market has ${totalDelegations} active consumer delegations across ${comparison.platformCount} platform(s).`,
          {
            directFeeCostPer100k: comparison.directFeeCostPer100k,
            selfStakeRequiredFor100k: comparison.selfStakeRequiredFor100k,
            rentalMarketVolume: comparison.rentalMarketVolume,
            totalDelegations,
            platformCount: comparison.platformCount,
          },
          "Compare energy acquisition methods based on your usage pattern: frequent users benefit from staking or rental, occasional users from direct fees.",
        ),
      );
    }
  }

  private checkRentalMarketSize(
    rentalData: EnergyRentalMarketData,
    networkMetrics: TronNetworkMetrics,
    findings: AuditFinding[],
  ): void {
    if (rentalData.platforms.length === 0) return;

    const totalRentalEnergy = rentalData.platforms.reduce(
      (sum, p) => sum + p.resources.energyLimit,
      0,
    );
    const networkEnergy = networkMetrics.energy.totalEnergyLimit;

    if (totalRentalEnergy > 0 && networkEnergy > 0) {
      const rentalPct = (totalRentalEnergy / networkEnergy) * 100;

      if (rentalPct > 1) {
        findings.push(
          this.finding(
            "INFRA",
            rentalPct > 5 ? "HIGH" : "MEDIUM",
            "energy-rental-market-share",
            "Energy rental platforms control significant network energy",
            `Tracked rental platforms hold ${rentalPct.toFixed(2)}% of total network energy (${totalRentalEnergy.toLocaleString()} of ${networkEnergy.toLocaleString()}). Rental market is a significant factor in energy pricing.`,
            {
              totalRentalEnergy,
              networkEnergy,
              rentalPct: Math.round(rentalPct * 100) / 100,
              platformCount: rentalData.platforms.length,
            },
            "Energy rental platforms affect market dynamics. Their pricing and availability impact all dApp energy costs.",
          ),
        );
      }
    }
  }
}
