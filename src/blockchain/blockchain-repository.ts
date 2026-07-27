import type { DatabaseExecutor } from "../db/database.js";
import type {
  BlockchainBlock,
  BlockchainDataSource,
  BlockchainNetwork,
  BlockchainTransaction,
  DataCollectionRun,
} from "./model.js";

export interface InsertBlockParams {
  readonly id: string;
  readonly networkId: string;
  readonly dataSourceId: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentHash: string;
  readonly blockTimestamp: Date;
  readonly blockProducer: string | null;
  readonly txCount: number;
  readonly sizeBytes: number | null;
  readonly rawData: string;
  readonly collectionSource: string;
}

export interface InsertTransactionParams {
  readonly id: string;
  readonly networkId: string;
  readonly dataSourceId: string;
  readonly blockId: string;
  readonly txHash: string;
  readonly txType: string;
  readonly fromAddress: string | null;
  readonly toAddress: string | null;
  readonly amount: string | null;
  readonly fee: string | null;
  readonly amountUnit: string;
  readonly feeUnit: string;
  readonly result: string | null;
  readonly chainData: string;
  readonly rawData: string;
}

export interface BlockchainRepository {
  findNetworkByChainId(tx: DatabaseExecutor, chainId: string): Promise<BlockchainNetwork | null>;
  upsertNetwork(tx: DatabaseExecutor, name: string, chainId: string, networkType: string): Promise<BlockchainNetwork>;

  findDataSourceByName(tx: DatabaseExecutor, networkId: string, name: string): Promise<BlockchainDataSource | null>;
  upsertDataSource(tx: DatabaseExecutor, networkId: string, sourceType: string, name: string, endpoint: string): Promise<BlockchainDataSource>;
  findDataSourcesByNetwork(tx: DatabaseExecutor, networkId: string): Promise<readonly BlockchainDataSource[]>;

  blockExistsForSource(tx: DatabaseExecutor, networkId: string, blockNumber: number, dataSourceId: string): Promise<boolean>;
  insertBlock(tx: DatabaseExecutor, params: InsertBlockParams): Promise<BlockchainBlock>;
  findBlock(tx: DatabaseExecutor, networkId: string, blockNumber: number, dataSourceId?: string): Promise<BlockchainBlock | null>;
  findBlockObservations(tx: DatabaseExecutor, networkId: string, blockNumber: number): Promise<readonly BlockchainBlock[]>;

  insertTransaction(tx: DatabaseExecutor, params: InsertTransactionParams): Promise<BlockchainTransaction>;
  findTransactionsByBlock(tx: DatabaseExecutor, blockId: string): Promise<readonly BlockchainTransaction[]>;
  findTransactionObservations(tx: DatabaseExecutor, networkId: string, txHash: string): Promise<readonly BlockchainTransaction[]>;

  insertCollectionRun(tx: DatabaseExecutor, id: string, networkId: string, sourceApi: string, blockNumber: number): Promise<void>;
  completeCollectionRun(tx: DatabaseExecutor, runId: string, txsCollected: number): Promise<DataCollectionRun>;
  insertFailedRun(tx: DatabaseExecutor, id: string, networkId: string, sourceApi: string, blockNumber: number, errorDetail: string): Promise<void>;
  findCollectionRun(tx: DatabaseExecutor, runId: string): Promise<DataCollectionRun | null>;
}

// --- Row interfaces ---

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

// --- Column constants ---

const NETWORK_COLS = "id, name, chain_id, network_type, status";
const DATA_SOURCE_COLS = "id, network_id, source_type, name, endpoint, status, priority";
const BLOCK_COLS = "id, network_id, data_source_id, block_number, block_hash, parent_hash, block_timestamp, block_producer, tx_count, size_bytes, collection_source, collected_at";
const TX_COLS = "id, network_id, data_source_id, block_id, tx_hash, tx_type, from_address, to_address, amount, fee, amount_unit, fee_unit, result, chain_data, collected_at";
const RUN_COLS = "id, network_id, run_type, status, source_api, block_start, block_end, blocks_collected, txs_collected, error_detail, started_at, completed_at";

