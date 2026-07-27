import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import type { BlockchainConnector } from "../src/blockchain/connector.js";
import type { RawBlock, RawTransaction } from "../src/blockchain/model.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";
import {
  BlockchainConflictError,
  BlockchainValidationError,
} from "../src/blockchain/errors.js";

class Executor implements DatabaseExecutor {
  public constructor(private readonly database: PGlite | Transaction) {}
  public async query<Row>(sql: string, values: readonly unknown[] = []): Promise<DatabaseResult<Row>> {
    const result = await this.database.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}
class Database implements TransactionalDatabase {
  public constructor(private readonly database: PGlite) {}
  public transaction<Result>(operation: (transaction: DatabaseExecutor) => Promise<Result>): Promise<Result> {
    return this.database.transaction((transaction) => operation(new Executor(transaction)));
  }
}

function makeTx(overrides?: Partial<RawTransaction>): RawTransaction {
  return {
    txHash: "abc123def456",
    txType: "TransferContract",
    fromAddress: "TFromAddr1234567890",
    toAddress: "TToAddr1234567890",
    amountSun: BigInt(1_000_000),
    result: "SUCCESS",
    feeSun: BigInt(100_000),
    energyUsed: null,
    bandwidthUsed: BigInt(267),
    raw: { test: true },
    ...overrides,
  };
}

function makeBlock(overrides?: Partial<RawBlock>): RawBlock {
  return {
    blockNumber: 50_000_000,
    blockHash: "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
    parentHash: "0000000002faf07f1234567890abcdef1234567890abcdef1234567890abcdef",
    timestamp: 1700000000000,
    witnessAddress: "TWitnessAddr1234567",
    txCount: 1,
    sizeBytes: 1024,
    transactions: [makeTx()],
    raw: { blockID: "test-block", test: true },
    ...overrides,
  };
}

class StubConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly sourceApi = "trongrid:stub";
  public latestBlockNumber = 50_000_100;
  public blocks = new Map<number, RawBlock>();

  public constructor() {
    this.blocks.set(50_000_000, makeBlock());
    this.blocks.set(50_000_001, makeBlock({
      blockNumber: 50_000_001,
      blockHash: "0000000002faf081aabbccdd",
      parentHash: "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
      timestamp: 1700000003000,
      txCount: 2,
      transactions: [
        makeTx({ txHash: "tx001", amountSun: BigInt(5_000_000) }),
        makeTx({ txHash: "tx002", txType: "TriggerSmartContract", amountSun: null }),
      ],
    }));
  }

  public async getLatestBlockNumber(): Promise<number> {
    return this.latestBlockNumber;
  }

  public async getBlock(blockNumber: number): Promise<RawBlock> {
    const block = this.blocks.get(blockNumber);
    if (!block) throw new Error(`Block ${blockNumber} not found in stub`);
    return block;
  }
}

