import type { TronHttpClient } from "./tron-http-client.js";

export interface EnergyMarketMetrics {
  readonly energyFee: number;
  readonly totalEnergyLimit: number;
  readonly totalEnergyWeight: number;
  readonly dynamicIncreaseFactor: number;
  readonly dynamicMaxFactor: number;
  readonly energyYieldPerTrx: number;
}

export interface BandwidthMarketMetrics {
  readonly transactionFee: number;
  readonly totalNetLimit: number;
  readonly totalNetWeight: number;
  readonly bandwidthYieldPerTrx: number;
}

export interface ChainEconomics {
  readonly createAccountFee: number;
  readonly burnTrxAmount: number;
  readonly witnessPayPerBlock: number;
  readonly witness127PayPerBlock: number;
  readonly maintenanceIntervalMs: number;
  readonly proposalExpireTime: number;
}

export interface AccountRanking {
  readonly address: string;
  readonly balance: number;
  readonly totalFrozen: number;
  readonly power: number;
}

export interface StakingBreakdown {
  readonly stakedForEnergyTrx: number;
  readonly stakedForBandwidthTrx: number;
  readonly totalStakedTrx: number;
  readonly totalSupplyTrx: number;
  readonly supplySource: "tronscan" | "protocol-constant";
}

export interface TronNetworkMetrics {
  readonly energy: EnergyMarketMetrics;
  readonly bandwidth: BandwidthMarketMetrics;
  readonly economics: ChainEconomics;
  readonly topHolders: readonly AccountRanking[];
  readonly staking: StakingBreakdown;
  readonly stakingRatio: number;
  readonly collectedAt: Date;
  readonly source: string;
}

interface ChainParamsResponse {
  readonly chainParameter?: readonly {
    readonly key?: string;
    readonly value?: number;
  }[];
}

interface AccountResourceGlobals {
  readonly TotalEnergyLimit?: number;
  readonly TotalEnergyWeight?: number;
  readonly TotalNetLimit?: number;
  readonly TotalNetWeight?: number;
}

interface TronScanAccountListResponse {
  readonly data?: readonly {
    readonly address?: string;
    readonly balance?: number;
    readonly totalFrozenV2?: number;
    readonly power?: number;
  }[];
  readonly total?: number;
}

interface TronScanFundResponse {
  readonly fund_trx?: number;
  readonly totalSupply?: number;
  readonly circulatingSupply?: number;
  readonly total_trx?: number;
}

const TRON_GENESIS_SUPPLY_TRX = 100_000_000_000;

function paramMap(response: ChainParamsResponse): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of response.chainParameter ?? []) {
    if (p.key !== undefined && p.value !== undefined) {
      map.set(p.key, p.value);
    }
  }
  return map;
}

export class NetworkMetricsCollector {
  constructor(
    private readonly trongrid: TronHttpClient,
    private readonly tronscan: TronHttpClient | null = null,
  ) {}

