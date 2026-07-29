import type { TronHttpClient } from "./tron-http-client.js";

export interface ResourceAccountData {
  readonly address: string;
  readonly balance: number;
  readonly frozenForEnergy: number;
  readonly frozenForBandwidth: number;
  readonly votingPower: number;
  readonly energyLimit: number;
  readonly energyUsed: number;
  readonly bandwidthLimit: number;
  readonly bandwidthUsed: number;
}

export interface DelegationSummary {
  readonly address: string;
  readonly delegatedToCount: number;
  readonly receivedFromCount: number;
}

export interface ResourceRankingsData {
  readonly topStakers: readonly ResourceAccountData[];
  readonly delegationSummaries: readonly DelegationSummary[];
  readonly collectedAt: Date;
  readonly source: string;
}

interface TronScanAccountResponse {
  readonly data?: readonly {
    readonly address?: string;
    readonly balance?: number;
    readonly totalFrozenV2?: number;
    readonly frozenForEnergyV2?: number;
    readonly frozenForBandWidthV2?: number;
    readonly power?: number;
  }[];
}

interface AccountResourceResponse {
  readonly EnergyLimit?: number;
  readonly EnergyUsed?: number;
  readonly NetLimit?: number;
  readonly NetUsed?: number;
  readonly freeNetLimit?: number;
  readonly freeNetUsed?: number;
}

interface DelegationIndexResponse {
  readonly account?: string;
  readonly fromAccounts?: readonly string[];
  readonly toAccounts?: readonly string[];
}

export class ResourceRankingsCollector {
  constructor(
    private readonly trongrid: TronHttpClient,
    private readonly tronscan: TronHttpClient | null = null,
  ) {}

  async collect(): Promise<ResourceRankingsData> {
    const topStakers = await this.fetchTopStakers();
    const delegationSummaries = await this.fetchDelegationSummaries(
      topStakers.slice(0, 10).map((s) => s.address),
    );

    return Object.freeze({
      topStakers: Object.freeze(topStakers),
      delegationSummaries: Object.freeze(delegationSummaries),
      collectedAt: new Date(),
      source: "trongrid+tronscan",
    });
  }

  private async fetchTopStakers(): Promise<readonly ResourceAccountData[]> {
    if (!this.tronscan) return [];

    try {
      const response = await this.tronscan.get<TronScanAccountResponse>(
        "/api/account/list",
        { sort: "-power", limit: "20", start: "0" },
      );

      const accounts = (response.data ?? []).filter((a) => a.address);
      const top = accounts.slice(0, 10);

      const enriched = await Promise.all(
        top.map(async (a) => {
          const resource = await this.fetchAccountResource(a.address!);
          return Object.freeze({
            address: a.address!,
            balance: (a.balance ?? 0) / 1_000_000,
            frozenForEnergy: (a.frozenForEnergyV2 ?? 0) / 1_000_000,
            frozenForBandwidth: (a.frozenForBandWidthV2 ?? 0) / 1_000_000,
            votingPower: a.power ?? 0,
            energyLimit: resource?.EnergyLimit ?? 0,
            energyUsed: resource?.EnergyUsed ?? 0,
            bandwidthLimit: (resource?.NetLimit ?? 0) + (resource?.freeNetLimit ?? 0),
            bandwidthUsed: (resource?.NetUsed ?? 0) + (resource?.freeNetUsed ?? 0),
          });
        }),
      );

      return enriched;
    } catch {
      return [];
    }
  }

  private async fetchAccountResource(
    address: string,
  ): Promise<AccountResourceResponse | null> {
    try {
      return await this.trongrid.post<AccountResourceResponse>(
        "/wallet/getaccountresource",
        { address },
      );
    } catch {
      return null;
    }
  }

  private async fetchDelegationSummaries(
    addresses: readonly string[],
  ): Promise<readonly DelegationSummary[]> {
    const summaries: DelegationSummary[] = [];

    for (const address of addresses) {
      try {
        const response = await this.trongrid.post<DelegationIndexResponse>(
          "/wallet/getdelegatedresourceaccountindexV2",
          { value: address },
        );

        summaries.push(
          Object.freeze({
            address,
            delegatedToCount: response.toAccounts?.length ?? 0,
            receivedFromCount: response.fromAccounts?.length ?? 0,
          }),
        );
      } catch {
        summaries.push(
          Object.freeze({
            address,
            delegatedToCount: 0,
            receivedFromCount: 0,
          }),
        );
      }
    }

    return summaries;
  }
}
