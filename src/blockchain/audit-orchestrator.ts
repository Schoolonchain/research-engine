import type { TronCollectorRegistry } from "./tron-collector-registry.js";
import type { AuditAnalyzer, AuditFinding, AuditSnapshot } from "./audit-analyzer.js";
import type { AccountTarget, TokenTarget, ContractTarget, TronAccountInfo, TronTokenInfo, TronContractInfo } from "./audit-model.js";
import type { TronStakingInfo, StakingTarget } from "./tron-staking-collector.js";
import type { TronGovernanceData, GovernanceTarget } from "./tron-governance-collector.js";
import type { Severity } from "./audit-analyzer.js";

export interface AuditReport {
  readonly auditType: "FULL" | "ACCOUNT" | "CONTRACT";
  readonly targetAddress: string | null;
  readonly overallRisk: Severity;
  readonly findingCounts: {
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly info: number;
  };
  readonly findings: readonly AuditFinding[];
  readonly sourcesUsed: readonly string[];
  readonly dataPointsCollected: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

function maxSeverity(findings: readonly AuditFinding[]): Severity {
  let max: Severity = "INFO";
  for (const f of findings) {
    if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[max]) {
      max = f.severity;
    }
  }
  return max;
}

function countFindings(findings: readonly AuditFinding[]): AuditReport["findingCounts"] {
  let critical = 0, high = 0, medium = 0, low = 0, info = 0;
  for (const f of findings) {
    switch (f.severity) {
      case "CRITICAL": critical++; break;
      case "HIGH": high++; break;
      case "MEDIUM": medium++; break;
      case "LOW": low++; break;
      case "INFO": info++; break;
    }
  }
  return Object.freeze({ critical, high, medium, low, info });
}

export class AuditOrchestrator {
  constructor(
    private readonly registry: TronCollectorRegistry,
    private readonly analyzers: readonly AuditAnalyzer[],
  ) {}

  async auditAccount(address: string): Promise<AuditReport> {
    const startedAt = new Date();
    const sources = new Set<string>();
    let dataPoints = 0;

    const accounts = new Map<string, TronAccountInfo>();
    const tokens = new Map<string, TronTokenInfo>();
    const contracts = new Map<string, TronContractInfo>();
    const stakingMap = new Map<string, TronStakingInfo>();

    const target: AccountTarget = { address };

    if (this.registry.canCollect("account")) {
      for (const collector of this.registry.all("account")) {
        try {
          const result = await (collector as { collect(t: AccountTarget): Promise<TronAccountInfo> }).collect(target);
          if (!accounts.has(result.source)) {
            accounts.set(result.address, result);
            sources.add(result.source);
            dataPoints++;
          }
        } catch {
          // Cross-validation source failed, continue with others
        }
      }
    }

    if (this.registry.canCollect("staking")) {
      try {
        const stakingCollector = this.registry.resolve<StakingTarget, TronStakingInfo>("staking");
        const stakingResult = await stakingCollector.collect({ address });
        stakingMap.set(address, stakingResult);
        sources.add(stakingResult.source);
        dataPoints++;
      } catch {
        // Staking data unavailable
      }
    }

    const accountData = accounts.get(address) ?? [...accounts.values()][0];
    if (accountData?.isContract && this.registry.canCollect("contract")) {
      try {
        const contractCollector = this.registry.resolve<ContractTarget, TronContractInfo>("contract");
        const contractResult = await contractCollector.collect({ address });
        contracts.set(address, contractResult);
        sources.add(contractResult.source);
        dataPoints++;
      } catch {
        // Contract data unavailable
      }
    }

    if (accountData?.trc20Balances && this.registry.canCollect("token")) {
      for (const token of accountData.trc20Balances.slice(0, 10)) {
        try {
          const tokenCollector = this.registry.resolve<TokenTarget, TronTokenInfo>("token");
          const tokenResult = await tokenCollector.collect({ contractAddress: token.contractAddress });
          tokens.set(token.contractAddress, tokenResult);
          sources.add(tokenResult.source);
          dataPoints++;
        } catch {
          // Token data unavailable
        }
      }
    }

    const snapshot: AuditSnapshot = {
      accounts,
      tokens,
      contracts,
      staking: stakingMap,
      governance: null,
      collectedAt: new Date(),
    };

    const findings = this.runAnalyzers(snapshot);

    return this.buildReport("ACCOUNT", address, findings, sources, dataPoints, startedAt);
  }

