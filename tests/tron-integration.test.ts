import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { TronGridConnector } from "../src/blockchain/tron-connector.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";
import { SqlBlockchainRepository } from "../src/blockchain/blockchain-repository.js";
import { ConnectorRegistry } from "../src/blockchain/connector-registry.js";

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

const apiKey = process.env["TRONGRID_API_KEY"];
const endpoint = process.env["TRONGRID_ENDPOINT"] || "https://api.trongrid.io";

const STABLE_BLOCK_NUMBER = 50_000_000;

describe.skipIf(!apiKey)("TRON real integration", { timeout: 30_000 }, () => {
  let raw: PGlite;
  let database: Database;
  let connector: TronGridConnector;
  let service: BlockchainService;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
      await loadMigrations(),
    );
    database = new Database(raw);
    const config: { endpoint: string; apiKey?: string } = { endpoint };
    if (apiKey) config.apiKey = apiKey;
    connector = new TronGridConnector(config);
    service = new BlockchainService(database, new ConnectorRegistry([connector]), new SqlBlockchainRepository());
  });

  afterEach(async () => raw.close());

  it("registers TRON Mainnet as a network", async () => {
    const network = await service.ensureNetwork();

    expect(network.name).toBe("TRON Mainnet");
    expect(network.chainId).toBe("tron-mainnet");
    expect(network.networkType).toBe("MAINNET");
    expect(network.status).toBe("ACTIVE");
  });

  it("registers TronGrid as a data source", async () => {
    const network = await service.ensureNetwork();
    const dataSource = await service.ensureDataSource(network.id);

    expect(dataSource.name).toBe("TronGrid");
    expect(dataSource.sourceType).toBe("API");
    expect(dataSource.endpoint).toBe(endpoint);
    expect(dataSource.networkId).toBe(network.id);
  });

  it("collects a real block from TRON Mainnet", async () => {
    const result = await service.collectBlock(STABLE_BLOCK_NUMBER);

    expect(result.block.blockNumber).toBe(STABLE_BLOCK_NUMBER);
    expect(result.block.blockHash).toBeTruthy();
    expect(result.block.parentHash).toBeTruthy();
    expect(result.block.blockTimestamp).toBeInstanceOf(Date);
    expect(result.block.collectionSource).toBe("TronGrid");
    expect(result.block.dataSourceId).toBeTruthy();
    expect(result.block.txCount).toBeGreaterThanOrEqual(0);

    expect(result.collectionRun.status).toBe("COMPLETED");
    expect(result.collectionRun.blocksCollected).toBe(1);
    expect(result.collectionRun.sourceApi).toBe("TronGrid");
    expect(result.collectionRun.completedAt).not.toBeNull();
  });

  it("preserves raw JSON data from TronGrid", async () => {
    await service.collectBlock(STABLE_BLOCK_NUMBER);

    const row = await raw.query<{ raw_data: Record<string, unknown> }>(
      `SELECT raw_data FROM blockchain_blocks WHERE block_number = $1`,
      [STABLE_BLOCK_NUMBER],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.raw_data).toHaveProperty("blockID");
    expect(row.rows[0]!.raw_data).toHaveProperty("block_header");
  });

  it("normalizes and persists transactions", async () => {
    const result = await service.collectBlock(STABLE_BLOCK_NUMBER);

    if (result.transactions.length > 0) {
      const tx = result.transactions[0]!;
      expect(tx.txHash).toBeTruthy();
      expect(tx.txType).toBeTruthy();
      expect(tx.dataSourceId).toBe(result.block.dataSourceId);
      expect(tx.networkId).toBe(result.block.networkId);
      expect(tx.blockId).toBe(result.block.id);
    }

    const txRows = await raw.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM blockchain_transactions WHERE block_id = $1`,
      [result.block.id],
    );
    expect(txRows.rows[0]!.count).toBe(result.transactions.length);
  });

  it("can query a collected block back", async () => {
    const collected = await service.collectBlock(STABLE_BLOCK_NUMBER);
    const found = await service.getBlock(collected.block.networkId, STABLE_BLOCK_NUMBER);

    expect(found).not.toBeNull();
    expect(found!.blockNumber).toBe(STABLE_BLOCK_NUMBER);
    expect(found!.blockHash).toBe(collected.block.blockHash);
    expect(found!.dataSourceId).toBe(collected.block.dataSourceId);
  });

  it("records provenance in domain events", async () => {
    await service.collectBlock(STABLE_BLOCK_NUMBER);

    const events = await raw.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT event_type, payload FROM domain_events WHERE event_type = 'blockchain_block_collected'",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({
      networkName: "TRON Mainnet",
      dataSourceName: "TronGrid",
      blockNumber: STABLE_BLOCK_NUMBER,
    });
  });

  it("retrieves the latest block number from TRON", async () => {
    const latest = await service.getLatestBlockNumber();

    expect(latest).toBeGreaterThan(STABLE_BLOCK_NUMBER);
  });

  it("supports querying observations after collection", async () => {
    const collected = await service.collectBlock(STABLE_BLOCK_NUMBER);
    const observations = await service.getBlockObservations(
      collected.block.networkId, STABLE_BLOCK_NUMBER,
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]!.blockHash).toBe(collected.block.blockHash);
    expect(observations[0]!.collectionSource).toBe("TronGrid");
  });
});
