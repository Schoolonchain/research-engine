import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";
import type { TronAccountInfo, TronTokenInfo } from "./audit-model.js";

export class ConcentrationAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "concentration";
  readonly modules: readonly AuditModule[] = ["RIESGO", "OSINT"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    this.checkTrxConcentration(snapshot, findings);
    this.checkTokenConcentration(snapshot, findings);

    return Object.freeze(findings);
  }

  private checkTrxConcentration(
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    if (snapshot.accounts.size < 2) return;

    const balances: { address: string; balance: bigint }[] = [];
    for (const [address, account] of snapshot.accounts) {
      balances.push({ address, balance: BigInt(account.balanceSun) });
    }

    const totalBalance = balances.reduce((sum, b) => sum + b.balance, 0n);
    if (totalBalance === 0n) return;

    balances.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

    const topBalance = balances[0]!;
    const topPct = Number((topBalance.balance * 10000n) / totalBalance) / 100;

    if (topPct > 50) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: "CRITICAL",
        category: "single-holder-majority",
        title: "Single account holds majority of audited TRX",
        description: `Account ${topBalance.address} holds ${topPct.toFixed(1)}% of TRX across audited accounts.`,
        evidence: {
          address: topBalance.address,
          balanceSun: topBalance.balance.toString(),
          totalAuditedSun: totalBalance.toString(),
          percentage: topPct,
        },
        recommendation: "High concentration in a single account creates systemic risk. Investigate the account's purpose.",
      });
    }
  }

  private checkTokenConcentration(
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    const tokenHoldings = new Map<string, { holders: number; totalBalance: bigint; maxHolder: { address: string; balance: bigint } }>();

    for (const [address, account] of snapshot.accounts) {
      for (const tokenBalance of account.trc20Balances) {
        const contractAddr = tokenBalance.contractAddress;
        const balance = BigInt(tokenBalance.balance || "0");

        let entry = tokenHoldings.get(contractAddr);
        if (!entry) {
          entry = { holders: 0, totalBalance: 0n, maxHolder: { address, balance: 0n } };
          tokenHoldings.set(contractAddr, entry);
        }

        if (balance > 0n) {
          entry.holders++;
          entry.totalBalance += balance;
          if (balance > entry.maxHolder.balance) {
            entry.maxHolder = { address, balance };
          }
        }
      }
    }

    for (const [contractAddr, data] of tokenHoldings) {
      if (data.totalBalance === 0n || data.holders < 2) continue;

      const token = snapshot.tokens.get(contractAddr);
      const symbol = token?.symbol ?? contractAddr;

      const maxPct = Number((data.maxHolder.balance * 10000n) / data.totalBalance) / 100;

      if (maxPct > 80) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "RIESGO",
          severity: "HIGH",
          category: "token-concentration",
          title: `High ${symbol} concentration`,
          description: `Account ${data.maxHolder.address} holds ${maxPct.toFixed(1)}% of ${symbol} across audited accounts.`,
          evidence: {
            tokenContract: contractAddr,
            symbol,
            holderAddress: data.maxHolder.address,
            holderBalance: data.maxHolder.balance.toString(),
            totalAudited: data.totalBalance.toString(),
            percentage: maxPct,
            auditedHolders: data.holders,
          },
          recommendation: "Extreme token concentration enables price manipulation and rug-pull risk.",
        });
      }
    }
  }
}
