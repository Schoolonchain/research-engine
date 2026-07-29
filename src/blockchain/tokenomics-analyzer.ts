import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";
import type { TronTokenInfo } from "./audit-model.js";

export class TokenomicsAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "tokenomics";
  readonly modules: readonly AuditModule[] = ["FUNDAMENTAL", "MERCADO"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const [address, token] of snapshot.tokens) {
      this.checkTotalSupply(address, token, findings);
      this.checkHolderCount(address, token, findings);
      this.checkMarketData(address, token, findings);
      this.checkTransferActivity(address, token, findings);
    }

    return Object.freeze(findings);
  }

  private checkTotalSupply(
    _address: string,
    token: TronTokenInfo,
    findings: AuditFinding[],
  ): void {
    const supply = BigInt(token.totalSupply || "0");

    if (supply === 0n) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "HIGH",
        category: "zero-supply",
        title: `Zero total supply: ${token.symbol || token.name}`,
        description: `Token ${token.symbol} (${token.contractAddress}) reports zero total supply, which may indicate a non-standard or abandoned token.`,
        evidence: {
          contractAddress: token.contractAddress,
          symbol: token.symbol,
          totalSupply: token.totalSupply,
        },
        recommendation: "Verify the token contract is functional and the supply data is accurate.",
      });
    }
  }

  private checkHolderCount(
    _address: string,
    token: TronTokenInfo,
    findings: AuditFinding[],
  ): void {
    if (token.holderCount > 0 && token.holderCount < 10) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "HIGH",
        category: "very-few-holders",
        title: `Very few holders: ${token.symbol}`,
        description: `Token ${token.symbol} has only ${token.holderCount} holders. Extremely low distribution increases manipulation risk.`,
        evidence: {
          contractAddress: token.contractAddress,
          symbol: token.symbol,
          holderCount: token.holderCount,
        },
        recommendation: "Investigate whether the token has genuine adoption or is being held by a small group.",
      });
    } else if (token.holderCount >= 10 && token.holderCount < 100) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "MEDIUM",
        category: "low-holder-count",
        title: `Low holder count: ${token.symbol}`,
        description: `Token ${token.symbol} has ${token.holderCount} holders, indicating limited distribution.`,
        evidence: {
          contractAddress: token.contractAddress,
          symbol: token.symbol,
          holderCount: token.holderCount,
        },
        recommendation: "Consider that low holder count may indicate early-stage or niche token with limited liquidity.",
      });
    }
  }

  private checkMarketData(
    _address: string,
    token: TronTokenInfo,
    findings: AuditFinding[],
  ): void {
    if (token.priceUsd !== null && token.volume24hUsd !== null && token.marketCapUsd !== null) {
      if (token.marketCapUsd > 0 && token.volume24hUsd / token.marketCapUsd < 0.001) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "MERCADO",
          severity: "MEDIUM",
          category: "extremely-low-volume",
          title: `Extremely low trading volume: ${token.symbol}`,
          description: `Token ${token.symbol} has a volume/market-cap ratio below 0.1%, indicating very low liquidity.`,
          evidence: {
            contractAddress: token.contractAddress,
            symbol: token.symbol,
            volume24hUsd: token.volume24hUsd,
            marketCapUsd: token.marketCapUsd,
            volumeToMcapRatio: token.volume24hUsd / token.marketCapUsd,
          },
          recommendation: "Low liquidity tokens carry high slippage risk. Exercise caution with large positions.",
        });
      }
    }
  }

  private checkTransferActivity(
    _address: string,
    token: TronTokenInfo,
    findings: AuditFinding[],
  ): void {
    if (token.holderCount > 100 && token.transferCount === 0) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "FUNDAMENTAL",
        severity: "MEDIUM",
        category: "no-recent-transfers",
        title: `No transfer activity: ${token.symbol}`,
        description: `Token ${token.symbol} has ${token.holderCount} holders but reports 0 transfers, which may indicate stale or abandoned token data.`,
        evidence: {
          contractAddress: token.contractAddress,
          symbol: token.symbol,
          holderCount: token.holderCount,
          transferCount: token.transferCount,
        },
        recommendation: "Verify whether the token is still actively used or has been abandoned.",
      });
    }
  }
}
