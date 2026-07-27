export const NETWORK_STATUSES = ["ACTIVE", "INACTIVE", "DEPRECATED"] as const;
export type NetworkStatus = (typeof NETWORK_STATUSES)[number];

export const NETWORK_TYPES = ["MAINNET", "TESTNET"] as const;
export type NetworkType = (typeof NETWORK_TYPES)[number];

export const COLLECTION_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED", "PARTIAL"] as const;
export type CollectionRunStatus = (typeof COLLECTION_RUN_STATUSES)[number];

export const COLLECTION_RUN_TYPES = ["BLOCK", "RANGE", "ACCOUNT", "CONTRACT"] as const;
export type CollectionRunType = (typeof COLLECTION_RUN_TYPES)[number];

export interface BlockchainNetwork {
  readonly id: string;
  readonly name: string;
  readonly chainId: string;
  readonly networkType: NetworkType;
  readonly rpcEndpoint: string;
  readonly status: NetworkStatus;
}

export interface BlockchainBlock {
  readonly id: string;
  readonly networkId: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentHash: string;
  readonly blockTimestamp: Date;
  readonly witnessAddress: string | null;
  readonly txCount: number;
  readonly sizeBytes: number | null;
  readonly collectionSource: string;
  readonly collectedAt: Date;
}

export interface BlockchainTransaction {
  readonly id: string;
  readonly networkId: string;
  readonly blockId: string;
  readonly txHash: string;
  readonly txType: string;
  readonly fromAddress: string | null;
  readonly toAddress: string | null;
  readonly amountSun: bigint | null;
  readonly result: string | null;
  readonly feeSun: bigint | null;
  readonly energyUsed: bigint | null;
  readonly bandwidthUsed: bigint | null;
  readonly collectedAt: Date;
}

export interface DataCollectionRun {
  readonly id: string;
  readonly networkId: string;
  readonly runType: CollectionRunType;
  readonly status: CollectionRunStatus;
  readonly sourceApi: string;
  readonly blockStart: number | null;
  readonly blockEnd: number | null;
  readonly blocksCollected: number;
  readonly txsCollected: number;
  readonly errorDetail: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface RawBlock {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly witnessAddress: string | null;
  readonly txCount: number;
  readonly sizeBytes: number | null;
  readonly transactions: readonly RawTransaction[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface RawTransaction {
  readonly txHash: string;
  readonly txType: string;
  readonly fromAddress: string | null;
  readonly toAddress: string | null;
  readonly amountSun: bigint | null;
  readonly result: string | null;
  readonly feeSun: bigint | null;
  readonly energyUsed: bigint | null;
  readonly bandwidthUsed: bigint | null;
  readonly raw: Readonly<Record<string, unknown>>;
}