  async auditContract(address: string): Promise<AuditReport> {
    const startedAt = new Date();
    const sources = new Set<string>();
    let dataPoints = 0;

    const accounts = new Map<string, TronAccountInfo>();
    const tokens = new Map<string, TronTokenInfo>();
    const contracts = new Map<string, TronContractInfo>();

    if (this.registry.canCollect("contract")) {
      for (const collector of this.registry.all("contract")) {
        try {
          const result = await (collector as { collect(t: ContractTarget): Promise<TronContractInfo> }).collect({ address });
          contracts.set(address, result);
          sources.add(result.source);
          dataPoints++;
        } catch {
          // Source failed
        }
      }
    }

    if (this.registry.canCollect("account")) {
      try {
        const accountCollector = this.registry.resolve<AccountTarget, TronAccountInfo>("account");
        const accountResult = await accountCollector.collect({ address });
        accounts.set(address, accountResult);
        sources.add(accountResult.source);
        dataPoints++;
      } catch {
        // Account data unavailable
      }
    }

    if (this.registry.canCollect("token")) {
      try {
        const tokenCollector = this.registry.resolve<TokenTarget, TronTokenInfo>("token");
        const tokenResult = await tokenCollector.collect({ contractAddress: address });
        tokens.set(address, tokenResult);
        sources.add(tokenResult.source);
        dataPoints++;
      } catch {
        // Not a token contract
      }
    }

    const snapshot: AuditSnapshot = {
      accounts,
      tokens,
      contracts,
      staking: new Map(),
      governance: null,
      collectedAt: new Date(),
    };

    const findings = this.runAnalyzers(snapshot);

    return this.buildReport("CONTRACT", address, findings, sources, dataPoints, startedAt);
  }

  async auditFull(): Promise<AuditReport> {
    const startedAt = new Date();
    const sources = new Set<string>();
    let dataPoints = 0;

    let governance: TronGovernanceData | null = null;
    if (this.registry.canCollect("governance")) {
      try {
        const govCollector = this.registry.resolve<GovernanceTarget, TronGovernanceData>("governance");
        governance = await govCollector.collect({ scope: "full" });
        sources.add(governance.source);
        dataPoints++;
      } catch {
        // Governance data unavailable
      }
    }

    const snapshot: AuditSnapshot = {
      accounts: new Map(),
      tokens: new Map(),
      contracts: new Map(),
      staking: new Map(),
      governance,
      collectedAt: new Date(),
    };

    const findings = this.runAnalyzers(snapshot);

    return this.buildReport("FULL", null, findings, sources, dataPoints, startedAt);
  }

  private runAnalyzers(snapshot: AuditSnapshot): readonly AuditFinding[] {
    const allFindings: AuditFinding[] = [];

    for (const analyzer of this.analyzers) {
      const results = analyzer.analyze(snapshot);
      allFindings.push(...results);
    }

    allFindings.sort(
      (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity],
    );

    return Object.freeze(allFindings);
  }

  private buildReport(
    auditType: AuditReport["auditType"],
    targetAddress: string | null,
    findings: readonly AuditFinding[],
    sources: Set<string>,
    dataPoints: number,
    startedAt: Date,
  ): AuditReport {
    return Object.freeze({
      auditType,
      targetAddress,
      overallRisk: maxSeverity(findings),
      findingCounts: countFindings(findings),
      findings,
      sourcesUsed: Object.freeze([...sources]),
      dataPointsCollected: dataPoints,
      startedAt,
      completedAt: new Date(),
    });
  }
}
