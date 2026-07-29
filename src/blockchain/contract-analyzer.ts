import type { AuditAnalyzer, AuditFinding, AuditModule, AuditSnapshot } from "./audit-analyzer.js";
import type { TronContractInfo } from "./audit-model.js";

const PROXY_SIGNATURES = [
  "upgradeTo",
  "upgradeToAndCall",
  "implementation",
  "setImplementation",
  "changeAdmin",
];

const DANGEROUS_FUNCTIONS = [
  "selfdestruct",
  "delegatecall",
  "suicide",
];

const STANDARD_ERC20_FUNCTIONS = [
  "transfer",
  "approve",
  "transferFrom",
  "balanceOf",
  "totalSupply",
  "allowance",
];

export class ContractAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "contract";
  readonly modules: readonly AuditModule[] = ["DESARROLLO", "RIESGO"];

  analyze(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const [address, contract] of snapshot.contracts) {
      this.checkVerification(address, contract, findings);
      this.checkProxyPattern(address, contract, findings);
      this.checkAbiCompleteness(address, contract, snapshot, findings);
      this.checkDangerousFunctions(address, contract, findings);
      this.checkUsageMetrics(address, contract, findings);
    }

    return Object.freeze(findings);
  }

  private checkVerification(
    address: string,
    contract: TronContractInfo,
    findings: AuditFinding[],
  ): void {
    if (!contract.isVerified) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "DESARROLLO",
        severity: "HIGH",
        category: "unverified-source",
        title: `Unverified contract: ${contract.name ?? address}`,
        description: `Contract ${address} has not been verified. Source code cannot be audited for vulnerabilities.`,
        evidence: {
          address,
          name: contract.name,
          isVerified: false,
        },
        recommendation: "Request the contract deployer to verify the source code on TronScan.",
      });
    }
  }

  private checkProxyPattern(
    address: string,
    contract: TronContractInfo,
    findings: AuditFinding[],
  ): void {
    if (!contract.abi) return;

    const functionNames = contract.abi
      .filter((entry) => entry["type"] === "Function" || entry["type"] === "function")
      .map((entry) => entry["name"] as string)
      .filter(Boolean);

    const proxyFunctions = functionNames.filter((name) =>
      PROXY_SIGNATURES.some((sig) => name.toLowerCase().includes(sig.toLowerCase())),
    );

    if (proxyFunctions.length > 0) {
      const hasTimelock = functionNames.some((name) =>
        name.toLowerCase().includes("timelock") || name.toLowerCase().includes("delay"),
      );

      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: hasTimelock ? "MEDIUM" : "CRITICAL",
        category: "proxy-pattern",
        title: `Proxy contract${hasTimelock ? " with timelock" : " without timelock"}: ${contract.name ?? address}`,
        description: `Contract ${address} implements a proxy pattern (${proxyFunctions.join(", ")}).${hasTimelock ? " A timelock mechanism was detected." : " No timelock mechanism detected — upgrades can be executed immediately."}`,
        evidence: {
          address,
          proxyFunctions,
          hasTimelock,
        },
        recommendation: hasTimelock
          ? "Review the timelock duration to ensure it provides adequate time for community review."
          : "Implement a timelock mechanism to prevent immediate contract upgrades without community notice.",
      });
    }
  }

  private checkAbiCompleteness(
    address: string,
    contract: TronContractInfo,
    snapshot: AuditSnapshot,
    findings: AuditFinding[],
  ): void {
    if (!contract.abi) return;

    const isToken = snapshot.tokens.has(address);
    if (!isToken) return;

    const functionNames = contract.abi
      .filter((entry) => entry["type"] === "Function" || entry["type"] === "function")
      .map((entry) => (entry["name"] as string)?.toLowerCase())
      .filter(Boolean);

    const missing = STANDARD_ERC20_FUNCTIONS.filter(
      (fn) => !functionNames.includes(fn.toLowerCase()),
    );

    if (missing.length > 0) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "DESARROLLO",
        severity: "MEDIUM",
        category: "incomplete-token-abi",
        title: `Missing standard functions: ${contract.name ?? address}`,
        description: `Token contract ${address} is missing standard ERC20/TRC20 functions: ${missing.join(", ")}.`,
        evidence: {
          address,
          missingFunctions: missing,
          existingFunctions: functionNames,
        },
        recommendation: "Non-standard token interfaces may cause compatibility issues with wallets and DEXs.",
      });
    }
  }

  private checkDangerousFunctions(
    address: string,
    contract: TronContractInfo,
    findings: AuditFinding[],
  ): void {
    if (!contract.abi) return;

    const functionNames = contract.abi
      .filter((entry) => entry["type"] === "Function" || entry["type"] === "function")
      .map((entry) => (entry["name"] as string)?.toLowerCase())
      .filter(Boolean);

    const dangerous = functionNames.filter((name) =>
      DANGEROUS_FUNCTIONS.some((sig) => name.includes(sig)),
    );

    if (dangerous.length > 0) {
      findings.push({
        analyzerName: this.analyzerName,
        module: "RIESGO",
        severity: "HIGH",
        category: "dangerous-functions",
        title: `Dangerous functions detected: ${contract.name ?? address}`,
        description: `Contract ${address} contains potentially dangerous functions: ${dangerous.join(", ")}.`,
        evidence: {
          address,
          dangerousFunctions: dangerous,
        },
        recommendation: "Review the usage context of these functions. selfdestruct and delegatecall require careful access control.",
      });
    }
  }

  private checkUsageMetrics(
    address: string,
    contract: TronContractInfo,
    findings: AuditFinding[],
  ): void {
    if (contract.callCount !== null && contract.callCount === 0 && contract.createdAt !== null) {
      const ageMs = Date.now() - contract.createdAt;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays > 30) {
        findings.push({
          analyzerName: this.analyzerName,
          module: "DESARROLLO",
          severity: "MEDIUM",
          category: "unused-contract",
          title: `Unused contract: ${contract.name ?? address}`,
          description: `Contract ${address} was deployed ${Math.floor(ageDays)} days ago but has zero recorded calls.`,
          evidence: {
            address,
            callCount: 0,
            ageDays: Math.floor(ageDays),
            createdAt: contract.createdAt,
          },
          recommendation: "An unused contract may be abandoned or a placeholder. Verify its purpose.",
        });
      }
    }
  }
}