describe("blockchain data collection", () => {
  let raw: PGlite;
  let database: Database;
  let connector: StubConnector;
  let service: BlockchainService;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
      await loadMigrations(),
    );
    database = new Database(raw);
    connector = new StubConnector();
    service = new BlockchainService(database, connector);
  });

  afterEach(async () => raw.close());

  it("creates the blockchain schema with all expected tables", async () => {
    const result = await raw.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'blockchain_%' OR table_name = 'data_collection_runs'
      ORDER BY table_name
    `);
    const names = result.rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining([
      "blockchain_blocks",
      "blockchain_networks",
      "blockchain_transactions",
      "data_collection_runs",
    ]));
  });

  it("ensures a network is created on first use", async () => {
    const network = await service.ensureNetwork();
    expect(network.name).toBe("TRON Mainnet");
    expect(network.chainId).toBe("tron-mainnet");
    expect(network.networkType).toBe("MAINNET");
    expect(network.status).toBe("ACTIVE");

    const second = await service.ensureNetwork();
    expect(second.id).toBe(network.id);
  });

  it("collects a block with transactions and records provenance", async () => {
    const result = await service.collectBlock(50_000_000);

    expect(result.block.blockNumber).toBe(50_000_000);
    expect(result.block.blockHash).toBe(
      "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
    );
    expect(result.block.witnessAddress).toBe("TWitnessAddr1234567");
    expect(result.block.txCount).toBe(1);
    expect(result.block.collectionSource).toBe("trongrid:stub");

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.txHash).toBe("abc123def456");
    expect(result.transactions[0]!.txType).toBe("TransferContract");
    expect(result.transactions[0]!.amountSun).toBe(BigInt(1_000_000));
    expect(result.transactions[0]!.result).toBe("SUCCESS");

    expect(result.collectionRun.status).toBe("COMPLETED");
    expect(result.collectionRun.blocksCollected).toBe(1);
    expect(result.collectionRun.txsCollected).toBe(1);
    expect(result.collectionRun.sourceApi).toBe("trongrid:stub");
  });

  it("collects a block with multiple transactions", async () => {
    const result = await service.collectBlock(50_000_001);

    expect(result.block.blockNumber).toBe(50_000_001);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]!.txHash).toBe("tx001");
    expect(result.transactions[0]!.amountSun).toBe(BigInt(5_000_000));
    expect(result.transactions[1]!.txHash).toBe("tx002");
    expect(result.transactions[1]!.txType).toBe("TriggerSmartContract");
    expect(result.transactions[1]!.amountSun).toBeNull();
    expect(result.collectionRun.txsCollected).toBe(2);
  });

  it("rejects duplicate block collection", async () => {
    await service.collectBlock(50_000_000);
    await expect(service.collectBlock(50_000_000)).rejects.toBeInstanceOf(
      BlockchainConflictError,
    );
  });

  it("rejects negative block numbers", async () => {
    await expect(service.collectBlock(-1)).rejects.toBeInstanceOf(
      BlockchainValidationError,
    );
  });

  it("rejects non-integer block numbers", async () => {
    await expect(service.collectBlock(1.5)).rejects.toBeInstanceOf(
      BlockchainValidationError,
    );
  });

  it("records an event in the domain event log", async () => {
    await service.collectBlock(50_000_000);

    const events = await raw.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT event_type, payload FROM domain_events WHERE event_type = 'blockchain_block_collected'",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.event_type).toBe("blockchain_block_collected");
    expect(events.rows[0]!.payload).toMatchObject({
      networkName: "TRON Mainnet",
      blockNumber: 50_000_000,
      txCount: 1,
    });
  });

  it("creates an outbox message for each collection event", async () => {
    await service.collectBlock(50_000_000);

    const outbox = await raw.query<{ topic: string; status: string }>(
      "SELECT topic, status FROM outbox_messages ORDER BY created_at DESC LIMIT 1",
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]!.status).toBe("PENDING");
  });

  it("retrieves a stored block by network and number", async () => {
    const collected = await service.collectBlock(50_000_000);
    const found = await service.getBlock(collected.block.networkId, 50_000_000);

    expect(found).not.toBeNull();
    expect(found!.blockNumber).toBe(50_000_000);
    expect(found!.blockHash).toBe(collected.block.blockHash);
  });

  it("returns null for a block not yet collected", async () => {
    const network = await service.ensureNetwork();
    const found = await service.getBlock(network.id, 99_999_999);
    expect(found).toBeNull();
  });

  it("retrieves transactions by block", async () => {
    const collected = await service.collectBlock(50_000_001);
    const txs = await service.getTransactionsByBlock(collected.block.id);

    expect(txs).toHaveLength(2);
    expect(txs.map((tx) => tx.txHash).sort()).toEqual(["tx001", "tx002"]);
  });

  it("delegates latest block number to the connector", async () => {
    const latest = await service.getLatestBlockNumber();
    expect(latest).toBe(50_000_100);
  });

  it("retrieves a completed collection run", async () => {
    const collected = await service.collectBlock(50_000_000);
    const run = await service.getCollectionRun(collected.collectionRun.id);

    expect(run).not.toBeNull();
    expect(run!.status).toBe("COMPLETED");
    expect(run!.blocksCollected).toBe(1);
    expect(run!.completedAt).not.toBeNull();
  });

  it("preserves raw data as JSONB in blocks", async () => {
    await service.collectBlock(50_000_000);

    const block = await raw.query<{ raw_data: Record<string, unknown> }>(
      "SELECT raw_data FROM blockchain_blocks WHERE block_number = 50000000",
    );
    expect(block.rows[0]!.raw_data).toHaveProperty("blockID");
  });

  it("preserves raw data as JSONB in transactions", async () => {
    await service.collectBlock(50_000_000);

    const tx = await raw.query<{ raw_data: Record<string, unknown> }>(
      "SELECT raw_data FROM blockchain_transactions WHERE tx_hash = 'abc123def456'",
    );
    expect(tx.rows[0]!.raw_data).toHaveProperty("test", true);
  });

  it("does not create authorization or research jobs from block collection", async () => {
    await service.collectBlock(50_000_000);
    await service.collectBlock(50_000_001);

    const auths = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM authorizations",
    );
    const jobs = await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM research_jobs",
    );
    expect(auths.rows[0]!.count).toBe(0);
    expect(jobs.rows[0]!.count).toBe(0);
  });

  it("enforces unique block per network constraint", async () => {
    await service.collectBlock(50_000_000);

    await expect(
      raw.query(
        `INSERT INTO blockchain_blocks (
          network_id, block_number, block_hash, parent_hash,
          block_timestamp, tx_count, raw_data, collection_source
        ) SELECT id, 50000000, 'duplicate', 'parent', CURRENT_TIMESTAMP, 0, '{}', 'test'
        FROM blockchain_networks LIMIT 1`,
      ),
    ).rejects.toThrow();
  });

  it("enforces unique transaction hash per network constraint", async () => {
    await service.collectBlock(50_000_000);

    const blockRow = await raw.query<{ id: string; network_id: string }>(
      "SELECT id, network_id FROM blockchain_blocks LIMIT 1",
    );
    const block = blockRow.rows[0]!;

    await expect(
      raw.query(
        `INSERT INTO blockchain_transactions (
          network_id, block_id, tx_hash, tx_type, raw_data
        ) VALUES ($1, $2, 'abc123def456', 'Transfer', '{}')`,
        [block.network_id, block.id],
      ),
    ).rejects.toThrow();
  });
});
