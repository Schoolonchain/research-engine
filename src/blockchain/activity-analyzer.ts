import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";

export class ActivityAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "activity";
  readonly modules: readonly AuditModule[] = ["ON_CHAIN", "FUNDAMENTAL"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    this.checkAccountActivity(snapshot, findings);
    this.checkContractUsage(snapshot, findings);
    this.checkNetworkParticipation(snapshot, findings);

    return Object.freeze(findings);
  }

  private checkAccountActivity(
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    for (const [address, account] of snapshot.accounts) {
      if (account.createTime === null || account.latestOperationTime === null) continue;

      const accountAgeDays = (Date.now() - account.createTime) / (1000 * 60 * 60 * 24);
      const inactiveDays = (Date.now() - account.latestOperationTime) / (1000 * 60 * 60 * 24);

      if (accountAgeDays > 30 && inactiveDays > 180) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "ON_CHAIN",
          severity: "LOW",
          category: "long-inactive-account",
          title: `Long-inactive account: ${address}`,
          description: `Account ${address} has been inactive for ${Math.floor(inactiveDays)} days (created ${Math.floor(accountAgeDays)} days ago).`,
          evidence: {
            address,
            accountAgeDays: Math.floor(accountAgeDays),
            inactiveDays: Math.floor(inactiveDays),
            createTime: account.createTime,
            latestOperationTime: account.latestOperationTime,
          },
          recommendation: null,
        });
      }

      if (accountAgeDays < 7 && BigInt(account.balanceSun) > 100_000_000_000n) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "ON_CHAIN",
          severity: "MEDIUM",
          category: "new-high-value-account",
          title: `New high-value account: ${address}`,
          description: `Account ${address} was created ${Math.floor(accountAgeDays)} days ago but already holds ${account.balanceTrx} TRX.`,
          evidence: {
            address,
            accountAgeDays: Math.floor(accountAgeDays),
            balanceTrx: account.balanceTrx,
          },
          recommendation: "New accounts with large balances may warrant additional investigation of funding sources.",
        });
      }
    }
  }

  private checkContractUsage(
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    for (const [address, contract] of snapshot.contracts) {
      if (contract.callCount === null || contract.callerCount === null) continue;

      if (contract.callCount > 0 && contract.callerCount === 1) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "ON_CHAIN",
          severity: "MEDIUM",
          category: "single-caller-contract",
          title: `Single-caller contract: ${contract.name ?? address}`,
          description: `Contract ${address} has ${contract.callCount} calls but only 1 unique caller. May indicate private or test usage.`,
          evidence: {
            address,
            name: contract.name,
            callCount: contract.callCount,
            callerCount: contract.callerCount,
          },
          recommendation: "Contracts with a single caller may not represent genuine decentralized usage.",
        });
      }

      if (contract.callerCount !== null && contract.callCount > 0) {
        const callsPerCaller = contract.callCount / contract.callerCount;
        if (callsPerCaller > 1000 && contract.callerCount < 10) {
          findings.push({
            analyzerName: this.analyzerName,
            module: "ON_CHAIN",
            severity: "LOW",
            category: "concentrated-contract-usage",
            title: `Concentrated usage: ${contract.name ?? address}`,
            description: `Contract ${address} averages ${Math.floor(callsPerCaller)} calls per caller with only ${contract.callerCount} callers.`,
            evidence: {
              address,
              callCount: contract.callCount,
              callerCount: contract.callerCount,
              callsPerCaller: Math.floor(callsPerCaller),
            },
            recommendation: null,
          });
        }
      }
    }
  }

  private checkNetworkParticipation(
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    if (!snapshot.governance) return;

    const { witnesses, electedCount } = snapshot.governance;
    if (witnesses.length === 0) return;

    const avgProductivity = witnesses
      .filter((w) => w.isElected)
      .reduce((sum, w) => sum + w.productivityPct, 0) / (electedCount || 1);

    if (avgProductivity < 95 && electedCount > 0) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "MEDIUM",
        category: "low-network-productivity",
        title: "Below-average network block production",
        description: `Average SR block production rate is ${avgProductivity.toFixed(1)}%, below the 95% healthy threshold.`,
        evidence: {
          avgProductivityPct: Math.round(avgProductivity * 100) / 100,
          electedCount,
        },
        recommendation: "Low overall productivity may indicate network instability or poorly maintained SR nodes.",
      });
    }
  }
}
