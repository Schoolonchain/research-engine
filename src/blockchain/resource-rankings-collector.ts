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

const SCAN_LIMIT = 50;
const BATCH_SIZE = 5;

export class ResourceRankingsCollector {
  constructor(
    private readonly trongrid: TronHttpClient,
    private readonly tronscan: TronHttpClient | null = null,
  ) {}

  async collect(): Promise<ResourceRankingsData> {
    const rawAccounts = await this.fetchTopAccountsByPower(SCAN_LIMIT);

    if (rawAccounts.length === 0) {
      return Object.freeze({
        topStakers: Object.freeze([]),
        topEnergyConsumers: Object.freeze([]),
        topEnergyDelegators: Object.freeze([]),
        delegationSummaries: Object.freeze([]),
        collectedAt: new Date(),
        source: "trongrid+tronscan",
      });
    }

    const enriched: ResourceAccountData[] = [];
    const delegators: EnergyDelegator[] = [];
    const summaries: DelegationSummary[] = [];

    for (let i = 0; i < rawAccounts.length; i += BATCH_SIZE) {
      const batch = rawAccounts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (acct) => {
          const [resource, delegation] = await Promise.all([
            this.fetchAccountResource(acct.address),
            this.fetchDelegationIndex(acct.address),
          ]);
          return { acct, resource, delegation };
        }),
      );

      for (const { acct, resource, delegation } of results) {
        enriched.push(
          Object.freeze({
            address: acct.address,
            balance: acct.balance,
            frozenForEnergy: acct.frozenForEnergy,
            frozenForBandwidth: acct.frozenForBandwidth,
            votingPower: acct.power,
            energyLimit: resource?.EnergyLimit ?? 0,
            energyUsed: resource?.EnergyUsed ?? 0,
            bandwidthLimit: (resource?.NetLimit ?? 0) + (resource?.freeNetLimit ?? 0),
            bandwidthUsed: (resource?.NetUsed ?? 0) + (resource?.freeNetUsed ?? 0),
          }),
        );

        const toAccounts = delegation?.toAccounts ?? [];
        const fromAccounts = delegation?.fromAccounts ?? [];

        summaries.push(
          Object.freeze({
            address: acct.address,
            delegatedToCount: toAccounts.length,
            receivedFromCount: fromAccounts.length,
          }),
        );

        if (toAccounts.length > 0) {
          delegators.push(
            Object.freeze({
              address: acct.address,
              delegatedToCount: toAccounts.length,
              delegatedToAddresses: Object.freeze(toAccounts),
              energyLimit: resource?.EnergyLimit ?? 0,
              energyUsed: resource?.EnergyUsed ?? 0,
              balance: acct.balance,
            }),
          );
        }
      }
    }

    const topStakers = enriched.slice(0, 10);

    const topEnergyConsumers = [...enriched]
      .filter((a) => a.energyLimit > 0 || a.energyUsed > 0)
      .sort((a, b) => b.energyLimit - a.energyLimit)
      .slice(0, 10);

    const topEnergyDelegators = [...delegators]
      .sort((a, b) => b.delegatedToCount - a.delegatedToCount)
      .slice(0, 10);

    return Object.freeze({
      topStakers: Object.freeze(topStakers),
      topEnergyConsumers: Object.freeze(topEnergyConsumers),
      topEnergyDelegators: Object.freeze(topEnergyDelegators),
      delegationSummaries: Object.freeze(summaries),
      collectedAt: new Date(),
      source: "trongrid+tronscan",
    });
  }

  private async fetchTopAccountsByPower(
    limit: number,
  ): Promise<
    readonly { address: string; balance: number; frozenForEnergy: number; frozenForBandwidth: number; power: number }[]
  > {
    if (!this.tronscan) return [];

    try {
      const response = await this.tronscan.get<TronScanAccountResponse>("/api/account/list", {
        sort: "-power",
        limit: String(limit),
        start: "0",
      });

      return (response.data ?? [])
        .filter((a) => a.address)
        .map((a) => ({
          address: a.address!,
          balance: (a.balance ?? 0) / 1_000_000,
          frozenForEnergy: (a.frozenForEnergyV2 ?? 0) / 1_000_000,
          frozenForBandwidth: (a.frozenForBandWidthV2 ?? 0) / 1_000_000,
          power: a.power ?? 0,
        }));
    } catch {
      return [];
    }
  }

  private async fetchAccountResource(address: string): Promise<AccountResourceResponse | null> {
    try {
      return await this.trongrid.post<AccountResourceResponse>("/wallet/getaccountresource", {
        address,
      });
    } catch {
      return null;
    }
  }

  private async fetchDelegationIndex(address: string): Promise<DelegationIndexResponse | null> {
    try {
      return await this.trongrid.post<DelegationIndexResponse>(
        "/wallet/getdelegatedresourceaccountindexV2",
        { value: address },
      );
    } catch {
      return null;
    }
  }
}
