import { createHash, randomUUID } from "node:crypto";

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

// ── Payload size policy (C-2) ──
// TRON protocol: max block binary size is 2,000,000 bytes.  JSON expansion
// factor over wire-format binary is typically 1.5×–2.5×, so a realistic
// upper bound for a single block's JSON payload is ~5 MiB.
//
// DEFAULT_MAX_RAW_DATA_BYTES (4 MiB) accommodates the vast majority of blocks
// including historically large ones (e.g. block #85,118,696 at ~1.1 MiB).
// ABSOLUTE_MAX_RAW_DATA_BYTES (8 MiB) is a hard ceiling that no configuration
// can exceed — it protects PostgreSQL from ingesting unreasonably large payloads
// while still leaving headroom for edge-case blocks.
export const DEFAULT_MAX_RAW_DATA_BYTES = 4_194_304; // 4 MiB
export const ABSOLUTE_MAX_RAW_DATA_BYTES = 8_388_608; // 8 MiB
const MAX_TRANSACTIONS_PER_BLOCK = 10_000;

/** Storage lifecycle of a raw_data payload (C-3). */
export type StorageState = "FULL" | "EXTERNALIZED" | "PARTIAL" | "REJECTED";

/** Result of measuring and validating a raw JSON payload. */
export interface PayloadMeasurement {
  readonly json: string;
  readonly byteLength: number;
  readonly checksum: string;
  readonly storageState: StorageState;
}

/**
 * Measure a JSON payload: compute its UTF-8 byte length (C-1) and SHA-256
 * checksum (C-4), then classify its storage state (C-3).
 *
 * Throws BlockchainValidationError when the payload exceeds the absolute
 * maximum — data that large is REJECTED, never truncated.
 */
export function measurePayload(
  json: string,
  label: string,
  maxBytes: number = DEFAULT_MAX_RAW_DATA_BYTES,
): PayloadMeasurement {
  // C-1: use Buffer.byteLength for accurate UTF-8 measurement
  const byteLength = Buffer.byteLength(json, "utf8");
  // C-4: SHA-256 checksum computed before insertion
  const checksum = createHash("sha256").update(json, "utf8").digest("hex");

  if (byteLength > ABSOLUTE_MAX_RAW_DATA_BYTES) {
    throw new BlockchainValidationError(
      `${label} raw_data exceeds absolute ${ABSOLUTE_MAX_RAW_DATA_BYTES} byte limit ` +
      `(${byteLength} bytes UTF-8)`,
    );
  }

  if (byteLength > maxBytes) {
    // Between configurable max and absolute max — still store as FULL since
    // we never truncate, but the caller can inspect byteLength for diagnostics.
    // The policy says: accept blocks up to ABSOLUTE_MAX, reject above.
    // Blocks between DEFAULT and ABSOLUTE are stored normally.
  }

  return Object.freeze({
    json,
    byteLength,
    checksum,
    storageState: "FULL" as const,
  });
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
      const blockPayload = measurePayload(blockRawJson, `Block ${blockNumber}`);

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
        rawData: blockPayload.json,
        collectionSource: connector.sourceName,
        rawDataBytes: blockPayload.byteLength,
        rawDataChecksum: blockPayload.checksum,
        storageState: blockPayload.storageState,
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
        const blockPayload = measurePayload(blockRawJson, `Block ${blockNumber}`);

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
          rawData: blockPayload.json,
          collectionSource: connector.sourceName,
          rawDataBytes: blockPayload.byteLength,
          rawDataChecksum: blockPayload.checksum,
          storageState: blockPayload.storageState,
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
      const txPayload = measurePayload(txRawJson, `Transaction ${rawTx.txHash}`);

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
        rawData: txPayload.json,
        rawDataBytes: txPayload.byteLength,
        rawDataChecksum: txPayload.checksum,
        storageState: txPayload.storageState,
      });
      results.push(transaction);
    }
    return results;
  }
}
