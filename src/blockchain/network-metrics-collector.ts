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

export interface TronNetworkMetrics {
  readonly energy: EnergyMarketMetrics;
  readonly bandwidth: BandwidthMarketMetrics;
  readonly economics: ChainEconomics;
  readonly topHolders: readonly AccountRanking[];
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

interface TronScanAccountListResponse {
  readonly data?: readonly {
    readonly address?: string;
    readonly balance?: number;
    readonly totalFrozenV2?: number;
    readonly power?: number;
  }[];
  readonly total?: number;
}

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
    const params = await this.trongrid.get<ChainParamsResponse>(
      "/wallet/getchainparameters",
    );
    const pm = paramMap(params);

    const totalEnergyLimit = pm.get("getTotalEnergyLimit") ?? 0;
    const totalEnergyWeight = pm.get("getTotalEnergyWeight") ?? 0;
    const totalNetLimit = pm.get("getTotalNetLimit") ?? 0;
    const totalNetWeight = pm.get("getTotalNetWeight") ?? 0;

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

    const topHolders = await this.fetchTopHolders();

    const totalStaked = totalEnergyWeight + totalNetWeight;
    const stakingRatio = totalStaked > 0
      ? Math.round((totalStaked / (totalStaked + totalEnergyLimit * 1_000_000)) * 10000) / 10000
      : 0;

    return Object.freeze({
      energy,
      bandwidth,
      economics,
      topHolders: Object.freeze(topHolders),
      stakingRatio,
      collectedAt: new Date(),
      source: "trongrid+tronscan",
    });
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
}
