import { randomUUID } from "node:crypto";

import type { DatabaseExecutor, TransactionalDatabase } from "../db/database.js";
import { EventStore, type AppendEventCommand } from "../events/event-store.js";
import type { BlockchainConnector } from "./connector.js";
import type {
  BlockchainBlock,
  BlockchainNetwork,
  BlockchainTransaction,
  DataCollectionRun,
  RawBlock,
  RawTransaction,
} from "./model.js";
import {
  BlockchainConflictError,
  BlockchainNotFoundError,
  BlockchainValidationError,
} from "./errors.js";

interface NetworkRow {
  readonly id: string;
  readonly name: string;
  readonly chain_id: string;
  readonly network_type: string;
  readonly rpc_endpoint: string;
  readonly status: string;
}

interface BlockRow {
  readonly id: string;
  readonly network_id: string;
  readonly block_number: string;
  readonly block_hash: string;
  readonly parent_hash: string;
  readonly block_timestamp: Date;
  readonly witness_address: string | null;
  readonly tx_count: number;
  readonly size_bytes: string | null;
  readonly collection_source: string;
  readonly collected_at: Date;
}

interface TransactionRow {
  readonly id: string;
  readonly network_id: string;
  readonly block_id: string;
  readonly tx_hash: string;
  readonly tx_type: string;
  readonly from_address: string | null;
  readonly to_address: string | null;
  readonly amount_sun: string | null;
  readonly result: string | null;
  readonly fee_sun: string | null;
  readonly energy_used: string | null;
  readonly bandwidth_used: string | null;
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

function toBlock(row: BlockRow): BlockchainBlock {
  return Object.freeze({
    id: row.id,
    networkId: row.network_id,
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    parentHash: row.parent_hash,
    blockTimestamp: row.block_timestamp,
    witnessAddress: row.witness_address,
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
    blockId: row.block_id,
    txHash: row.tx_hash,
    txType: row.tx_type,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amountSun: row.amount_sun !== null ? BigInt(row.amount_sun) : null,
    result: row.result,
    feeSun: row.fee_sun !== null ? BigInt(row.fee_sun) : null,
    energyUsed: row.energy_used !== null ? BigInt(row.energy_used) : null,
    bandwidthUsed: row.bandwidth_used !== null ? BigInt(row.bandwidth_used) : null,
    collectedAt: row.collected_at,
  });
}

function toNetwork(row: NetworkRow): BlockchainNetwork {
  return Object.freeze({
    id: row.id,
    name: row.name,
    chainId: row.chain_id,
    networkType: row.network_type as BlockchainNetwork["networkType"],
    rpcEndpoint: row.rpc_endpoint,
    status: row.status as BlockchainNetwork["status"],
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

function bigintToString(value: bigint | null): string | null {
  return value !== null ? value.toString() : null;
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
        "SELECT * FROM blockchain_networks WHERE name = $1",
        [this.connector.networkName],
      );
      if (existing.rows[0]) return toNetwork(existing.rows[0]);

      const inserted = await tx.query<NetworkRow>(
        `INSERT INTO blockchain_networks (name, chain_id, network_type, rpc_endpoint)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          this.connector.networkName,
          "tron-mainnet",
          "MAINNET",
          this.connector.sourceApi,
        ],
      );
      return toNetwork(inserted.rows[0]!);
    });
  }

  public async collectBlock(blockNumber: number): Promise<CollectBlockResult> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new BlockchainValidationError("Block number must be a non-negative integer");
    }

    const network = await this.ensureNetwork();
    const rawBlock = await this.connector.getBlock(blockNumber);

    return this.database.transaction(async (tx) => {
      const duplicate = await tx.query<{ id: string }>(
        "SELECT id FROM blockchain_blocks WHERE network_id = $1 AND block_number = $2",
        [network.id, blockNumber],
      );
      if (duplicate.rows[0]) {
        throw new BlockchainConflictError(`Block ${blockNumber} already collected`);
      }

      const runId = randomUUID();
      const runResult = await tx.query<CollectionRunRow>(
        `INSERT INTO data_collection_runs (
          id, network_id, run_type, status, source_api, block_start, block_end
        ) VALUES ($1, $2, 'BLOCK', 'RUNNING', $3, $4, $4)
        RETURNING *`,
        [runId, network.id, this.connector.sourceApi, blockNumber],
      );

      const blockId = randomUUID();
      const blockResult = await tx.query<BlockRow>(
        `INSERT INTO blockchain_blocks (
          id, network_id, block_number, block_hash, parent_hash,
          block_timestamp, witness_address, tx_count, size_bytes,
          raw_data, collection_source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
        RETURNING *`,
        [
          blockId, network.id, rawBlock.blockNumber, rawBlock.blockHash,
          rawBlock.parentHash, new Date(rawBlock.timestamp),
          rawBlock.witnessAddress, rawBlock.txCount, rawBlock.sizeBytes,
          JSON.stringify(rawBlock.raw), this.connector.sourceApi,
        ],
      );

      const transactions = await this.insertTransactions(
        tx, network.id, blockId, rawBlock.transactions,
      );

      const completedRun = await tx.query<CollectionRunRow>(
        `UPDATE data_collection_runs
         SET status = 'COMPLETED', blocks_collected = 1,
             txs_collected = $1, completed_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
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
          blockNumber: rawBlock.blockNumber,
          txCount: transactions.length,
          sourceApi: this.connector.sourceApi,
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
  ): Promise<BlockchainBlock | null> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<BlockRow>(
        "SELECT * FROM blockchain_blocks WHERE network_id = $1 AND block_number = $2",
        [networkId, blockNumber],
      );
    });
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  public async getTransactionsByBlock(blockId: string): Promise<readonly BlockchainTransaction[]> {
    const result = await this.database.transaction(async (tx) => {
      return tx.query<TransactionRow>(
        "SELECT * FROM blockchain_transactions WHERE block_id = $1 ORDER BY tx_hash",
        [blockId],
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
        "SELECT * FROM data_collection_runs WHERE id = $1",
        [runId],
      );
    });
    return result.rows[0] ? toCollectionRun(result.rows[0]) : null;
  }

  private async insertTransactions(
    tx: DatabaseExecutor,
    networkId: string,
    blockId: string,
    rawTransactions: readonly RawTransaction[],
  ): Promise<BlockchainTransaction[]> {
    const results: BlockchainTransaction[] = [];
    for (const rawTx of rawTransactions) {
      if (!rawTx.txHash) continue;
      const txId = randomUUID();
      const result = await tx.query<TransactionRow>(
        `INSERT INTO blockchain_transactions (
          id, network_id, block_id, tx_hash, tx_type,
          from_address, to_address, amount_sun, result,
          fee_sun, energy_used, bandwidth_used, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        RETURNING *`,
        [
          txId, networkId, blockId, rawTx.txHash, rawTx.txType,
          rawTx.fromAddress, rawTx.toAddress,
          bigintToString(rawTx.amountSun), rawTx.result,
          bigintToString(rawTx.feeSun), bigintToString(rawTx.energyUsed),
          bigintToString(rawTx.bandwidthUsed), JSON.stringify(rawTx.raw),
        ],
      );
      results.push(toTransaction(result.rows[0]!));
    }
    return results;
  }
}
