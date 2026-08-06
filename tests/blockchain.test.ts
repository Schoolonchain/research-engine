import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import type { BlockchainConnector } from "../src/blockchain/connector.js";
import type { DataSourceType, RawBlock, RawTransaction } from "../src/blockchain/model.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";
import { SqlBlockchainRepository } from "../src/blockchain/blockchain-repository.js";
import { ConnectorRegistry } from "../src/blockchain/connector-registry.js";
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
    amount: "1000000",
    fee: "100000",
    amountUnit: "SUN",
    feeUnit: "SUN",
    result: "SUCCESS",
    chainData: { energyUsed: null, bandwidthUsed: 267 },
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
    blockProducer: "TWitnessAddr1234567",
    txCount: 1,
    sizeBytes: 1024,
    transactions: [makeTx()],
    raw: { blockID: "test-block", test: true },
    ...overrides,
  };
}

class StubConnector implements BlockchainConnector {
  public readonly networkName: string;
  public readonly chainId: string;
  public readonly sourceName: string;
  public readonly sourceType: DataSourceType;
  public readonly sourceEndpoint: string;
  public latestBlockNumber = 50_000_100;
  public blocks = new Map<number, RawBlock>();

  public constructor(overrides?: {
    networkName?: string;
    chainId?: string;
    sourceName?: string;
    sourceType?: DataSourceType;
    sourceEndpoint?: string;
  }) {
    this.networkName = overrides?.networkName ?? "TRON Mainnet";
    this.chainId = overrides?.chainId ?? "tron-mainnet";
    this.sourceName = overrides?.sourceName ?? "TronGrid:stub";
    this.sourceType = overrides?.sourceType ?? "API";
    this.sourceEndpoint = overrides?.sourceEndpoint ?? "https://api.trongrid.io";

    this.blocks.set(50_000_000, makeBlock());
    this.blocks.set(50_000_001, makeBlock({
      blockNumber: 50_000_001,
      blockHash: "0000000002faf081aabbccdd",
      parentHash: "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
      timestamp: 1700000003000,
      txCount: 2,
      transactions: [
        makeTx({ txHash: "tx001", amount: "5000000" }),
        makeTx({ txHash: "tx002", txType: "TriggerSmartContract", amount: null }),
      ],
    }));
    for (let i = 2; i <= 5; i++) {
      this.blocks.set(50_000_000 + i, makeBlock({
        blockNumber: 50_000_000 + i,
        blockHash: `hash-${50_000_000 + i}`,
        parentHash: `hash-${50_000_000 + i - 1}`,
        timestamp: 1700000000000 + i * 3000,
        transactions: [makeTx({ txHash: `range-tx-${i}` })],
      }));
    }
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
    service = new BlockchainService(database, new ConnectorRegistry([connector]), new SqlBlockchainRepository());
  });

  afterEach(async () => raw.close());

  it("creates the blockchain schema with all expected tables", async () => {
    const result = await raw.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name LIKE 'blockchain_%' OR table_name = 'data_collection_runs')
      ORDER BY table_name
    `);
    const names = result.rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining([
      "blockchain_blocks",
      "blockchain_data_sources",
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

  it("ensures a data source is created on first use", async () => {
    const network = await service.ensureNetwork();
    const dataSource = await service.ensureDataSource(network.id);
    expect(dataSource.name).toBe("TronGrid:stub");
    expect(dataSource.sourceType).toBe("API");
    expect(dataSource.endpoint).toBe("https://api.trongrid.io");
    expect(dataSource.status).toBe("ACTIVE");

    const second = await service.ensureDataSource(network.id);
    expect(second.id).toBe(dataSource.id);
  });

  it("collects a block with transactions and records provenance", async () => {
    const result = await service.collectBlock(50_000_000);

    expect(result.block.blockNumber).toBe(50_000_000);
    expect(result.block.blockHash).toBe(
      "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
    );
    expect(result.block.blockProducer).toBe("TWitnessAddr1234567");
    expect(result.block.txCount).toBe(1);
    expect(result.block.collectionSource).toBe("TronGrid:stub");
    expect(result.block.dataSourceId).toBeDefined();

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.txHash).toBe("abc123def456");
    expect(result.transactions[0]!.txType).toBe("TransferContract");
    expect(result.transactions[0]!.amount).toBe("1000000");
    expect(result.transactions[0]!.result).toBe("SUCCESS");
    expect(result.transactions[0]!.dataSourceId).toBe(result.block.dataSourceId);

    expect(result.collectionRun.status).toBe("COMPLETED");
    expect(result.collectionRun.blocksCollected).toBe(1);
    expect(result.collectionRun.txsCollected).toBe(1);
    expect(result.collectionRun.sourceApi).toBe("TronGrid:stub");
  });

  it("collects a block with multiple transactions", async () => {
    const result = await service.collectBlock(50_000_001);

    expect(result.block.blockNumber).toBe(50_000_001);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]!.txHash).toBe("tx001");
    expect(result.transactions[0]!.amount).toBe("5000000");
    expect(result.transactions[1]!.txHash).toBe("tx002");
    expect(result.transactions[1]!.txType).toBe("TriggerSmartContract");
    expect(result.transactions[1]!.amount).toBeNull();
    expect(result.collectionRun.txsCollected).toBe(2);
  });

  it("rejects duplicate block collection from the same source", async () => {
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
      dataSourceName: "TronGrid:stub",
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

  it("retrieves a stored block filtering by data source", async () => {
    const collected = await service.collectBlock(50_000_000);
    const found = await service.getBlock(
      collected.block.networkId, 50_000_000, collected.block.dataSourceId,
    );
    expect(found).not.toBeNull();
    expect(found!.dataSourceId).toBe(collected.block.dataSourceId);
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

  it("enforces unique block per network+source constraint", async () => {
    await service.collectBlock(50_000_000);

    const dsRow = await raw.query<{ id: string }>(
      "SELECT id FROM blockchain_data_sources LIMIT 1",
    );

    await expect(
      raw.query(
        `INSERT INTO blockchain_blocks (
          network_id, data_source_id, block_number, block_hash, parent_hash,
          block_timestamp, tx_count, raw_data, collection_source
        ) SELECT n.id, $1, 50000000, 'duplicate', 'parent', CURRENT_TIMESTAMP, 0, '{}', 'test'
        FROM blockchain_networks n LIMIT 1`,
        [dsRow.rows[0]!.id],
      ),
    ).rejects.toThrow();
  });

  it("enforces unique transaction hash per network+source constraint", async () => {
    await service.collectBlock(50_000_000);

    const blockRow = await raw.query<{ id: string; network_id: string; data_source_id: string }>(
      "SELECT id, network_id, data_source_id FROM blockchain_blocks LIMIT 1",
    );
    const block = blockRow.rows[0]!;

    await expect(
      raw.query(
        `INSERT INTO blockchain_transactions (
          network_id, data_source_id, block_id, tx_hash, tx_type, raw_data
        ) VALUES ($1, $2, $3, 'abc123def456', 'Transfer', '{}')`,
        [block.network_id, block.data_source_id, block.id],
      ),
    ).rejects.toThrow();
  });

  it("lists data sources for a network", async () => {
    const network = await service.ensureNetwork();
    await service.ensureDataSource(network.id);
    const sources = await service.getDataSourcesForNetwork(network.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.name).toBe("TronGrid:stub");
  });

  describe("range collection", () => {
    it("collects a range of blocks", async () => {
      const result = await service.collectRange(50_000_000, 50_000_002);

      expect(result.run.status).toBe("COMPLETED");
      expect(result.run.runType).toBe("RANGE");
      expect(result.collected).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.totalTransactions).toBeGreaterThan(0);
    });

    it("skips already-collected blocks in range", async () => {
      await service.collectBlock(50_000_000);
      const result = await service.collectRange(50_000_000, 50_000_002);

      expect(result.run.status).toBe("COMPLETED");
      expect(result.collected).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it("returns PARTIAL when a block fetch fails mid-range", async () => {
      connector.blocks.delete(50_000_004);
      const result = await service.collectRange(50_000_002, 50_000_005);

      expect(result.run.status).toBe("PARTIAL");
      expect(result.collected).toBe(2);
      expect(result.run.errorDetail).toContain("block 50000004");
    });

    it("returns FAILED when first block fails", async () => {
      connector.blocks.delete(50_000_000);
      const result = await service.collectRange(50_000_000, 50_000_001);

      expect(result.run.status).toBe("FAILED");
      expect(result.collected).toBe(0);
    });

    it("rejects invalid range parameters", async () => {
      await expect(service.collectRange(-1, 5)).rejects.toThrow(BlockchainValidationError);
      await expect(service.collectRange(10, 5)).rejects.toThrow(BlockchainValidationError);
    });

    it("rejects range exceeding maximum size", async () => {
      await expect(service.collectRange(0, 100)).rejects.toThrow(BlockchainValidationError);
    });

    it("emits one event per collected block in range", async () => {
      await service.collectRange(50_000_000, 50_000_002);

      const events = await raw.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events
         WHERE event_type = 'blockchain_block_collected'
         ORDER BY recorded_at`,
      );
      expect(events.rows).toHaveLength(3);
    });

    it("recovery: re-running same range skips completed blocks", async () => {
      connector.blocks.delete(50_000_003);
      const partial = await service.collectRange(50_000_002, 50_000_004);
      expect(partial.run.status).toBe("PARTIAL");
      expect(partial.collected).toBe(1);

      connector.blocks.set(50_000_003, makeBlock({
        blockNumber: 50_000_003,
        blockHash: "hash-50000003",
        parentHash: "hash-50000002",
        timestamp: 1700000009000,
        transactions: [makeTx({ txHash: "range-tx-3-retry" })],
      }));
      const retry = await service.collectRange(50_000_002, 50_000_004);
      expect(retry.run.status).toBe("COMPLETED");
      expect(retry.collected).toBe(2);
      expect(retry.skipped).toBe(1);
    });
  });

  describe("multi-source coexistence", () => {
    let multiService: BlockchainService;

    beforeEach(() => {
      const connectorA = new StubConnector({
        sourceName: "TronGrid",
        sourceEndpoint: "https://api.trongrid.io",
      });
      const connectorB = new StubConnector({
        sourceName: "DirectNode",
        sourceType: "NODE",
        sourceEndpoint: "grpc://tron-node.local:50051",
      });
      multiService = new BlockchainService(
        database, new ConnectorRegistry([connectorA, connectorB]), new SqlBlockchainRepository(),
      );
    });

    it("allows two sources to independently collect the same block", async () => {
      const resultA = await multiService.collectBlock(50_000_000, "TronGrid");
      const resultB = await multiService.collectBlock(50_000_000, "DirectNode");

      expect(resultA.block.blockNumber).toBe(50_000_000);
      expect(resultB.block.blockNumber).toBe(50_000_000);
      expect(resultA.block.dataSourceId).not.toBe(resultB.block.dataSourceId);
      expect(resultA.block.collectionSource).toBe("TronGrid");
      expect(resultB.block.collectionSource).toBe("DirectNode");
    });

    it("returns all observations via getBlockObservations", async () => {
      const resultA = await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const observations = await multiService.getBlockObservations(
        resultA.block.networkId, 50_000_000,
      );
      expect(observations).toHaveLength(2);
      const sources = observations.map((b) => b.collectionSource).sort();
      expect(sources).toEqual(["DirectNode", "TronGrid"]);
    });

    it("returns all transaction observations via getTransactionObservations", async () => {
      const resultA = await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const observations = await multiService.getTransactionObservations(
        resultA.block.networkId, "abc123def456",
      );
      expect(observations).toHaveLength(2);
      const sourceIds = new Set(observations.map((t) => t.dataSourceId));
      expect(sourceIds.size).toBe(2);
    });

    it("shares the same network record (single service, single registry)", async () => {
      const network = await multiService.ensureNetwork();
      expect(network.chainId).toBe("tron-mainnet");
    });

    it("creates separate data source records per connector", async () => {
      await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");
      const network = await multiService.ensureNetwork();
      const sources = await multiService.getDataSourcesForNetwork(network.id);
      expect(sources).toHaveLength(2);
      const names = sources.map((s) => s.name).sort();
      expect(names).toEqual(["DirectNode", "TronGrid"]);
      expect(sources.find((s) => s.name === "DirectNode")!.sourceType).toBe("NODE");
    });

    it("still rejects duplicate from the same source", async () => {
      await multiService.collectBlock(50_000_000, "TronGrid");
      await expect(multiService.collectBlock(50_000_000, "TronGrid")).rejects.toBeInstanceOf(
        BlockchainConflictError,
      );
    });

    it("records independent events per source collection", async () => {
      await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const events = await raw.query<{
        payload: Record<string, unknown>;
      }>(
        "SELECT payload FROM domain_events WHERE event_type = 'blockchain_block_collected' ORDER BY recorded_at",
      );
      expect(events.rows).toHaveLength(2);
      expect(events.rows[0]!.payload).toMatchObject({ dataSourceName: "TronGrid" });
      expect(events.rows[1]!.payload).toMatchObject({ dataSourceName: "DirectNode" });
    });
  });

  describe("cross-validation", () => {
    it("returns INSUFFICIENT_SOURCES for uncollected block", async () => {
      const network = await service.ensureNetwork();
      const result = await service.validateBlock(network.id, 99_999_999);
      expect(result.status).toBe("INSUFFICIENT_SOURCES");
      expect(result.sourceCount).toBe(0);
    });

    it("returns INSUFFICIENT_SOURCES for single-source block", async () => {
      const collected = await service.collectBlock(50_000_000);
      const result = await service.validateBlock(collected.block.networkId, 50_000_000);
      expect(result.status).toBe("INSUFFICIENT_SOURCES");
      expect(result.sourceCount).toBe(1);
    });

    it("returns CONSISTENT when two sources agree", async () => {
      const connectorA = new StubConnector({
        sourceName: "TronGrid",
        sourceEndpoint: "https://api.trongrid.io",
      });
      const connectorB = new StubConnector({
        sourceName: "DirectNode",
        sourceType: "NODE",
        sourceEndpoint: "grpc://tron-node.local:50051",
      });
      const multiService = new BlockchainService(
        database, new ConnectorRegistry([connectorA, connectorB]), new SqlBlockchainRepository(),
      );

      await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const network = await multiService.ensureNetwork();
      const result = await multiService.validateBlock(network.id, 50_000_000);
      expect(result.status).toBe("CONSISTENT");
      expect(result.sourceCount).toBe(2);
      expect([...result.sources].sort()).toEqual(["DirectNode", "TronGrid"]);
      expect(result.blockDiscrepancies).toEqual([]);
      expect(result.transactionDiscrepancies).toEqual([]);
      expect(result.missingTransactions).toEqual([]);
    });

    it("detects block-level discrepancy", async () => {
      const connectorA = new StubConnector({
        sourceName: "TronGrid",
        sourceEndpoint: "https://api.trongrid.io",
      });
      const connectorB = new StubConnector({
        sourceName: "DirectNode",
        sourceType: "NODE",
        sourceEndpoint: "grpc://tron-node.local:50051",
      });
      connectorB.blocks.set(50_000_000, makeBlock({
        blockHash: "different-hash-from-node",
      }));
      const multiService = new BlockchainService(
        database, new ConnectorRegistry([connectorA, connectorB]), new SqlBlockchainRepository(),
      );

      await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const network = await multiService.ensureNetwork();
      const result = await multiService.validateBlock(network.id, 50_000_000);
      expect(result.status).toBe("DISCREPANCY");
      expect(result.blockDiscrepancies.length).toBeGreaterThan(0);
      expect(result.blockDiscrepancies.find((d) => d.field === "blockHash")).toBeDefined();
    });

    it("detects transaction-level discrepancy", async () => {
      const connectorA = new StubConnector({
        sourceName: "TronGrid",
        sourceEndpoint: "https://api.trongrid.io",
      });
      const connectorB = new StubConnector({
        sourceName: "DirectNode",
        sourceType: "NODE",
        sourceEndpoint: "grpc://tron-node.local:50051",
      });
      connectorB.blocks.set(50_000_000, makeBlock({
        transactions: [makeTx({ amount: "9999999" })],
      }));
      const multiService = new BlockchainService(
        database, new ConnectorRegistry([connectorA, connectorB]), new SqlBlockchainRepository(),
      );

      await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const network = await multiService.ensureNetwork();
      const result = await multiService.validateBlock(network.id, 50_000_000);
      expect(result.status).toBe("DISCREPANCY");
      expect(result.transactionDiscrepancies).toHaveLength(1);
      expect(result.transactionDiscrepancies[0]!.txHash).toBe("abc123def456");
      expect(result.transactionDiscrepancies[0]!.fields.find((f) => f.field === "amount")).toBeDefined();
    });

    it("detects missing transactions between sources", async () => {
      const connectorA = new StubConnector({
        sourceName: "TronGrid",
        sourceEndpoint: "https://api.trongrid.io",
      });
      const connectorB = new StubConnector({
        sourceName: "DirectNode",
        sourceType: "NODE",
        sourceEndpoint: "grpc://tron-node.local:50051",
      });
      connectorB.blocks.set(50_000_000, makeBlock({
        txCount: 2,
        transactions: [
          makeTx(),
          makeTx({ txHash: "extra-tx-only-in-node", amount: "500" }),
        ],
      }));
      const multiService = new BlockchainService(
        database, new ConnectorRegistry([connectorA, connectorB]), new SqlBlockchainRepository(),
      );

      await multiService.collectBlock(50_000_000, "TronGrid");
      await multiService.collectBlock(50_000_000, "DirectNode");

      const network = await multiService.ensureNetwork();
      const result = await multiService.validateBlock(network.id, 50_000_000);
      expect(result.status).toBe("DISCREPANCY");
      expect(result.missingTransactions).toHaveLength(1);
      expect(result.missingTransactions[0]!.txHash).toBe("extra-tx-only-in-node");
      expect(result.missingTransactions[0]!.presentIn).toContain("DirectNode");
      expect(result.missingTransactions[0]!.missingFrom).toContain("TronGrid");
    });

    it("rejects invalid block number", async () => {
      const network = await service.ensureNetwork();
      await expect(service.validateBlock(network.id, -1)).rejects.toBeInstanceOf(
        BlockchainValidationError,
      );
    });
  });
});
