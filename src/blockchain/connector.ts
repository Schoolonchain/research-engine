import type { RawBlock } from "./model.js";

export interface BlockchainConnector {
  readonly networkName: string;
  readonly sourceApi: string;
  getLatestBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<RawBlock>;
}
