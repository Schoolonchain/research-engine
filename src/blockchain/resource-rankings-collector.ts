import type { TronHttpClient } from "./tron-http-client.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58ToHex(base58: string): string {
  let num = 0n;
  for (const char of base58) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid Base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hex.slice(0, -8);
}

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

export interface TopContract {
  readonly address: string;
  readonly name: string;
  readonly trxCount: number;
  readonly balance: number;
  readonly tag: string;
}

export interface ResourceRankingsData {
  readonly topStakers: readonly ResourceAccountData[];
  readonly topEnergyConsumers: readonly ResourceAccountData[];
  readonly topEnergyDelegators: readonly EnergyDelegator[];
  readonly delegationSummaries: readonly DelegationSummary[];
  readonly topContracts: readonly TopContract[];
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
  readonly Error?: string;
}

interface V1AccountResponse {
  readonly data?: readonly {
    readonly account_resource?: {
      readonly acquired_delegated_frozenV2_balance_for_energy?: number;
      readonly energy_usage?: number;
      readonly latest_consume_time_for_energy?: number;
    };
  }[];
}

interface TronScanContractsResponse {
  readonly data?: readonly {
    readonly address?: string;
    readonly name?: string;
    readonly trxCount?: number;
    readonly balance?: number;
    readonly tag1?: string;
  }[];
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
    const [rawAccounts, topContracts] = await Promise.all([
      this.fetchTopAccountsByPower(SCAN_LIMIT),
      this.fetchTopContracts(20),
    ]);

    if (rawAccounts.length === 0) {
      return Object.freeze({
        topStakers: Object.freeze([]),
        topEnergyConsumers: Object.freeze([]),
        topEnergyDelegators: Object.freeze([]),
        delegationSummaries: Object.freeze([]),
        topContracts: Object.freeze(topContracts),
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
          const hexAddr = base58ToHex(acct.address);
          const [resource, v1Data, delegation] = await Promise.all([
            this.fetchAccountResource(hexAddr),
            this.fetchV1AccountResource(acct.address),
            this.fetchDelegationIndex(hexAddr),
          ]);
          return { acct, resource, v1Data, delegation };
        }),
      );

      for (const { acct, resource, v1Data, delegation } of results) {
        const energyLimit = resource?.EnergyLimit ?? 0;
        const energyUsed = resource?.EnergyUsed ?? v1Data?.energy_usage ?? 0;
        const hasDelegatedEnergy = (v1Data?.acquired_delegated_frozenV2_balance_for_energy ?? 0) > 0;

        enriched.push(
          Object.freeze({
            address: acct.address,
            balance: acct.balance,
            frozenForEnergy: acct.frozenForEnergy,
            frozenForBandwidth: acct.frozenForBandwidth,
            votingPower: acct.power,
            energyLimit,
            energyUsed,
            bandwidthLimit: (resource?.NetLimit ?? 0) + (resource?.freeNetLimit ?? 0),
            bandwidthUsed: (resource?.NetUsed ?? 0) + (resource?.freeNetUsed ?? 0),
          }),
        );

        const toAccounts = delegation?.toAccounts ?? [];
        const fromAccounts = delegation?.fromAccounts ?? [];
        const receivedFromCount = fromAccounts.length > 0 ? fromAccounts.length : (hasDelegatedEnergy ? 1 : 0);

        summaries.push(
          Object.freeze({
            address: acct.address,
            delegatedToCount: toAccounts.length,
            receivedFromCount,
          }),
        );

        if (toAccounts.length > 0) {
          delegators.push(
            Object.freeze({
              address: acct.address,
              delegatedToCount: toAccounts.length,
              delegatedToAddresses: Object.freeze(toAccounts),
              energyLimit,
              energyUsed,
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
      topContracts: Object.freeze(topContracts),
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

  private async fetchAccountResource(hexAddress: string): Promise<AccountResourceResponse | null> {
    try {
      const resp = await this.trongrid.post<AccountResourceResponse>("/wallet/getaccountresource", {
        address: hexAddress,
      });
      if (resp.Error) return null;
      return resp;
    } catch {
      return null;
    }
  }

  private async fetchV1AccountResource(
    base58Address: string,
  ): Promise<{ energy_usage?: number; acquired_delegated_frozenV2_balance_for_energy?: number } | null> {
    try {
      const resp = await this.trongrid.get<V1AccountResponse>(`/v1/accounts/${base58Address}`, {});
      return resp.data?.[0]?.account_resource ?? null;
    } catch {
      return null;
    }
  }

  private async fetchDelegationIndex(hexAddress: string): Promise<DelegationIndexResponse | null> {
    try {
      return await this.trongrid.post<DelegationIndexResponse>(
        "/wallet/getdelegatedresourceaccountindexV2",
        { value: hexAddress },
      );
    } catch {
      return null;
    }
  }

  private async fetchTopContracts(limit: number): Promise<readonly TopContract[]> {
    if (!this.tronscan) return [];
    try {
      const resp = await this.tronscan.get<TronScanContractsResponse>("/api/contracts", {
        sort: "-trxCount",
        limit: String(limit),
        start: "0",
      });
      return (resp.data ?? [])
        .filter((c) => c.address)
        .map((c) =>
          Object.freeze({
            address: c.address!,
            name: c.name ?? "",
            trxCount: c.trxCount ?? 0,
            balance: (c.balance ?? 0) / 1_000_000,
            tag: c.tag1 ?? "",
          }),
        );
    } catch {
      return [];
    }
  }
}
