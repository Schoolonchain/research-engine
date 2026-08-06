import type { MetricCategory, MetricConfidence, MetricDefinition } from "./metric-types.js";

function def(
  name: string,
  category: MetricCategory,
  unit: string,
  description: string,
  confidence: MetricConfidence = "DIRECT",
  valueType: "number" | "string" = "number",
): MetricDefinition {
  return Object.freeze({ name, category, unit, description, confidence, valueType });
}

export const TRON_METRICS: readonly MetricDefinition[] = Object.freeze([
  // ── NETWORK ──
  def("energy_fee_sun", "NETWORK", "SUN", "Energy fee per unit"),
  def("total_energy_limit", "NETWORK", "energy", "Total energy available on network"),
  def("total_energy_weight", "NETWORK", "SUN", "Total TRX staked for energy"),
  def("dynamic_increase_factor", "NETWORK", "factor", "Dynamic energy price increase factor"),
  def("dynamic_max_factor", "NETWORK", "factor", "Dynamic energy max price multiplier"),
  def("energy_yield_per_trx", "NETWORK", "energy/TRX", "Energy obtained per 1 TRX staked", "DERIVED"),
  def("transaction_fee", "NETWORK", "SUN", "Bandwidth fee per byte"),
  def("total_net_limit", "NETWORK", "bandwidth", "Total bandwidth available"),
  def("total_net_weight", "NETWORK", "SUN", "Total TRX staked for bandwidth"),
  def("bandwidth_yield_per_trx", "NETWORK", "bw/TRX", "Bandwidth obtained per 1 TRX staked", "DERIVED"),
  def("staking_ratio", "NETWORK", "ratio", "Fraction of TRX supply staked", "DERIVED"),
  def("network_health_score", "NETWORK", "score", "Composite network health 0-100", "DERIVED"),
  def("network_health_grade", "NETWORK", "grade", "Health grade A-F", "DERIVED", "string"),

  // ── MONETARY ──
  def("create_account_fee", "MONETARY", "SUN", "Fee to create a new account"),
  def("burn_trx_amount", "MONETARY", "SUN", "Base TRX burn amount per tx"),
  def("witness_pay_per_block", "MONETARY", "SUN", "SR block reward"),
  def("witness127_pay_per_block", "MONETARY", "SUN", "Partner SR block reward"),
  def("maintenance_interval_ms", "MONETARY", "ms", "Maintenance interval duration"),
  def("daily_sr_emission_trx", "MONETARY", "TRX", "Daily TRX emitted to SRs", "DERIVED"),
  def("daily_partner_emission_trx", "MONETARY", "TRX", "Daily TRX emitted to partner SRs", "DERIVED"),
  def("total_daily_emission_trx", "MONETARY", "TRX", "Total daily TRX emission", "DERIVED"),
  def("annual_emission_trx", "MONETARY", "TRX", "Annual TRX emission estimate", "DERIVED"),
  def("estimated_daily_burn_trx", "MONETARY", "TRX", "Estimated daily TRX burned", "ESTIMATED"),
  def("net_daily_issuance_trx", "MONETARY", "TRX", "Net daily TRX issuance (emission - burn)", "DERIVED"),
  def("is_deflationary", "MONETARY", "boolean", "Whether burn exceeds emission", "DERIVED"),

  // ── RESOURCE ──
  def("account_energy_limit", "RESOURCE", "energy", "Energy limit for an account"),
  def("account_energy_used", "RESOURCE", "energy", "Energy used by an account"),
  def("account_bandwidth_limit", "RESOURCE", "bandwidth", "Bandwidth limit for an account"),
  def("account_bandwidth_used", "RESOURCE", "bandwidth", "Bandwidth used by an account"),
  def("account_frozen_energy", "RESOURCE", "SUN", "TRX frozen for energy"),
  def("account_frozen_bandwidth", "RESOURCE", "SUN", "TRX frozen for bandwidth"),
  def("account_voting_power", "RESOURCE", "votes", "Account voting power"),
  def("delegation_to_count", "RESOURCE", "count", "Accounts this address delegates to"),
  def("delegation_from_count", "RESOURCE", "count", "Accounts delegating to this address"),

  // ── GOVERNANCE ──
  def("total_votes", "GOVERNANCE", "votes", "Total votes cast network-wide"),
  def("elected_sr_count", "GOVERNANCE", "count", "Number of elected SRs"),
  def("witness_vote_count", "GOVERNANCE", "votes", "Votes received by a witness"),
  def("witness_total_produced", "GOVERNANCE", "blocks", "Total blocks produced by witness"),
  def("witness_total_missed", "GOVERNANCE", "blocks", "Total blocks missed by witness"),
  def("witness_productivity", "GOVERNANCE", "%", "Block production success rate", "DERIVED"),
  def("proposal_count", "GOVERNANCE", "count", "Total governance proposals"),
  def("active_proposal_count", "GOVERNANCE", "count", "Currently active proposals"),

  // ── HOLDER ──
  def("top_holder_balance", "HOLDER", "TRX", "Balance of a top holder"),
  def("top_holder_frozen", "HOLDER", "TRX", "Frozen balance of a top holder"),
  def("gini_coefficient", "HOLDER", "coefficient", "Token wealth concentration index", "DERIVED"),
  def("gini_classification", "HOLDER", "class", "Gini category (egalitarian/moderate/concentrated/extreme)", "DERIVED", "string"),

  // ── TOKEN ──
  def("token_holder_count", "TOKEN", "count", "Number of token holders"),
  def("token_transfer_count", "TOKEN", "count", "Total token transfers"),
  def("token_market_cap", "TOKEN", "USD", "Token market capitalization"),
  def("token_price_usd", "TOKEN", "USD", "Token price in USD"),
  def("token_total_supply", "TOKEN", "tokens", "Token total supply"),
  def("token_velocity", "TOKEN", "transfers/holder", "Token transaction velocity", "DERIVED"),
  def("token_velocity_class", "TOKEN", "class", "Velocity classification (high/medium/low/dormant)", "DERIVED", "string"),

  // ── STABLECOIN ──
  def("stablecoin_dominance_pct", "STABLECOIN", "%", "Stablecoin share of TRC20 market cap", "DERIVED"),

  // ── VALIDATOR ──
  def("sr_is_elected", "VALIDATOR", "boolean", "Whether SR is in the elected set"),
  def("sr_latest_block", "VALIDATOR", "block", "Most recent block produced by SR"),

  // ── WHALE ──
  def("whale_balance", "WHALE", "TRX", "Balance of a whale account"),
  def("whale_staking_status", "WHALE", "boolean", "Whether whale is staking", "DERIVED"),

  // ── ECOSYSTEM ──
  def("health_staking", "ECOSYSTEM", "score", "Health sub-score: staking", "DERIVED"),
  def("health_decentralization", "ECOSYSTEM", "score", "Health sub-score: decentralization", "DERIVED"),
  def("health_energy_market", "ECOSYSTEM", "score", "Health sub-score: energy market", "DERIVED"),
  def("health_token_diversity", "ECOSYSTEM", "score", "Health sub-score: token diversity", "DERIVED"),
  def("health_emission_sustainability", "ECOSYSTEM", "score", "Health sub-score: emission", "DERIVED"),
  def("ecosystem_top_token_dominance", "ECOSYSTEM", "%", "Top token market cap dominance", "DERIVED"),

  // ── RESOURCE (energy rental) ──
  def("rental_platform_volume", "RESOURCE", "TRX", "Total volume through rental platform"),
  def("rental_platform_energy_limit", "RESOURCE", "energy", "Energy held by rental platform"),
  def("rental_outflow_ratio", "RESOURCE", "ratio", "Outgoing/incoming volume ratio", "DERIVED"),
  def("rental_market_share_pct", "RESOURCE", "%", "Rental platform share of network energy", "DERIVED"),
  def("direct_fee_cost_per_100k", "RESOURCE", "TRX", "Cost of 100k energy via direct fees", "DERIVED"),
  def("self_stake_required_for_100k", "RESOURCE", "TRX", "TRX to stake for 100k energy", "DERIVED"),
]);

export class MetricRegistry {
  private readonly byName: ReadonlyMap<string, MetricDefinition>;
  private readonly byCategory: ReadonlyMap<string, readonly MetricDefinition[]>;

  constructor(definitions: readonly MetricDefinition[]) {
    const nameMap = new Map<string, MetricDefinition>();
    const catMap = new Map<string, MetricDefinition[]>();

    for (const d of definitions) {
      nameMap.set(d.name, d);
      const list = catMap.get(d.category);
      if (list) {
        list.push(d);
      } else {
        catMap.set(d.category, [d]);
      }
    }

    this.byName = nameMap;
    this.byCategory = catMap;
  }

  get(name: string): MetricDefinition | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  forCategory(category: string): readonly MetricDefinition[] {
    return this.byCategory.get(category) ?? [];
  }

  all(): readonly MetricDefinition[] {
    return [...this.byName.values()];
  }

  categories(): readonly string[] {
    return [...this.byCategory.keys()];
  }
}

export const tronRegistry = new MetricRegistry(TRON_METRICS);
