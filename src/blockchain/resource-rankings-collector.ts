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

export interface EnergyDelegator {
  readonly address: string;
  readonly delegatedToCount: number;
  readonly delegatedToAddresses: readonly string[];
  readonly energyLimit: number;
  readonly energyUsed: number;
  readonly balance: number;
}

export interface ResourceRankingsData {
  readonly topStakers: readonly ResourceAccountData[];
  readonly topEnergyConsumers: readonly ResourceAccountData[];
  readonly topEnergyDelegators: readonly EnergyDelegator[];
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
    const [topStakers, topEnergyConsumers] = await Promise.all([
      this.fetchTopStakers(),
      this.fetchTopBySort("-frozenForEnergyV2"),
    ]);

    const allAddresses = [
      ...new Set([
        ...topStakers.slice(0, 10).map((s) => s.address),
        ...topEnergyConsumers.slice(0, 10).map((s) => s.address),
      ]),
    ];

    const delegationSummaries = await this.fetchDelegationSummaries(allAddresses);

    const topEnergyDelegators = await this.fetchTopDelegators(
      topEnergyConsumers.filter((a) => a.energyLimit > 0).map((a) => a.address),
    );

    return Object.freeze({
      topStakers: Object.freeze(topStakers),
      topEnergyConsumers: Object.freeze(topEnergyConsumers),
      topEnergyDelegators: Object.freeze(topEnergyDelegators),
      delegationSummaries: Object.freeze(delegationSummaries),
      collectedAt: new Date(),
      source: "trongrid+tronscan",
    });
  }

  private async fetchTopStakers(): Promise<readonly ResourceAccountData[]> {
    return this.fetchTopBySort("-power");
  }

  private async fetchTopBySort(sort: string): Promise<readonly ResourceAccountData[]> {
    if (!this.tronscan) return [];

    try {
      const response = await this.tronscan.get<TronScanAccountResponse>(
        "/api/account/list",
        { sort, limit: "20", start: "0" },
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

  private async fetchTopDelegators(
    addresses: readonly string[],
  ): Promise<readonly EnergyDelegator[]> {
    const delegators: EnergyDelegator[] = [];

    for (const address of addresses.slice(0, 15)) {
      try {
        const response = await this.trongrid.post<DelegationIndexResponse>(
          "/wallet/getdelegatedresourceaccountindexV2",
          { value: address },
        );

        const toAccounts = response.toAccounts ?? [];
        if (toAccounts.length > 0) {
          const resource = await this.fetchAccountResource(address);
          delegators.push(
            Object.freeze({
              address,
              delegatedToCount: toAccounts.length,
              delegatedToAddresses: Object.freeze(toAccounts),
              energyLimit: resource?.EnergyLimit ?? 0,
              energyUsed: resource?.EnergyUsed ?? 0,
              balance: 0,
            }),
          );
        }
      } catch {
        // skip
      }
    }

    return delegators.sort((a, b) => b.delegatedToCount - a.delegatedToCount);
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