  async collect(): Promise<TronNetworkMetrics> {
    const [params, resourceGlobals] = await Promise.all([
      this.trongrid.get<ChainParamsResponse>("/wallet/getchainparameters"),
      this.fetchResourceGlobals(),
    ]);
    const pm = paramMap(params);

    const totalEnergyLimit =
      (pm.get("getTotalEnergyLimit") || resourceGlobals.TotalEnergyLimit) ?? 0;
    const totalEnergyWeight =
      (pm.get("getTotalEnergyWeight") || resourceGlobals.TotalEnergyWeight) ?? 0;
    const totalNetLimit =
      (pm.get("getTotalNetLimit") || resourceGlobals.TotalNetLimit) ?? 0;
    const totalNetWeight =
      (pm.get("getTotalNetWeight") || resourceGlobals.TotalNetWeight) ?? 0;

    const energyYieldPerTrx = totalEnergyWeight > 0
      ? totalEnergyLimit / (totalEnergyWeight / 1_000_000)
      : 0;

    const bandwidthYieldPerTrx = totalNetWeight > 0
      ? totalNetLimit / (totalNetWeight / 1_000_000)
      : 0;

    const energy: EnergyMarketMetrics = Object.freeze({
      energyFee: pm.get("getEnergyFee") ?? 0,
      totalEnergyLimit,
      totalEnergyWeight,
      dynamicIncreaseFactor: pm.get("getDynamicEnergyIncreaseFactor") ?? 0,
      dynamicMaxFactor: pm.get("getDynamicEnergyMaxFactor") ?? 0,
      energyYieldPerTrx: Math.round(energyYieldPerTrx * 100) / 100,
    });

    const bandwidth: BandwidthMarketMetrics = Object.freeze({
      transactionFee: pm.get("getTransactionFee") ?? 0,
      totalNetLimit,
      totalNetWeight,
      bandwidthYieldPerTrx: Math.round(bandwidthYieldPerTrx * 100) / 100,
    });

    const economics: ChainEconomics = Object.freeze({
      createAccountFee: pm.get("getCreateAccountFee") ?? 0,
      burnTrxAmount: pm.get("getBurnTrxAmount") ?? 0,
      witnessPayPerBlock: pm.get("getWitnessPayPerBlock") ?? 0,
      witness127PayPerBlock: pm.get("getWitness127PayPerBlock") ?? 0,
      maintenanceIntervalMs: pm.get("getMaintenanceTimeInterval") ?? 0,
      proposalExpireTime: pm.get("getProposalExpireTime") ?? 0,
    });

    const [topHolders, supplyResult] = await Promise.all([
      this.fetchTopHolders(),
      this.fetchTotalSupply(),
    ]);

    // getaccountresource returns weights in TRX (verified by cross-referencing
    // individual account frozen balances against their energy share).
    // Values > 1 trillion indicate SUN (from getchainparameters) — normalise.
    const toTrx = (v: number) => (v > 1e12 ? v / 1_000_000 : v);
    const stakedForEnergyTrx = toTrx(totalEnergyWeight);
    const stakedForBandwidthTrx = toTrx(totalNetWeight);
    const totalStakedTrx = stakedForEnergyTrx + stakedForBandwidthTrx;

    const totalSupplyTrx = supplyResult.supply;
    const stakingRatio = totalStakedTrx > 0 && totalSupplyTrx > 0
      ? Math.round((totalStakedTrx / totalSupplyTrx) * 10000) / 10000
      : 0;

    const staking: StakingBreakdown = Object.freeze({
      stakedForEnergyTrx,
      stakedForBandwidthTrx,
      totalStakedTrx,
      totalSupplyTrx,
      supplySource: supplyResult.source,
    });

    return Object.freeze({
      energy,
      bandwidth,
      economics,
      topHolders: Object.freeze(topHolders),
      staking,
      stakingRatio,
      collectedAt: new Date(),
      source: "trongrid+tronscan",
    });
  }

  private async fetchResourceGlobals(): Promise<AccountResourceGlobals> {
    try {
      // Any valid hex address works — the response always includes global totals.
      // TRON genesis address (410000…0) is always valid.
      const resp = await this.trongrid.post<AccountResourceGlobals>(
        "/wallet/getaccountresource",
        { address: "410000000000000000000000000000000000000000" },
      );
      return resp;
    } catch {
      return {};
    }
  }

  private async fetchTopHolders(): Promise<readonly AccountRanking[]> {
    if (!this.tronscan) return [];

    try {
      const response = await this.tronscan.get<TronScanAccountListResponse>(
        "/api/account/list",
        { sort: "-balance", limit: "20", start: "0" },
      );

      return (response.data ?? [])
        .filter((a) => a.address)
        .map((a) =>
          Object.freeze({
            address: a.address!,
            balance: (a.balance ?? 0) / 1_000_000,
            totalFrozen: (a.totalFrozenV2 ?? 0) / 1_000_000,
            power: a.power ?? 0,
          }),
        );
    } catch {
      return [];
    }
  }

  private async fetchTotalSupply(): Promise<{
    supply: number;
    source: StakingBreakdown["supplySource"];
  }> {
    if (!this.tronscan) {
      return { supply: TRON_GENESIS_SUPPLY_TRX, source: "protocol-constant" };
    }

    try {
      const resp = await this.tronscan.get<TronScanFundResponse>(
        "/api/trx/fund",
      );
      const supply =
        (resp.fund_trx ?? resp.totalSupply ?? resp.total_trx ?? 0) / 1_000_000;
      if (supply > 1_000_000_000) {
        return { supply, source: "tronscan" };
      }
    } catch {
      // TronScan unavailable — fall through to constant
    }

    return { supply: TRON_GENESIS_SUPPLY_TRX, source: "protocol-constant" };
  }
}
