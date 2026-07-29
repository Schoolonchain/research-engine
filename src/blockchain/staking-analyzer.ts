import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";

export class StakingAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "staking";
  readonly modules: readonly AuditModule[] = ["FUNDAMENTAL", "CARTERA"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const [address, staking] of snapshot.staking) {
      this.checkDelegationConcentration(address, staking, findings);
      this.checkResourceUtilization(address, staking, snapshot, findings);
      this.checkPendingRewards(address, staking, findings);
    }

    return Object.freeze(findings);
  }

  private checkDelegationConcentration(
    address: string,
    staking: Parameters<StakingAnalyzer["analyze"]>[0]["staking"] extends ReadonlyMap<string, infer V> ? V : never,
    findings: AuditFinding[],
  ): void {
    const totalFrozen = BigInt(staking.frozenBalanceV2Sun);
    const totalDelegated = BigInt(staking.delegatedBandwidthSun) + BigInt(staking.delegatedEnergySun);

    if (totalFrozen === 0n) return;

    const delegatedPct = Number((totalDelegated * 100n) / totalFrozen);

    if (delegatedPct > 80) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "CARTERA",
        severity: "MEDIUM",
        category: "high-delegation-ratio",
        title: "High resource delegation ratio",
        description: `Account ${address} has delegated ${delegatedPct}% of frozen resources. Limited resources available for own use.`,
        evidence: {
          address,
          frozenSun: staking.frozenBalanceV2Sun,
          delegatedSun: (totalDelegated).toString(),
          delegatedPct,
        },
        recommendation: "Review delegation strategy to ensure sufficient resources for own transactions.",
      });
    }
  }

  private checkResourceUtilization(
    address: string,
    staking: Parameters<StakingAnalyzer["analyze"]>[0]["staking"] extends ReadonlyMap<string, infer V> ? V : never,
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    const account = snapshot.accounts.get(address);
    if (!account) return;

    const hasEnergy = account.energyLimit > 0;
    const hasBandwidth = account.bandwidthLimit > 0;

    if (hasEnergy && account.energyUsed === 0 && BigInt(staking.frozenEnergySun) > 0n) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "LOW",
        category: "unused-energy-stake",
        title: "Frozen energy not being used",
        description: `Account ${address} has ${staking.frozenEnergySun} SUN frozen for energy but 0 energy consumed.`,
        evidence: {
          address,
          frozenEnergySun: staking.frozenEnergySun,
          energyLimit: account.energyLimit,
          energyUsed: account.energyUsed,
        },
        recommendation: "Consider unfreezing unused energy resources or delegating them.",
      });
    }

    if (hasBandwidth && account.bandwidthUsed === 0 && BigInt(staking.frozenBandwidthSun) > 0n) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "LOW",
        category: "unused-bandwidth-stake",
        title: "Frozen bandwidth not being used",
        description: `Account ${address} has ${staking.frozenBandwidthSun} SUN frozen for bandwidth but 0 bandwidth consumed.`,
        evidence: {
          address,
          frozenBandwidthSun: staking.frozenBandwidthSun,
          bandwidthLimit: account.bandwidthLimit,
          bandwidthUsed: account.bandwidthUsed,
        },
        recommendation: "Consider unfreezing unused bandwidth resources or delegating them.",
      });
    }
  }

  private checkPendingRewards(
    address: string,
    staking: Parameters<StakingAnalyzer["analyze"]>[0]["staking"] extends ReadonlyMap<string, infer V> ? V : never,
    findings: AuditFinding[],
  ): void {
    const rewards = BigInt(staking.rewardsPendingSun);
    const threshold = 10_000_000n; // 10 TRX

    if (rewards > threshold) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "CARTERA",
        severity: "INFO",
        category: "unclaimed-rewards",
        title: "Unclaimed staking rewards",
        description: `Account ${address} has ${staking.rewardsPendingSun} SUN (${Number(rewards / 1_000_000n)} TRX) in unclaimed voting rewards.`,
        evidence: {
          address,
          rewardsPendingSun: staking.rewardsPendingSun,
        },
        recommendation: "Consider claiming pending rewards to maximize returns.",
      });
    }
  }
}