// --- Row → domain mappers ---

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

// --- SQL implementation ---

export class SqlBlockchainRepository implements BlockchainRepository {
  public async findNetworkByChainId(tx: DatabaseExecutor, chainId: string): Promise<BlockchainNetwork | null> {
    const result = await tx.query<NetworkRow>(
      `SELECT ${NETWORK_COLS} FROM blockchain_networks WHERE chain_id = $1`,
      [chainId],
    );
    return result.rows[0] ? toNetwork(result.rows[0]) : null;
  }

  public async upsertNetwork(tx: DatabaseExecutor, name: string, chainId: string, networkType: string): Promise<BlockchainNetwork> {
    const result = await tx.query<NetworkRow>(
      `INSERT INTO blockchain_networks (name, chain_id, network_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING ${NETWORK_COLS}`,
      [name, chainId, networkType],
    );
    return toNetwork(result.rows[0]!);
  }

  public async findDataSourceByName(tx: DatabaseExecutor, networkId: string, name: string): Promise<BlockchainDataSource | null> {
    const result = await tx.query<DataSourceRow>(
      `SELECT ${DATA_SOURCE_COLS} FROM blockchain_data_sources WHERE network_id = $1 AND name = $2`,
      [networkId, name],
    );
    return result.rows[0] ? toDataSource(result.rows[0]) : null;
  }

  public async upsertDataSource(tx: DatabaseExecutor, networkId: string, sourceType: string, name: string, endpoint: string): Promise<BlockchainDataSource> {
    const result = await tx.query<DataSourceRow>(
      `INSERT INTO blockchain_data_sources (
        network_id, source_type, name, endpoint
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (network_id, name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      RETURNING ${DATA_SOURCE_COLS}`,
      [networkId, sourceType, name, endpoint],
    );
    return toDataSource(result.rows[0]!);
  }

  public async findDataSourcesByNetwork(tx: DatabaseExecutor, networkId: string): Promise<readonly BlockchainDataSource[]> {
    const result = await tx.query<DataSourceRow>(
      `SELECT ${DATA_SOURCE_COLS} FROM blockchain_data_sources
       WHERE network_id = $1
       ORDER BY priority DESC, created_at ASC`,
      [networkId],
    );
    return Object.freeze(result.rows.map(toDataSource));
  }

