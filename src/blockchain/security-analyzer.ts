import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";

export class SecurityAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "security";
  readonly modules: readonly AuditModule[] = ["RIESGO", "CARTERA"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const [address, account] of snapshot.accounts) {
      this.checkPermissions(address, account, findings);
      this.checkContractOwnership(address, account, snapshot, findings);
    }

    return Object.freeze(findings);
  }

  private checkPermissions(
    address: string,
    account: Parameters<SecurityAnalyzer["analyze"]>[0]["accounts"] extends ReadonlyMap<string, infer V> ? V : never,
    findings: AuditFinding[],
  ): void {
    const ownerPerm = account.permissions.find((p) => p.type === "owner");

    if (ownerPerm && ownerPerm.keys.length === 1 && ownerPerm.threshold === 1) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: "HIGH",
        category: "single-key-owner",
        title: "Single-key owner permission",
        description: `Account ${address} has a single key controlling owner permissions with threshold 1. No multi-sig protection.`,
        evidence: {
          address,
          ownerKeys: ownerPerm.keys.length,
          threshold: ownerPerm.threshold,
        },
        recommendation: "Consider adding multi-sig protection with at least 2-of-3 key setup for owner permissions.",
      });
    }

    if (ownerPerm && ownerPerm.keys.length >= 2) {
      const totalWeight = ownerPerm.keys.reduce((sum, k) => sum + k.weight, 0);
      if (ownerPerm.threshold <= 1 && totalWeight > 1) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "RIESGO",
          severity: "HIGH",
          category: "weak-multisig-threshold",
          title: "Multi-sig with threshold 1",
          description: `Account ${address} has ${ownerPerm.keys.length} owner keys but threshold is only 1. Any single key can act as owner.`,
          evidence: {
            address,
            ownerKeys: ownerPerm.keys.length,
            threshold: ownerPerm.threshold,
            totalWeight,
          },
          recommendation: "Increase the owner permission threshold to require at least 2 keys for approval.",
        });
      }
    }

    const activePerm = account.permissions.find((p) => p.type === "active");
    if (activePerm && activePerm.operations) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "CARTERA",
        severity: "INFO",
        category: "custom-active-permissions",
        title: "Custom active permissions configured",
        description: `Account ${address} has custom active permissions with operation restrictions.`,
        evidence: {
          address,
          activeKeys: activePerm.keys.length,
          threshold: activePerm.threshold,
          hasOperations: true,
        },
        recommendation: null,
      });
    }
  }

  private checkContractOwnership(
    address: string,
    account: Parameters<SecurityAnalyzer["analyze"]>[0]["accounts"] extends ReadonlyMap<string, infer V> ? V : never,
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    if (!account.isContract) return;

    const contract = snapshot.contracts.get(address);
    if (!contract) return;

    if (!contract.isVerified) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: "HIGH",
        category: "unverified-contract",
        title: "Unverified smart contract",
        description: `Contract ${address} source code is not verified. Cannot audit contract logic.`,
        evidence: {
          address,
          name: contract.name,
          isVerified: false,
        },
        recommendation: "Verify the contract source code on TronScan to enable code auditing.",
      });
    }
  }
}
