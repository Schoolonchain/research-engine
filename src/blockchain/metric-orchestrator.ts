import type { MetricStore } from "./metric-store.js";
import type { TronNetworkMetrics } from "./network-metrics-collector.js";
import type { ResourceRankingsData } from "./resource-rankings-collector.js";
import type { Trc20RankingsData } from "./trc20-rankings-collector.js";
import type { EnergyRentalMarketData } from "./energy-rental-collector.js";
import type { OnchainAnalyticsResult } from "./onchain-analytics.js";
import type { TronGovernanceData } from "./tron-governance-collector.js";
import type { AuditFinding } from "./audit-analyzer.js";
import type { EnergyMarketComparison } from "./energy-rental-analyzer.js";
import {
  networkMetricsToRecords,
  resourceRankingsToRecords,
  trc20RankingsToRecords,
  energyRentalToRecords,
  onchainAnalyticsToRecords,
  governanceToRecords,
  findingsToRecords,
} from "./metric-adapters.js";

export class MetricCollectionOrchestrator {
  constructor(
    private readonly store: MetricStore,
    private readonly blockchain: string = "tron",
  ) {}

  async ingestNetworkMetrics(data: TronNetworkMetrics): Promise<number> {
    const records = networkMetricsToRecords(data);
    await this.store.insertBatch(records);
    return records.length;
  }

  async ingestResourceRankings(data: ResourceRankingsData): Promise<number> {
    const records = resourceRankingsToRecords(data);
    await this.store.insertBatch(records);
    return records.length;
  }

  async ingestTrc20Rankings(data: Trc20RankingsData): Promise<number> {
    const records = trc20RankingsToRecords(data);
    await this.store.insertBatch(records);
    return records.length;
  }

  async ingestEnergyRental(
    data: EnergyRentalMarketData,
    comparison: EnergyMarketComparison | null = null,
  ): Promise<number> {
    const records = energyRentalToRecords(data, comparison);
    await this.store.insertBatch(records);
    return records.length;
  }

  async ingestAnalytics(
    data: OnchainAnalyticsResult,
    source: string,
    timestamp: Date,
  ): Promise<number> {
    const records = onchainAnalyticsToRecords(data, source, timestamp);
    await this.store.insertBatch(records);
    return records.length;
  }

  async ingestGovernance(data: TronGovernanceData): Promise<number> {
    const records = governanceToRecords(data);
    await this.store.insertBatch(records);
    return records.length;
  }

  async ingestFindings(
    findings: readonly AuditFinding[],
    timestamp: Date = new Date(),
  ): Promise<number> {
    const records = findingsToRecords(findings, this.blockchain, timestamp);
    await this.store.insertBatch(records);
    return records.length;
  }
}
