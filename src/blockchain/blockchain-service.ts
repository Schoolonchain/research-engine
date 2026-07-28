import { randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import type { BlockchainConnector } from "./connector.js";
import type { ConnectorRegistry } from "./connector-registry.js";
import type { BlockchainRepository } from "./blockchain-repository.js";
import type {
  BlockchainBlock,
  BlockchainDataSource,
  BlockchainNetwork,
  BlockchainTransaction,
  DataCollectionRun,
  RawTransaction,
} from "./model.js";
import type { BlockValidationResult } from "./cross-validator.js";
import { crossValidateBlock } from "./cross-validator.js";
import {
  BlockchainConflictError,
  BlockchainValidationError,
} from "./errors.js";

const MAX_RAW_DATA_BYTES = 1_048_576;
const MAX_TRANSACTIONS_PER_BLOCK = 10_000;

function assertRawDataSize(json: string, label: string): void {
  if (json.length > MAX_RAW_DATA_BYTES) {
    throw new BlockchainValidationError(
      `${label} raw_data exceeds ${MAX_RAW_DATA_BYTES} byte limit (${json.length} bytes)`,
    );
  }
}

export interface CollectBlockResult {
  readonly block: BlockchainBlock;
  readonly transactions: readonly BlockchainTransaction[];
  readonly collectionRun: DataCollectionRun;
}

export interface RangeCollectionResult {
  readonly run: DataCollectionRun;
  readonly collected: number;
  readonly skipped: number;
  readonly totalTransactions: number;
}

const MAX_RANGE_SIZE = 100;

export class BlockchainService {
  private readonly events: EventStore;

  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly registry: ConnectorRegistry,
    private readonly repository: BlockchainRepository,
  ) {
    this.events = new EventStore(database);
  }

  public async ensureNetwork(): Promise<BlockchainNetwork> {
    return this.database.transaction(async (tx) => {
      const existing = await this.repository.findNetworkByChainId(tx, this.registry.chainId);
      if (existing) return existing;
      return this.repository.upsertNetwork(tx, this.registry.networkName, this.registry.chainId, "MAINNET");
    });
  }

  public async ensureDataSource(networkId: string, connector?: BlockchainConnector): Promise<BlockchainDataSource> {
    const c = connector ?? this.registry.primary();
    return this.database.transaction(async (tx) => {
      const existing = await this.repository.findDataSourceByName(tx, networkId, c.sourceName);
      if (existing) return existing;
      return this.repository.upsertDataSource(
        tx, networkId, c.sourceType, c.sourceName, c.sourceEndpoint,
      );
    });
  }

  public async collectBlock(blockNumber: number, sourceName?: string): Promise<CollectBlockResult> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new BlockchainValidationError("Block number must be a non-negative integer");
    }

    const connector = this.registry.resolve(sourceName);
    const network = await this.ensureNetwork();
    const dataSource = await this.ensureDataSource(network.id, connector);

    let rawBlock: import("./model.js").RawBlock;
    try {
      rawBlock = await connector.getBlock(blockNumber);
    } catch (error) {
      await this.database.transaction(async (tx) => {
        await this.repository.insertFailedRun(
          tx, randomUUID(), network.id, connector.sourceName, blockNumber,
          error instanceof Error ? error.message : String(error),
        );
      });
      throw error;
    }

    return this.database.transaction(async (tx) => {
      const exists = await this.repository.blockExistsForSource(tx, network.id, blockNumber, dataSource.id);
      if (exists) {
        throw new BlockchainConflictError(
          `Block ${blockNumber} already collected from ${connector.sourceName}`,
        );
      }

      const runId = randomUUID();
      await this.repository.insertCollectionRun(tx, runId, network.id, connector.sourceName, blockNumber);

      const blockId = randomUUID();
      const blockRawJson = JSON.stringify(rawBlock.raw);
      assertRawDataSize(blockRawJson, `Block ${blockNumber}`);

      const block = await this.repository.insertBlock(tx, {
        id: blockId,
        networkId: network.id,
        dataSourceId: dataSource.id,
        blockNumber: rawBlock.blockNumber,
        blockHash: rawBlock.blockHash,
        parentHash: rawBlock.parentHash,
        blockTimestamp: new Date(rawBlock.timestamp),
        blockProducer: rawBlock.blockProducer,
        txCount: rawBlock.txCount,
        sizeBytes: rawBlock.sizeBytes,
        rawData: blockRawJson,
        collectionSource: connector.sourceName,
      });

      const transactions = await this.insertTransactions(
        tx, network.id, dataSource.id, blockId, rawBlock.transactions,
      );

      const collectionRun = await this.repository.completeCollectionRun(tx, runId, transactions.length);

      const eventCommand: AppendEventCommand = {
        eventId: randomUUID(),
        eventType: "blockchain_block_collected",
        eventVersion: 1,
        aggregateType: "blockchain_collection",
        aggregateId: runId,
        expectedSequence: 0,
        actor: { type: "system" },
        correlationId: runId,
        payload: {
          networkId: network.id,
          networkName: network.name,
          dataSourceId: dataSource.id,
          dataSourceName: dataSource.name,
          blockNumber: rawBlock.blockNumber,
          txCount: transactions.length,
        },
      };
      await this.events.appendMany(tx, [eventCommand]);

      return Object.freeze({
        block,
        transactions: Object.freeze(transactions),
        collectionRun,
      });
    });
  }

  public async getBlock(
    networkId: string,
    blockNumber: number,
    dataSourceId?: string,
  ): Promise<BlockchainBlock | null> {
    return this.database.transaction((tx) =>
      this.repository.findBlock(tx, networkId, blockNumber, dataSourceId),
    );
  }

  public async getBlockObservations(
    networkId: string,
    blockNumber: number,
  ): Promise<readonly BlockchainBlock[]> {
    return this.database.transaction((tx) =>
      this.repository.findBlockObservations(tx, networkId, blockNumber),
    );
  }

  public async getTransactionsByBlock(blockId: string): Promise<readonly BlockchainTransaction[]> {
    return this.database.transaction((tx) =>
      this.repository.findTransactionsByBlock(tx, blockId),
    );
  }

  public async getTransactionObservations(
    networkId: string,
    txHash: string,
  ): Promise<readonly BlockchainTransaction[]> {
    return this.database.transaction((tx) =>
      this.repository.findTransactionObservations(tx, networkId, txHash),
    );
  }

  public async getLatestBlockNumber(): Promise<number> {
    return this.registry.primary().getLatestBlockNumber();
  }

  public async getCollectionRun(runId: string): Promise<DataCollectionRun | null> {
    return this.database.transaction((tx) =>
      this.repository.findCollectionRun(tx, runId),
    );
  }

  public async getDataSourcesForNetwork(
    networkId: string,
  ): Promise<readonly BlockchainDataSource[]> {
    return this.database.transaction((tx) =>
      this.repository.findDataSourcesByNetwork(tx, networkId),
    );
  }

  public async validateBlock(
    networkId: string,
    blockNumber: number,
  ): Promise<BlockValidationResult> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new BlockchainValidationError("Block number must be a non-negative integer");
    }

    return this.database.transaction(async (tx) => {
      const observations = await this.repository.findBlockObservations(tx, networkId, blockNumber);

      const transactionsByBlock = new Map<string, readonly BlockchainTransaction[]>();
      for (const block of observations) {
        const txs = await this.repository.findTransactionsByBlock(tx, block.id);
        transactionsByBlock.set(block.id, txs);
      }

      return crossValidateBlock(blockNumber, networkId, observations, transactionsByBlock);
    });
  }

  public async collectRange(
    startBlock: number,
    endBlock: number,
    sourceName?: string,
  ): Promise<RangeCollectionResult> {
    if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
      throw new BlockchainValidationError("startBlock must be a non-negative integer");
    }
    if (!Number.isSafeInteger(endBlock) || endBlock < 0) {
      throw new BlockchainValidationError("endBlock must be a non-negative integer");
    }
    if (endBlock < startBlock) {
      throw new BlockchainValidationError("endBlock must be >= startBlock");
    }
    const rangeSize = endBlock - startBlock + 1;
    if (rangeSize > MAX_RANGE_SIZE) {
      throw new BlockchainValidationError(
        `Range size ${rangeSize} exceeds maximum of ${MAX_RANGE_SIZE}`,
      );
    }

    const connector = this.registry.resolve(sourceName);
    const network = await this.ensureNetwork();
    const dataSource = await this.ensureDataSource(network.id, connector);

    const runId = randomUUID();
    await this.database.transaction(async (tx) => {
      await this.repository.insertRangeCollectionRun(
        tx, runId, network.id, connector.sourceName, startBlock, endBlock,
      );
    });

    let blocksCollected = 0;
    let skipped = 0;
    let totalTransactions = 0;

    for (let blockNumber = startBlock; blockNumber <= endBlock; blockNumber++) {
      let rawBlock: import("./model.js").RawBlock;
      try {
        rawBlock = await connector.getBlock(blockNumber);
      } catch (error) {
        const run = await this.database.transaction(async (tx) =>
          this.repository.failCollectionRun(
            tx, runId, blocksCollected, totalTransactions,
            `Failed at block ${blockNumber}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return Object.freeze({ run, collected: blocksCollected, skipped, totalTransactions });
      }

      const txCount = await this.database.transaction(async (tx) => {
        const exists = await this.repository.blockExistsForSource(
          tx, network.id, blockNumber, dataSource.id,
        );
        if (exists) return null;

        const blockId = randomUUID();
        const blockRawJson = JSON.stringify(rawBlock.raw);
        assertRawDataSize(blockRawJson, `Block ${blockNumber}`);

        await this.repository.insertBlock(tx, {
          id: blockId,
          networkId: network.id,
          dataSourceId: dataSource.id,
          blockNumber: rawBlock.blockNumber,
          blockHash: rawBlock.blockHash,
          parentHash: rawBlock.parentHash,
          blockTimestamp: new Date(rawBlock.timestamp),
          blockProducer: rawBlock.blockProducer,
          txCount: rawBlock.txCount,
          sizeBytes: rawBlock.sizeBytes,
          rawData: blockRawJson,
          collectionSource: connector.sourceName,
        });

        const transactions = await this.insertTransactions(
          tx, network.id, dataSource.id, blockId, rawBlock.transactions,
        );

        const eventCommand: AppendEventCommand = {
          eventId: randomUUID(),
          eventType: "blockchain_block_collected",
          eventVersion: 1,
          aggregateType: "blockchain_collection",
          aggregateId: runId,
          expectedSequence: blocksCollected,
          actor: { type: "system" },
          correlationId: runId,
          payload: {
            networkId: network.id,
            networkName: network.name,
            dataSourceId: dataSource.id,
            dataSourceName: dataSource.name,
            blockNumber: rawBlock.blockNumber,
            txCount: transactions.length,
          },
        };
        await this.events.appendMany(tx, [eventCommand]);

        await this.repository.updateRunProgress(
          tx, runId, blocksCollected + 1, totalTransactions + transactions.length,
        );

        return transactions.length;
      });

      if (txCount === null) {
        skipped++;
      } else {
        blocksCollected++;
        totalTransactions += txCount;
      }
    }

    const run = await this.database.transaction(async (tx) =>
      this.repository.completeRangeCollectionRun(tx, runId, blocksCollected, totalTransactions),
    );

    return Object.freeze({ run, collected: blocksCollected, skipped, totalTransactions });
  }

  private async insertTransactions(
    tx: DatabaseExecutor,
    networkId: string,
    dataSourceId: string,
    blockId: string,
    rawTransactions: readonly RawTransaction[],
  ): Promise<BlockchainTransaction[]> {
    if (rawTransactions.length > MAX_TRANSACTIONS_PER_BLOCK) {
      throw new BlockchainValidationError(
        `Block contains ${rawTransactions.length} transactions, exceeding limit of ${MAX_TRANSACTIONS_PER_BLOCK}`,
      );
    }
    const results: BlockchainTransaction[] = [];
    for (const rawTx of rawTransactions) {
      if (!rawTx.txHash) continue;
      const txRawJson = JSON.stringify(rawTx.raw);
      assertRawDataSize(txRawJson, `Transaction ${rawTx.txHash}`);

      const transaction = await this.repository.insertTransaction(tx, {
        id: randomUUID(),
        networkId,
        dataSourceId,
        blockId,
        txHash: rawTx.txHash,
        txType: rawTx.txType,
        fromAddress: rawTx.fromAddress,
        toAddress: rawTx.toAddress,
        amount: rawTx.amount,
        fee: rawTx.fee,
        amountUnit: rawTx.amountUnit,
        feeUnit: rawTx.feeUnit,
        result: rawTx.result,
        chainData: JSON.stringify(rawTx.chainData),
        rawData: txRawJson,
      });
      results.push(transaction);
    }
    return results;
  }
}
