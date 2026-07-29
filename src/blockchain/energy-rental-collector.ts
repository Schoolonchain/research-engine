import type { TronHttpClient } from "./tron-http-client.js";

export interface EnergyRentalPlatform {
  readonly name: string;
  readonly paymentAddress: string;
}

export interface TransferRecord {
  readonly txId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly timestamp: number;
}

export interface PlatformDelegationInfo {
  readonly delegatedToCount: number;
  readonly receivedFromCount: number;
  readonly delegatedToAddresses: readonly string[];
  readonly receivedFromAddresses: readonly string[];
}

export interface PlatformResourceInfo {
  readonly energyLimit: number;
  readonly energyUsed: number;
  readonly bandwidthLimit: number;
  readonly bandwidthUsed: number;
}

export interface PlatformActivity {
  readonly platform: EnergyRentalPlatform;
  readonly accountBalance: number;
  readonly outgoingTransfers: readonly TransferRecord[];
  readonly incomingTransfers: readonly TransferRecord[];
  readonly delegation: PlatformDelegationInfo;
  readonly resources: PlatformResourceInfo;
  readonly outgoingVolume: number;
  readonly incomingVolume: number;
  readonly uniquePayees: number;
  readonly uniquePayers: number;
}

export interface EnergyRentalMarketData {
  readonly platforms: readonly PlatformActivity[];
  readonly collectedAt: Date;
  readonly source: string;
}

export const KNOWN_PLATFORMS: readonly EnergyRentalPlatform[] = Object.freeze([
  Object.freeze({ name: "Brutus Finance", paymentAddress: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf" }),
]);

interface TronScanTransferResponse {
  readonly data?: readonly {
    readonly transaction_id?: string;
    readonly from?: string;
    readonly to?: string;
    readonly amount?: number;
    readonly block_timestamp?: number;
  }[];
  readonly total?: number;
}

interface TronScanAccountResponse {
  readonly balance?: number;
  readonly totalFrozenV2?: number;
}

interface DelegationIndexResponse {
  readonly account?: string;
  readonly fromAccounts?: readonly string[];
  readonly toAccounts?: readonly string[];
}

interface AccountResourceResponse {
  readonly EnergyLimit?: number;
  readonly EnergyUsed?: number;
  readonly NetLimit?: number;
  readonly NetUsed?: number;
  readonly freeNetLimit?: number;
  readonly freeNetUsed?: number;
}

export class EnergyRentalCollector {
  constructor(
    private readonly trongrid: TronHttpClient,
    private readonly tronscan: TronHttpClient,
    private readonly platforms: readonly EnergyRentalPlatform[] = KNOWN_PLATFORMS,
    private readonly transferLimit: number = 50,
  ) {}

  async collect(): Promise<EnergyRentalMarketData> {
    const activities: PlatformActivity[] = [];

    for (const platform of this.platforms) {
      const activity = await this.collectPlatform(platform);
      activities.push(Object.freeze(activity));
    }

    return Object.freeze({
      platforms: Object.freeze(activities),
      collectedAt: new Date(),
      source: "trongrid+tronscan",
    });
  }

  private async collectPlatform(
    platform: EnergyRentalPlatform,
  ): Promise<PlatformActivity> {
    const [outgoing, incoming, delegation, resources, balance] =
      await Promise.all([
        this.fetchTransfers(platform.paymentAddress, "from"),
        this.fetchTransfers(platform.paymentAddress, "to"),
        this.fetchDelegation(platform.paymentAddress),
        this.fetchResources(platform.paymentAddress),
        this.fetchBalance(platform.paymentAddress),
      ]);

    const outgoingVolume = outgoing.reduce((sum, t) => sum + t.amount, 0);
    const incomingVolume = incoming.reduce((sum, t) => sum + t.amount, 0);
    const uniquePayees = new Set(outgoing.map((t) => t.to)).size;
    const uniquePayers = new Set(incoming.map((t) => t.from)).size;

    return {
      platform,
      accountBalance: balance,
      outgoingTransfers: Object.freeze(outgoing),
      incomingTransfers: Object.freeze(incoming),
      delegation,
      resources,
      outgoingVolume,
      incomingVolume,
      uniquePayees,
      uniquePayers,
    };
  }

  private async fetchTransfers(
    address: string,
    direction: "from" | "to",
  ): Promise<readonly TransferRecord[]> {
    try {
      const params: Record<string, string> = {
        sort: "-timestamp",
        limit: String(this.transferLimit),
        start: "0",
      };
      params[direction] = address;

      const response = await this.tronscan.get<TronScanTransferResponse>(
        "/api/transfer/trx",
        params,
      );

      return (response.data ?? [])
        .filter((t) => t.transaction_id && t.from && t.to)
        .map((t) =>
          Object.freeze({
            txId: t.transaction_id!,
            from: t.from!,
            to: t.to!,
            amount: (t.amount ?? 0) / 1_000_000,
            timestamp: t.block_timestamp ?? 0,
          }),
        );
    } catch {
      return [];
    }
  }

  private async fetchDelegation(
    address: string,
  ): Promise<PlatformDelegationInfo> {
    try {
      const response = await this.trongrid.post<DelegationIndexResponse>(
        "/wallet/getdelegatedresourceaccountindexV2",
        { value: address },
      );

      const toAccounts = response.toAccounts ?? [];
      const fromAccounts = response.fromAccounts ?? [];

      return Object.freeze({
        delegatedToCount: toAccounts.length,
        receivedFromCount: fromAccounts.length,
        delegatedToAddresses: Object.freeze([...toAccounts]),
        receivedFromAddresses: Object.freeze([...fromAccounts]),
      });
    } catch {
      return Object.freeze({
        delegatedToCount: 0,
        receivedFromCount: 0,
        delegatedToAddresses: Object.freeze([] as string[]),
        receivedFromAddresses: Object.freeze([] as string[]),
      });
    }
  }

  private async fetchResources(
    address: string,
  ): Promise<PlatformResourceInfo> {
    try {
      const response = await this.trongrid.post<AccountResourceResponse>(
        "/wallet/getaccountresource",
        { address },
      );

      return Object.freeze({
        energyLimit: response.EnergyLimit ?? 0,
        energyUsed: response.EnergyUsed ?? 0,
        bandwidthLimit:
          (response.NetLimit ?? 0) + (response.freeNetLimit ?? 0),
        bandwidthUsed:
          (response.NetUsed ?? 0) + (response.freeNetUsed ?? 0),
      });
    } catch {
      return Object.freeze({
        energyLimit: 0,
        energyUsed: 0,
        bandwidthLimit: 0,
        bandwidthUsed: 0,
      });
    }
  }

  private async fetchBalance(address: string): Promise<number> {
    try {
      const response = await this.tronscan.get<TronScanAccountResponse>(
        "/api/accountv2",
        { address },
      );
      return (response.balance ?? 0) / 1_000_000;
    } catch {
      return 0;
    }
  }
}
