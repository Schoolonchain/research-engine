import type { DataSourceType, RawBlock } from "./model.js";

export interface BlockchainConnector {
  readonly networkName: string;
  readonly chainId: string;
  readonly sourceName: string;
  readonly sourceType: DataSourceType;
  readonly sourceEndpoint: string;
  getLatestBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<RawBlock>;
}
