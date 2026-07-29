import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";

export class GovernanceAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "governance";
  readonly modules: readonly AuditModule[] = ["GOBERNANZA"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    if (!snapshot.governance) return Object.freeze(findings);

    const gov = snapshot.governance;

    this.checkVoteCentralization(gov, findings);
    this.checkSRProductivity(gov, findings);
    this.checkElectedCount(gov, findings);

    return Object.freeze(findings);
  }

  private checkVoteCentralization(
    gov: NonNullable<AuditSnapshot["governance"]>,
    findings: AuditFinding[],
  ): void {
    if (gov.totalVotes === 0) return;

    const sorted = [...gov.witnesses].sort((a, b) => b.voteCount - a.voteCount);
    const top3Votes = sorted.slice(0, 3).reduce((sum, w) => sum + w.voteCount, 0);
    const top3Pct = (top3Votes / gov.totalVotes) * 100;

    if (top3Pct > 33) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "GOBERNANZA",
        severity: "HIGH",
        category: "vote-centralization",
        title: "Top-3 SRs control majority of votes",
        description: `The top 3 Super Representatives hold ${top3Pct.toFixed(1)}% of total votes, exceeding the 33% threshold for consensus influence.`,
        evidence: {
          top3Addresses: sorted.slice(0, 3).map((w) => w.address),
          top3Votes,
          totalVotes: gov.totalVotes,
          top3Percentage: Math.round(top3Pct * 100) / 100,
        },
        recommendation: "Consider diversifying votes across more Super Representatives to reduce centralization risk.",
      });
    }
  }

  private checkSRProductivity(
    gov: NonNullable<AuditSnapshot["governance"]>,
    findings: AuditFinding[],
  ): void {
    for (const witness of gov.witnesses) {
      if (!witness.isElected) continue;

      if (witness.productivityPct < 90 && (witness.totalProduced + witness.totalMissed) > 100) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "GOBERNANZA",
          severity: "MEDIUM",
          category: "low-sr-productivity",
          title: `Low SR productivity: ${witness.address}`,
          description: `Super Representative ${witness.address} has ${witness.productivityPct.toFixed(1)}% block production rate, below the 90% threshold.`,
          evidence: {
            address: witness.address,
            productivityPct: witness.productivityPct,
            totalProduced: witness.totalProduced,
            totalMissed: witness.totalMissed,
          },
          recommendation: "Monitor this SR's node health and consider redirecting votes if productivity does not improve.",
        });
      }
    }
  }

  private checkElectedCount(
    gov: NonNullable<AuditSnapshot["governance"]>,
    findings: AuditFinding[],
  ): void {
    if (gov.electedCount > 0 && gov.electedCount < 27) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "GOBERNANZA",
        severity: "MEDIUM",
        category: "low-elected-count",
        title: "Fewer than 27 active Super Representatives",
        description: `Only ${gov.electedCount} Super Representatives are elected, below the standard 27.`,
        evidence: {
          electedCount: gov.electedCount,
          totalWitnesses: gov.witnesses.length,
        },
        recommendation: null,
      });
    }
  }
}
