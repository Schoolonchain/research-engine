import type { MetricCategory, MetricConfidence, MetricRecord } from "./metric-types.js";
import { createMetricBatch } from "./metric-types.js";
import type { TronNetworkMetrics } from "./network-metrics-collector.js";
import type { ResourceRankingsData } from "./resource-rankings-collector.js";
import type { Trc20RankingsData } from "./trc20-rankings-collector.js";
import type { EnergyRentalMarketData } from "./energy-rental-collector.js";
import type { OnchainAnalyticsResult } from "./onchain-analytics.js";
import type { TronGovernanceData } from "./tron-governance-collector.js";
import type { AuditFinding } from "./audit-analyzer.js";
import type { EnergyMarketComparison } from "./energy-rental-analyzer.js";

const BLOCKCHAIN = "tron";

interface EntryInput {
  readonly category: MetricCategory;
  readonly metricName: string;
  readonly value: number | string;
  readonly unit: string;
  readonly confidence: MetricConfidence;
  readonly address?: string | null;
  readonly rawData?: Readonly<Record<string, unknown>> | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export function networkMetricsToRecords(
  data: TronNetworkMetrics,
): readonly MetricRecord[] {
  const shared = {
    blockchain: BLOCKCHAIN,
    source: data.source,
    timestamp: data.collectedAt,
    blockHeight: null,
  };

  const entries: EntryInput[] = [
    { category: "NETWORK", metricName: "energy_fee_sun", value: data.energy.energyFee, unit: "SUN", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "total_energy_limit", value: data.energy.totalEnergyLimit, unit: "energy", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "total_energy_weight", value: data.energy.totalEnergyWeight, unit: "SUN", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "dynamic_increase_factor", value: data.energy.dynamicIncreaseFactor, unit: "factor", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "dynamic_max_factor", value: data.energy.dynamicMaxFactor, unit: "factor", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "energy_yield_per_trx", value: data.energy.energyYieldPerTrx, unit: "energy/TRX", confidence: "DERIVED" },
    { category: "NETWORK", metricName: "transaction_fee", value: data.bandwidth.transactionFee, unit: "SUN", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "total_net_limit", value: data.bandwidth.totalNetLimit, unit: "bandwidth", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "total_net_weight", value: data.bandwidth.totalNetWeight, unit: "SUN", confidence: "DIRECT" },
    { category: "NETWORK", metricName: "bandwidth_yield_per_trx", value: data.bandwidth.bandwidthYieldPerTrx, unit: "bw/TRX", confidence: "DERIVED" },
    { category: "NETWORK", metricName: "staking_ratio", value: data.stakingRatio, unit: "ratio", confidence: "DERIVED" },

    { category: "MONETARY", metricName: "create_account_fee", value: data.economics.createAccountFee, unit: "SUN", confidence: "DIRECT" },
    { category: "MONETARY", metricName: "burn_trx_amount", value: data.economics.burnTrxAmount, unit: "SUN", confidence: "DIRECT" },
    { category: "MONETARY", metricName: "witness_pay_per_block", value: data.economics.witnessPayPerBlock, unit: "SUN", confidence: "DIRECT" },
    { category: "MONETARY", metricName: "witness127_pay_per_block", value: data.economics.witness127PayPerBlock, unit: "SUN", confidence: "DIRECT" },
    { category: "MONETARY", metricName: "maintenance_interval_ms", value: data.economics.maintenanceIntervalMs, unit: "ms", confidence: "DIRECT" },
  ];

  for (const holder of data.topHolders) {
    entries.push({
      category: "WHALE",
      metricName: "whale_balance",
      value: holder.balance,
      unit: "TRX",
      confidence: "DIRECT",
      address: holder.address,
      metadata: { frozen: holder.totalFrozen, power: holder.power },
    });
  }

  return createMetricBatch(shared, entries);
}

export function resourceRankingsToRecords(
  data: ResourceRankingsData,
): readonly MetricRecord[] {
  const shared = {
    blockchain: BLOCKCHAIN,
    source: data.source,
    timestamp: data.collectedAt,
    blockHeight: null,
  };

  const entries: EntryInput[] = [];

  for (const staker of data.topStakers) {
    entries.push(
      { category: "RESOURCE", metricName: "account_energy_limit", value: staker.energyLimit, unit: "energy", confidence: "DIRECT", address: staker.address },
      { category: "RESOURCE", metricName: "account_energy_used", value: staker.energyUsed, unit: "energy", confidence: "DIRECT", address: staker.address },
      { category: "RESOURCE", metricName: "account_bandwidth_limit", value: staker.bandwidthLimit, unit: "bandwidth", confidence: "DIRECT", address: staker.address },
      { category: "RESOURCE", metricName: "account_bandwidth_used", value: staker.bandwidthUsed, unit: "bandwidth", confidence: "DIRECT", address: staker.address },
      { category: "RESOURCE", metricName: "account_frozen_energy", value: staker.frozenForEnergy, unit: "SUN", confidence: "DIRECT", address: staker.address },
      { category: "RESOURCE", metricName: "account_frozen_bandwidth", value: staker.frozenForBandwidth, unit: "SUN", confidence: "DIRECT", address: staker.address },
      { category: "RESOURCE", metricName: "account_voting_power", value: staker.votingPower, unit: "votes", confidence: "DIRECT", address: staker.address },
    );
  }

  for (const d of data.delegationSummaries) {
    entries.push(
      { category: "RESOURCE", metricName: "delegation_to_count", value: d.delegatedToCount, unit: "count", confidence: "DIRECT", address: d.address },
      { category: "RESOURCE", metricName: "delegation_from_count", value: d.receivedFromCount, unit: "count", confidence: "DIRECT", address: d.address },
    );
  }

  return createMetricBatch(shared, entries);
}

export function trc20RankingsToRecords(
  data: Trc20RankingsData,
): readonly MetricRecord[] {
  const shared = {
    blockchain: BLOCKCHAIN,
    source: data.source,
    timestamp: data.collectedAt,
    blockHeight: null,
  };

  const entries: EntryInput[] = [];

  for (const token of data.topTokens) {
    const addr = token.contractAddress;
    entries.push(
      { category: "TOKEN", metricName: "token_holder_count", value: token.holderCount, unit: "count", confidence: "DIRECT", address: addr, metadata: { symbol: token.symbol, name: token.name } },
      { category: "TOKEN", metricName: "token_transfer_count", value: token.transferCount, unit: "count", confidence: "DIRECT", address: addr },
      { category: "TOKEN", metricName: "token_market_cap", value: token.marketCap, unit: "USD", confidence: "DIRECT", address: addr },
      { category: "TOKEN", metricName: "token_price_usd", value: token.priceUsd, unit: "USD", confidence: "DIRECT", address: addr },
      { category: "TOKEN", metricName: "token_total_supply", value: token.totalSupply, unit: "tokens", confidence: "DIRECT", address: addr },
    );
  }

  for (const analysis of data.tokenAnalyses) {
    for (const holder of analysis.topHolders) {
      entries.push({
        category: "HOLDER",
        metricName: "top_holder_balance",
        value: holder.balanceNum,
        unit: "tokens",
        confidence: "DIRECT",
        address: holder.address,
        metadata: {
          tokenAddress: analysis.token.contractAddress,
          tokenSymbol: analysis.token.symbol,
        },
      });
    }
  }

  return createMetricBatch(shared, entries);
}

export function energyRentalToRecords(
  data: EnergyRentalMarketData,
  comparison: EnergyMarketComparison | null,
): readonly MetricRecord[] {
  const shared = {
    blockchain: BLOCKCHAIN,
    source: data.source,
    timestamp: data.collectedAt,
    blockHeight: null,
  };

  const entries: EntryInput[] = [];

  for (const activity of data.platforms) {
    const addr = activity.platform.paymentAddress;
    entries.push(
      { category: "RESOURCE", metricName: "rental_platform_volume", value: activity.outgoingVolume + activity.incomingVolume, unit: "TRX", confidence: "DIRECT", address: addr, metadata: { platform: activity.platform.name } },
      { category: "RESOURCE", metricName: "rental_platform_energy_limit", value: activity.resources.energyLimit, unit: "energy", confidence: "DIRECT", address: addr },
    );

    if (activity.incomingVolume > 0) {
      entries.push({
        category: "RESOURCE",
        metricName: "rental_outflow_ratio",
        value: Math.round((activity.outgoingVolume / activity.incomingVolume) * 100) / 100,
        unit: "ratio",
        confidence: "DERIVED",
        address: addr,
      });
    }
  }

  if (comparison) {
    entries.push(
      { category: "RESOURCE", metricName: "direct_fee_cost_per_100k", value: comparison.directFeeCostPer100k, unit: "TRX", confidence: "DERIVED" },
      { category: "RESOURCE", metricName: "self_stake_required_for_100k", value: comparison.selfStakeRequiredFor100k, unit: "TRX", confidence: "DERIVED" },
      { category: "RESOURCE", metricName: "rental_market_share_pct", value: comparison.rentalMarketVolume, unit: "TRX", confidence: "DERIVED", metadata: { providers: comparison.rentalProviderCount, consumers: comparison.rentalConsumerCount } },
    );
  }

  return createMetricBatch(shared, entries);
}

export function onchainAnalyticsToRecords(
  data: OnchainAnalyticsResult,
  source: string,
  timestamp: Date,
): readonly MetricRecord[] {
  const shared = {
    blockchain: BLOCKCHAIN,
    source,
    timestamp,
    blockHeight: null,
  };

  const entries: EntryInput[] = [
    { category: "MONETARY", metricName: "daily_sr_emission_trx", value: data.deflation.dailySrEmissionTrx, unit: "TRX", confidence: "DERIVED" },
    { category: "MONETARY", metricName: "daily_partner_emission_trx", value: data.deflation.dailyPartnerEmissionTrx, unit: "TRX", confidence: "DERIVED" },
    { category: "MONETARY", metricName: "total_daily_emission_trx", value: data.deflation.totalDailyEmissionTrx, unit: "TRX", confidence: "DERIVED" },
    { category: "MONETARY", metricName: "annual_emission_trx", value: data.deflation.annualEmissionTrx, unit: "TRX", confidence: "DERIVED" },
    { category: "MONETARY", metricName: "estimated_daily_burn_trx", value: data.deflation.estimatedDailyBurnTrx, unit: "TRX", confidence: "ESTIMATED" },
    { category: "MONETARY", metricName: "net_daily_issuance_trx", value: data.deflation.netDailyIssuanceTrx, unit: "TRX", confidence: "DERIVED" },
    { category: "MONETARY", metricName: "is_deflationary", value: data.deflation.isDeflationary ? 1 : 0, unit: "boolean", confidence: "DERIVED" },

    { category: "NETWORK", metricName: "network_health_score", value: data.healthScore.overall, unit: "score", confidence: "DERIVED" },
    { category: "NETWORK", metricName: "network_health_grade", value: data.healthScore.grade, unit: "grade", confidence: "DERIVED" },

    { category: "ECOSYSTEM", metricName: "health_staking", value: data.healthScore.components.stakingHealth, unit: "score", confidence: "DERIVED" },
    { category: "ECOSYSTEM", metricName: "health_decentralization", value: data.healthScore.components.decentralization, unit: "score", confidence: "DERIVED" },
    { category: "ECOSYSTEM", metricName: "health_energy_market", value: data.healthScore.components.energyMarket, unit: "score", confidence: "DERIVED" },
    { category: "ECOSYSTEM", metricName: "health_token_diversity", value: data.healthScore.components.tokenDiversity, unit: "score", confidence: "DERIVED" },
    { category: "ECOSYSTEM", metricName: "health_emission_sustainability", value: data.healthScore.components.emissionSustainability, unit: "score", confidence: "DERIVED" },
  ];

  for (const v of data.tokenVelocities) {
    entries.push(
      { category: "TOKEN", metricName: "token_velocity", value: v.velocity, unit: "transfers/holder", confidence: "DERIVED", address: v.contractAddress, metadata: { symbol: v.symbol } },
      { category: "TOKEN", metricName: "token_velocity_class", value: v.classification, unit: "class", confidence: "DERIVED", address: v.contractAddress },
    );
  }

  for (const g of data.giniCoefficients) {
    entries.push(
      { category: "HOLDER", metricName: "gini_coefficient", value: g.giniCoefficient, unit: "coefficient", confidence: "DERIVED", address: g.contractAddress, metadata: { symbol: g.symbol } },
      { category: "HOLDER", metricName: "gini_classification", value: g.classification, unit: "class", confidence: "DERIVED", address: g.contractAddress },
    );
  }

  return createMetricBatch(shared, entries);
}

export function governanceToRecords(
  data: TronGovernanceData,
): readonly MetricRecord[] {
  const shared = {
    blockchain: BLOCKCHAIN,
    source: data.source,
    timestamp: data.collectedAt,
    blockHeight: null,
  };

  const entries: EntryInput[] = [
    { category: "GOVERNANCE", metricName: "total_votes", value: data.totalVotes, unit: "votes", confidence: "DIRECT" },
    { category: "GOVERNANCE", metricName: "elected_sr_count", value: data.electedCount, unit: "count", confidence: "DIRECT" },
    { category: "GOVERNANCE", metricName: "proposal_count", value: data.proposals.length, unit: "count", confidence: "DIRECT" },
    { category: "GOVERNANCE", metricName: "active_proposal_count", value: data.proposals.filter((p) => p.state === "PENDING" || p.state === "APPROVED").length, unit: "count", confidence: "DERIVED" },
  ];

  for (const w of data.witnesses) {
    entries.push(
      { category: "VALIDATOR", metricName: "witness_vote_count", value: w.voteCount, unit: "votes", confidence: "DIRECT", address: w.address, metadata: { url: w.url } },
      { category: "VALIDATOR", metricName: "witness_total_produced", value: w.totalProduced, unit: "blocks", confidence: "DIRECT", address: w.address },
      { category: "VALIDATOR", metricName: "witness_total_missed", value: w.totalMissed, unit: "blocks", confidence: "DIRECT", address: w.address },
      { category: "VALIDATOR", metricName: "witness_productivity", value: w.productivityPct, unit: "%", confidence: "DERIVED", address: w.address },
      { category: "VALIDATOR", metricName: "sr_is_elected", value: w.isElected ? 1 : 0, unit: "boolean", confidence: "DIRECT", address: w.address },
      { category: "VALIDATOR", metricName: "sr_latest_block", value: w.latestBlockNum, unit: "block", confidence: "DIRECT", address: w.address },
    );
  }

  return createMetricBatch(shared, entries);
}

const FINDING_CATEGORY_MAP: Readonly<Record<string, MetricCategory>> = {
  "network-emission-status": "MONETARY",
  "network-health-score": "ECOSYSTEM",
  "dormant-tokens-detected": "TOKEN",
  "high-velocity-tokens": "TOKEN",
  "extreme-gini-concentration": "HOLDER",
  "energy-rental-high-volume": "RESOURCE",
  "energy-rental-outflow-imbalance": "RESOURCE",
  "energy-rental-provider-concentration": "RESOURCE",
  "energy-rental-consumer-base": "RESOURCE",
  "energy-rental-irregular-payment": "RESOURCE",
  "energy-cost-comparison": "RESOURCE",
  "energy-rental-market-share": "RESOURCE",
};

export function findingsToRecords(
  findings: readonly AuditFinding[],
  blockchain: string,
  timestamp: Date,
): readonly MetricRecord[] {
  const shared = {
    blockchain,
    source: "analyzer",
    timestamp,
    blockHeight: null,
  };

  const entries: EntryInput[] = [];

  for (const f of findings) {
    const category = FINDING_CATEGORY_MAP[f.category] ?? "ECOSYSTEM";
    entries.push({
      category,
      metricName: `finding_${f.category}`,
      value: f.severity,
      unit: "severity",
      confidence: "DERIVED",
      metadata: {
        analyzerName: f.analyzerName,
        module: f.module,
        title: f.title,
        description: f.description,
        evidence: f.evidence,
        recommendation: f.recommendation,
      },
    });
  }

  return createMetricBatch(shared, entries);
}
