import type { TronAccountInfo, TronTokenInfo, TronContractInfo } from "./audit-model.js";
import type { TronStakingInfo } from "./tron-staking-collector.js";
import type { TronGovernanceData } from "./tron-governance-collector.js";

export const AUDIT_MODULES = [
  "FUNDAMENTAL", "ON_CHAIN", "CARTERA", "RIESGO",
  "OSINT", "GOBERNANZA", "DESARROLLO", "INFRA",
  "MERCADO", "AUTOMATIZACION",
] as const;

export type AuditModule = (typeof AUDIT_MODULES)[number];

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AuditFinding {
  readonly analyzerName: string;
  readonly module: AuditModule;
  readonly severity: Severity;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recommendation: string | null;
}

export interface AuditSnapshot {
  readonly accounts: ReadonlyMap<string, TronAccountInfo>;
  readonly tokens: ReadonlyMap<string, TronTokenInfo>;
  readonly contracts: ReadonlyMap<string, TronContractInfo>;
  readonly staking: ReadonlyMap<string, TronStakingInfo>;
  readonly governance: TronGovernanceData | null;
  readonly collectedAt: Date;
}

export interface AuditAnalyzer {
  readonly analyzerName: string;
  readonly modules: readonly AuditModule[];
  analyze(snapshot: AuditSnapshot): readonly AuditFinding[];
}
