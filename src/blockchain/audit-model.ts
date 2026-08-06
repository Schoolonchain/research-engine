import type { AccountPermission } from "./normalizers.js";

export interface TronAccountInfo {
  readonly address: string;
  readonly balanceSun: string;
  readonly balanceTrx: string;
  readonly createTime: number | null;
  readonly latestOperationTime: number | null;
  readonly isContract: boolean;
  readonly accountName: string | null;

  readonly frozenBalanceSun: string;
  readonly energyLimit: number;
  readonly energyUsed: number;
  readonly bandwidthLimit: number;
  readonly bandwidthUsed: number;
  readonly netLimit: number;
  readonly netUsed: number;
  readonly delegatedFrozenBalanceSun: string;

  readonly trc20Balances: readonly TronTokenBalance[];
  readonly permissions: readonly AccountPermission[];

  readonly collectedAt: Date;
  readonly source: string;
}

export interface TronTokenBalance {
  readonly contractAddress: string;
  readonly symbol: string;
  readonly name: string;
  readonly balance: string;
  readonly decimals: number;
}

export interface TronTokenInfo {
  readonly contractAddress: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: string;
  readonly holderCount: number;
  readonly transferCount: number;
  readonly issuerAddress: string | null;
  readonly iconUrl: string | null;
  readonly description: string | null;

  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;

  readonly collectedAt: Date;
  readonly source: string;
}

export interface TronContractInfo {
  readonly address: string;
  readonly name: string | null;
  readonly creatorAddress: string | null;
  readonly creationTxHash: string | null;
  readonly createdAt: number | null;
  readonly isVerified: boolean;
  readonly compilerVersion: string | null;
  readonly abi: readonly Record<string, unknown>[] | null;
  readonly energyFactor: number | null;

  readonly callCount: number | null;
  readonly callerCount: number | null;

  readonly collectedAt: Date;
  readonly source: string;
}

export interface AccountTarget {
  readonly address: string;
}

export interface TokenTarget {
  readonly contractAddress: string;
}

export interface ContractTarget {
  readonly address: string;
}
