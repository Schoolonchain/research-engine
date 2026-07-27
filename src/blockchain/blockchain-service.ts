import { randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import type { BlockchainConnector } from "./connector.js";
import type {
  BlockchainBlock,
  BlockchainDataSource,
  BlockchainNetwork,
  BlockchainTransaction,
  DataCollectionRun,
} from "./model.js";
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

const NETWORK_COLS = "id, name, chain_id, network_type, status";
const DATA_SOURCE_COLS = "id, network_id, source_type, name, endpoint, status, priority";
const BLOCK_COLS = "id, network_id, data_source_id, block_number, block_hash, parent_hash, block_timestamp, block_producer, tx_count, size_bytes, collection_source, collected_at";
const TX_COLS = "id, network_id, data_source_id, block_id, tx_hash, tx_type, from_address, to_address, amount, fee, amount_unit, fee_unit, result, chain_data, collected_at";
const RUN_COLS = "id, network_id, run_type, status, source_api, block_start, block_end, blocks_collected, txs_collected, error_detail, started_at, completed_at";

interface NetworkRow {
  readonly id: string;
  readonly name: string;
  readonly chain_id: string;
  readonly network_type: string;
  readonly status: string;
}

interface DataSourceRow {
  readonly id: string;
  readonly network_id: string;
  readonly source_type: string;
  readonly name: string;
  readonly endpoint: string;
  readonly status: string;
  readonly priority: number;
}

interface BlockRow {
  readonly id: string;
  readonly network_id: string;
  readonly data_source_id: string;
  readonly block_number: string;
  readonly block_hash: string;
  readonly parent_hash: string;
  readonly block_timestamp: Date;
  readonly block_producer: string | null;
  readonly tx_count: number;
  readonly size_bytes: string | null;
  readonly collection_source: string;
  readonly collected_at: Date;
}

interface TransactionRow {
  readonly id: string;
  readonly network_id: string;
  readonly data_source_id: string;
  readonly block_id: string;
  readonly tx_hash: string;
  readonly tx_type: string;
  readonly from_address: string | null;
  readonly to_address: string | null;
  readonly amount: string | null;
  readonly fee: string | null;
  readonly amount_unit: string | null;
  readonly fee_unit: string | null;
  readonly result: string | null;
  readonly chain_data: Record<string, unknown>;
  readonly collected_at: Date;
}

interface CollectionRunRow {
  readonly id: string;
  readonly network_id: string;
  readonly run_type: string;
  readonly status: string;
  readonly source_api: string;
  readonly block_start: string | null;
  readonly block_end: string | null;
  readonly blocks_collected: number;
  readonly txs_collected: number;
  readonly error_detail: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

function toNetwork(row: NetworkRow): BlockchainNetwork {
  return Object.freeze({
    id: row.id,
    name: row.name,
    chainId: row.chain_id,
    networkType: row.network_type as BlockchainNetwork["networkType"],
    status: row.status as BlockchainNetwork["status"],
  });
}

function toDataSource(row: DataSourceRow): BlockchainDataSource {
  return Object.freeze({
    id: row.id,
    networkId: row.network_id,
    sourceType: row.source_type as BlockchainDataSource["sourceType"],
    name: row.name,
    endpoint: row.endpoint,
    status: row.status as BlockchainDataSource["status"],
    priority: row.priority,
  });
}

function toBlock(row: BlockRow): BlockchainBlock {
  return Object.freeze({
    id: row.id,
    networkId: row.network_id,
    dataSourceId: row.data_source_id,
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    parentHash: row.parent_hash,
    blockTimestamp: row.block_timestamp,
    blockProducer: row.block_producer,
    txCount: row.tx_count,
    sizeBytes: row.size_bytes !== null ? Number(row.size_bytes) : null,
    collectionSource: row.collection_source,
    collectedAt: row.collected_at,
  });
}

function toTransaction(row: TransactionRow): BlockchainTransaction {
  return Object.freeze({
    id: row.id,
    networkId: row.network_id,
    dataSourceId: row.data_source_id,
    blockId: row.block_id,
    txHash: row.tx_hash,
    txType: row.tx_type,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amount: row.amount,
    fee: row.fee,
    amountUnit: row.amount_unit,
    feeUnit: row.fee_unit,
    result: row.result,
    chainData: Object.freeze(row.chain_data),
    collectedAt: row.collected_at,
  });
}

function toCollectionRun(row: CollectionRunRow): DataCollectionRun {
  return Object.freeze({
    id: row.id,
    networkId: row.network_id,
    runType: row.run_type as DataCollectionRun["runType"],
    status: row.status as DataCollectionRun["status"],
    sourceApi: row.source_api,
    blockStart: row.block_start !== null ? Number(row.block_start) : null,
    blockEnd: row.block_end !== null ? Number(row.block_end) : null,
    blocksCollected: row.blocks_collected,
    txsCollected: row.txs_collected,
    errorDetail: row.error_detail,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

export interface CollectBlockResult {
  readonly block: BlockchainBlock;
  readonly transactions: readonly BlockchainTransaction[];
  readonly collectionRun: DataCollectionRun;
}

export class BlockchainService {
  private readonly events: EventStore;

  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly connector: BlockchainConnector,
  ) {
    this.events = new EventStore(database);
  }

  public async ensureNetwork(): Promise<BlockchainNetwork> {
    return this.database.transaction(async (tx) => {
      const existing = await tx.query<NetworkRow>(
        `SELECT ${NETWORK_COLS} FROM blockchain_networks WHERE chain_id = $1`,
        [this.connector.chainId],
      );
      if (existing.rows[0]) return toNetwork(existing.rows[0]);

      const inserted = await tx.query<NetworkRow>(
        `INSERT INTO blockchain_networks (name, chain_id, network_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (chain_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING ${NETWORK_COLS}`,
        [this.connector.networkName, this.connector.chainId, "MAINNET"],
      );
      return toNetwork(inserted.rows[0]!);
    });
  }

  public async ensureDataSource(networkId: string): Promise<BlockchainDataSource> {
    return this.database.transaction(async (tx) => {
      const existing = await tx.query<DataSourceRow>(
        `SELECT ${DATA_SOURCE_COLS} FROM blockchain_data_sources WHERE network_id = $1 AND name = $2`,
        [networkId, this.connector.sourceName],
      );
      if (existing.rows[0]) return toDataSource(existing.rows[0]);

      const inserted = await tx.query<DataSourceRow>(
        `INSERT INTO blockchain_data_sources (
          network_id, source_type, name, endpoint
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (network_id, name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING ${DATA_SOURCE_COLS}`,
        [
          networkId,
          this.connector.sourceType,
          this.connector.sourceName,
          this.connector.sourceEndpoint,
        ],
      );
      return toDataSource(inserted.rows[0]!);
    });
  }

  public async collectBlock(blockNumber: number): Promise<CollectBlockResult> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new BlockchainValidationError("Block number must be a non-negative integer");
    }

    const network = await this.ensureNetwork();
    const dataSource = await this.ensureDataSource(network.id);

    let rawBlock: import("./model.js").RawBlock;
    try {
      rawBlock = await this.connector.getBlock(blockNumber);
    } catch (error) {
      const failedRunId = randomUUID();
      await this.database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO data_collection_runs (
            id, network_id, run_type, status, source_api, block_start, block_end,
            error_detail, completed_at
          ) VALUES ($1, $2, 'BLOCK', 'FAILED', $3, $4, $4, $5, CURRENT_TIMESTAMP)`,
          [
            failedRunId, network.id, this.connector.sourceName, blockNumber,
            error instanceof Error ? error.message : String(error),
          ],
        );
      });
      throw error;
    }

    return this.database.transaction(async (tx) => {
      const duplicate = await tx.query<{ id: string }>(
        `SELECT id FROM blockchain_blocks
         WHERE network_id = $1 AND block_number = $2 AND data_source_id = $3`,
        [network.id, blockNumber, dataSource.id],
      );
      if (duplicate.rows[0]) {
        throw new BlockchainConflictError(
          `Block ${blockNumber} already collected from ${this.connector.sourceName}`,
        );
      }

      const runId = randomUUID();
      await tx.query<CollectionRunRow>(
        `INSERT INTO data_collection_runs (
          id, network_id, run_type, status, source_api, block_start, block_end
        ) VALUES ($1, $2, 'BLOCK', 'RUNNING', $3, $4, $4)
        RETURNING ${RUN_COLS}`,
        [runId, network.id, this.connector.sourceName, blockNumber],
      );

      const blockId = randomUUID();
      const blockRawJson = JSON.stringify(rawBlock.raw);
      assertRawDataSize(blockRawJson, `Block ${blockNumber}`);

      const blockResult = await tx.query<BlockRow>(
        `INSERT INTO blockchain_blocks (
          id, network_id, data_source_id, block_number, block_hash, parent_hash,
          block_timestamp, block_producer, tx_count, size_bytes,
          raw_data, collection_source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
        RETURNING ${BLOCK_COLS}`,
        [
          blockId, network.id, dataSource.id, rawBlock.blockNumber,
          rawBlock.blockHash, rawBlock.parentHash, new Date(rawBlock.timestamp),
          rawBlock.blockProducer, rawBlock.txCount, rawBlock.sizeBytes,
          blockRawJson, this.connector.sourceName,
        ],
      );

      const transactions = await this.insertTransactions(
        tx, network.id, dataSource.id, blockId, rawBlock.transactions,
      );

      const completedRun = await tx.query<CollectionRunRow>(
        `UPDATE data_collection_runs
         SET status = 'COMPLETED', blocks_collected = 1,
             txs_collected = $1, completed_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING ${RUN_COLS}`,
        [transactions.length, runId],
      );

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
        block: toBlock(blockResult.rows[0]!),
        transactions: Object.freeze(transactions),
        collectionRun: toCollectionRun(completedRun.rows[0]!),
      });
    });
  }

  public async getBlock(
    networkId: string,
    blockNumber: number,
    dataSourceId?: string,
  ): Promise<BlockchainBlock | null> {
    const result = await this.database.transaction(async (tx) => {
      if (dataSourceId) {
        return tx.query<BlockRow>(
          `SELECT ${BLOCK_COLS} FROM blockchain_blocks
           WHERE network_id = $1 AND block_number = $2 AND data_source_id = $3`,
          [networkId, blockNumber, dataSourceId],
        );
      }
      return tx.query<BlockRow>(
        `SELECT ${BLOCK_COLS} FROM blockchain_blocks
         WHERE network_id = $1 AND block_number = $2
         ORDER BY collected_at ASC LIMIT 1`,
        [networkId, blockNumber],
      );
    });
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  public async getBlockObservations(
    networkId: string,
    blockNumber: number,
  ): Promise<readonly BlockchainBlock[]> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<BlockRow>(
        `SELECT ${BLOCK_COLS} FROM blockchain_blocks
         WHERE network_id = $1 AND block_number = $2
         ORDER BY collected_at ASC`,
        [networkId, blockNumber],
      );
    });
    return Object.freeze(result.rows.map(toBlock));
  }

  public async getTransactionsByBlock(blockId: string): Promise<readonly BlockchainTransaction[]> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<TransactionRow>(
        `SELECT ${TX_COLS} FROM blockchain_transactions WHERE block_id = $1 ORDER BY tx_hash`,
        [blockId],
      );
    });
    return Object.freeze(result.rows.map(toTransaction));
  }

  public async getTransactionObservations(
    networkId: string,
    txHash: string,
  ): Promise<readonly BlockchainTransaction[]> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<TransactionRow>(
        `SELECT ${TX_COLS} FROM blockchain_transactions
         WHERE network_id = $1 AND tx_hash = $2
         ORDER BY collected_at ASC`,
        [networkId, txHash],
      );
    });
    return Object.freeze(result.rows.map(toTransaction));
  }

  public async getLatestBlockNumber(): Promise<number> {
    return this.connector.getLatestBlockNumber();
  }

  public async getCollectionRun(runId: string): Promise<DataCollectionRun | null> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<CollectionRunRow>(
        `SELECT ${RUN_COLS} FROM data_collection_runs WHERE id = $1`,
        [runId],
      );
    });
    return result.rows[0] ? toCollectionRun(result.rows[0]) : null;
  }

  public async getDataSourcesForNetwork(
    networkId: string,
  ): Promise<readonly BlockchainDataSource[]> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<DataSourceRow>(
        `SELECT ${DATA_SOURCE_COLS} FROM blockchain_data_sources
         WHERE network_id = $1
         ORDER BY priority DESC, created_at ASC`,
        [networkId],
      );
    });
    return Object.freeze(result.rows.map(toDataSource));
  }

  private async insertTransactions(
    tx: DatabaseExecutor,
    networkId: string,
    dataSourceId: string,
    blockId: string,
    rawTransactions: readonly import("./model.js").RawTransaction[],
  ): Promise<BlockchainTransaction[]> {
    if (rawTransactions.length > MAX_TRANSACTIONS_PER_BLOCK) {
      throw new BlockchainValidationError(
        `Block contains ${rawTransactions.length} transactions, exceeding limit of ${MAX_TRANSACTIONS_PER_BLOCK}`,
      );
    }
    const results: BlockchainTransaction[] = [];
    for (const rawTx of rawTransactions) {
      if (!rawTx.txHash) continue;
      const txId = randomUUID();
      const txRawJson = JSON.stringify(rawTx.raw);
      assertRawDataSize(txRawJson, `Transaction ${rawTx.txHash}`);

      const result = await tx.query<TransactionRow>(
        `INSERT INTO blockchain_transactions (
          id, network_id, data_source_id, block_id, tx_hash, tx_type,
          from_address, to_address, amount, fee,
          amount_unit, fee_unit, result, chain_data, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
        RETURNING ${TX_COLS}`,
        [
          txId, networkId, dataSourceId, blockId, rawTx.txHash, rawTx.txType,
          rawTx.fromAddress, rawTx.toAddress,
          rawTx.amount, rawTx.fee,
          rawTx.amountUnit, rawTx.feeUnit, rawTx.result,
          JSON.stringify(rawTx.chainData), txRawJson,
        ],
      );
      results.push(toTransaction(result.rows[0]!));
    }
    return results;
  }
}