  public async blockExistsForSource(tx: DatabaseExecutor, networkId: string, blockNumber: number, dataSourceId: string): Promise<boolean> {
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM blockchain_blocks
       WHERE network_id = $1 AND block_number = $2 AND data_source_id = $3`,
      [networkId, blockNumber, dataSourceId],
    );
    return result.rows.length > 0;
  }

  public async insertBlock(tx: DatabaseExecutor, params: InsertBlockParams): Promise<BlockchainBlock> {
    const result = await tx.query<BlockRow>(
      `INSERT INTO blockchain_blocks (
        id, network_id, data_source_id, block_number, block_hash, parent_hash,
        block_timestamp, block_producer, tx_count, size_bytes,
        raw_data, collection_source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      RETURNING ${BLOCK_COLS}`,
      [
        params.id, params.networkId, params.dataSourceId, params.blockNumber,
        params.blockHash, params.parentHash, params.blockTimestamp,
        params.blockProducer, params.txCount, params.sizeBytes,
        params.rawData, params.collectionSource,
      ],
    );
    return toBlock(result.rows[0]!);
  }

  public async findBlock(tx: DatabaseExecutor, networkId: string, blockNumber: number, dataSourceId?: string): Promise<BlockchainBlock | null> {
    if (dataSourceId) {
      const result = await tx.query<BlockRow>(
        `SELECT ${BLOCK_COLS} FROM blockchain_blocks
         WHERE network_id = $1 AND block_number = $2 AND data_source_id = $3`,
        [networkId, blockNumber, dataSourceId],
      );
      return result.rows[0] ? toBlock(result.rows[0]) : null;
    }
    const result = await tx.query<BlockRow>(
      `SELECT ${BLOCK_COLS} FROM blockchain_blocks
       WHERE network_id = $1 AND block_number = $2
       ORDER BY collected_at ASC LIMIT 1`,
      [networkId, blockNumber],
    );
    return result.rows[0] ? toBlock(result.rows[0]) : null;
  }

  public async findBlockObservations(tx: DatabaseExecutor, networkId: string, blockNumber: number): Promise<readonly BlockchainBlock[]> {
    const result = await tx.query<BlockRow>(
      `SELECT ${BLOCK_COLS} FROM blockchain_blocks
       WHERE network_id = $1 AND block_number = $2
       ORDER BY collected_at ASC`,
      [networkId, blockNumber],
    );
    return Object.freeze(result.rows.map(toBlock));
  }

  public async insertTransaction(tx: DatabaseExecutor, params: InsertTransactionParams): Promise<BlockchainTransaction> {
    const result = await tx.query<TransactionRow>(
      `INSERT INTO blockchain_transactions (
        id, network_id, data_source_id, block_id, tx_hash, tx_type,
        from_address, to_address, amount, fee,
        amount_unit, fee_unit, result, chain_data, raw_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
      RETURNING ${TX_COLS}`,
      [
        params.id, params.networkId, params.dataSourceId, params.blockId,
        params.txHash, params.txType, params.fromAddress, params.toAddress,
        params.amount, params.fee, params.amountUnit, params.feeUnit,
        params.result, params.chainData, params.rawData,
      ],
    );
    return toTransaction(result.rows[0]!);
  }

  public async findTransactionsByBlock(tx: DatabaseExecutor, blockId: string): Promise<readonly BlockchainTransaction[]> {
    const result = await tx.query<TransactionRow>(
      `SELECT ${TX_COLS} FROM blockchain_transactions WHERE block_id = $1 ORDER BY tx_hash`,
      [blockId],
    );
    return Object.freeze(result.rows.map(toTransaction));
  }

  public async findTransactionObservations(tx: DatabaseExecutor, networkId: string, txHash: string): Promise<readonly BlockchainTransaction[]> {
    const result = await tx.query<TransactionRow>(
      `SELECT ${TX_COLS} FROM blockchain_transactions
       WHERE network_id = $1 AND tx_hash = $2
       ORDER BY collected_at ASC`,
      [networkId, txHash],
    );
    return Object.freeze(result.rows.map(toTransaction));
  }

  public async insertCollectionRun(tx: DatabaseExecutor, id: string, networkId: string, sourceApi: string, blockNumber: number): Promise<void> {
    await tx.query(
      `INSERT INTO data_collection_runs (
        id, network_id, run_type, status, source_api, block_start, block_end
      ) VALUES ($1, $2, 'BLOCK', 'RUNNING', $3, $4, $4)`,
      [id, networkId, sourceApi, blockNumber],
    );
  }

  public async completeCollectionRun(tx: DatabaseExecutor, runId: string, txsCollected: number): Promise<DataCollectionRun> {
    const result = await tx.query<CollectionRunRow>(
      `UPDATE data_collection_runs
       SET status = 'COMPLETED', blocks_collected = 1,
           txs_collected = $1, completed_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${RUN_COLS}`,
      [txsCollected, runId],
    );
    return toCollectionRun(result.rows[0]!);
  }

  public async insertFailedRun(tx: DatabaseExecutor, id: string, networkId: string, sourceApi: string, blockNumber: number, errorDetail: string): Promise<void> {
    await tx.query(
      `INSERT INTO data_collection_runs (
        id, network_id, run_type, status, source_api, block_start, block_end,
        error_detail, completed_at
      ) VALUES ($1, $2, 'BLOCK', 'FAILED', $3, $4, $4, $5, CURRENT_TIMESTAMP)`,
      [id, networkId, sourceApi, blockNumber, errorDetail],
    );
  }

  public async findCollectionRun(tx: DatabaseExecutor, runId: string): Promise<DataCollectionRun | null> {
    const result = await tx.query<CollectionRunRow>(
      `SELECT ${RUN_COLS} FROM data_collection_runs WHERE id = $1`,
      [runId],
    );
    return result.rows[0] ? toCollectionRun(result.rows[0]) : null;
  }
}
