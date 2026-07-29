import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";
import type { TronAccountInfo } from "./audit-model.js";

export class WalletRiskAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "wallet-risk";
  readonly modules: readonly AuditModule[] = ["CARTERA", "RIESGO"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const [address, account] of snapshot.accounts) {
      this.checkResourceExhaustion(address, account, findings);
      this.checkHighDelegation(address, account, findings);
      this.checkDormantHighValue(address, account, findings);
      this.checkTrc20Exposure(address, account, snapshot, findings);
    }

    return Object.freeze(findings);
  }

  private checkResourceExhaustion(
    address: string,
    account: TronAccountInfo,
    findings: AuditFinding[],
  ): void {
    if (account.energyLimit > 0) {
      const energyPct = (account.energyUsed / account.energyLimit) * 100;
      if (energyPct > 95) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "CARTERA",
          severity: "MEDIUM",
          category: "energy-exhaustion",
          title: `Energy nearly exhausted: ${address}`,
          description: `Account ${address} has used ${energyPct.toFixed(1)}% of available energy (${account.energyUsed}/${account.energyLimit}).`,
          evidence: {
            address,
            energyUsed: account.energyUsed,
            energyLimit: account.energyLimit,
            usagePct: Math.round(energyPct * 100) / 100,
          },
          recommendation: "Freeze additional TRX for energy or wait for resource recovery to avoid paying fees in TRX.",
        });
      }
    }

    if (account.bandwidthLimit > 0) {
      const bwPct = (account.bandwidthUsed / account.bandwidthLimit) * 100;
      if (bwPct > 95) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "CARTERA",
          severity: "LOW",
          category: "bandwidth-exhaustion",
          title: `Bandwidth nearly exhausted: ${address}`,
          description: `Account ${address} has used ${bwPct.toFixed(1)}% of available bandwidth.`,
          evidence: {
            address,
            bandwidthUsed: account.bandwidthUsed,
            bandwidthLimit: account.bandwidthLimit,
            usagePct: Math.round(bwPct * 100) / 100,
          },
          recommendation: "Freeze TRX for bandwidth or reduce transaction frequency.",
        });
      }
    }
  }

  private checkHighDelegation(
    address: string,
    account: TronAccountInfo,
    findings: AuditFinding[],
  ): void {
    const frozen = BigInt(account.frozenBalanceSun);
    const delegated = BigInt(account.delegatedFrozenBalanceSun);

    if (frozen === 0n || delegated === 0n) return;

    const totalStaked = frozen + delegated;
    const delegatedPct = Number((delegated * 100n) / totalStaked);

    if (delegatedPct > 80) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "CARTERA",
        severity: "MEDIUM",
        category: "over-delegation",
        title: `Over-delegated resources: ${address}`,
        description: `Account ${address} has delegated ${delegatedPct}% of its staked resources, leaving limited resources for own use.`,
        evidence: {
          address,
          frozenSun: account.frozenBalanceSun,
          delegatedSun: account.delegatedFrozenBalanceSun,
          delegatedPct,
        },
        recommendation: "Ensure sufficient undelegated resources remain for own transaction needs.",
      });
    }
  }

  private checkDormantHighValue(
    address: string,
    account: TronAccountInfo,
    findings: AuditFinding[],
  ): void {
    const balance = BigInt(account.balanceSun);
    const highValueThreshold = 1_000_000_000_000n; // 1M TRX

    if (balance < highValueThreshold) return;
    if (account.latestOperationTime === null) return;

    const ageMs = Date.now() - account.latestOperationTime;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > 90) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: "MEDIUM",
        category: "dormant-high-value",
        title: `Dormant high-value account: ${address}`,
        description: `Account ${address} holds over 1M TRX but has been inactive for ${Math.floor(ageDays)} days.`,
        evidence: {
          address,
          balanceTrx: account.balanceTrx,
          lastActivityDaysAgo: Math.floor(ageDays),
          latestOperationTime: account.latestOperationTime,
        },
        recommendation: "High-value dormant accounts may indicate lost keys or intentional cold storage. Verify account status.",
      });
    }
  }

  private checkTrc20Exposure(
    address: string,
    account: TronAccountInfo,
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    const unknownTokens: string[] = [];

    for (const holding of account.trc20Balances) {
      const balance = BigInt(holding.balance || "0");
      if (balance === 0n) continue;

      const tokenInfo = snapshot.tokens.get(holding.contractAddress);
      if (!tokenInfo) {
        unknownTokens.push(holding.contractAddress);
      }
    }

    if (unknownTokens.length > 5) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: "LOW",
        category: "many-unknown-tokens",
        title: `Many unidentified tokens held: ${address}`,
        description: `Account ${address} holds ${unknownTokens.length} tokens that could not be identified. Some may be spam or malicious airdrop tokens.`,
        evidence: {
          address,
          unknownTokenCount: unknownTokens.length,
          sampleAddresses: unknownTokens.slice(0, 5),
        },
        recommendation: "Review unknown token holdings. Do not interact with unrecognized tokens as they may be phishing vectors.",
      });
    }
  }
}
