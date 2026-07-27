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
    fromAddress: "TFromAddr",
    toAddress: "TToAddr",
    amount: "1000000",
    fee: "100000",
    amountUnit: "SUN",
    feeUnit: "SUN",
    result: "SUCCESS",
    chainData: { energyUsed: 50000, bandwidthUsed: 267 },
    raw: { source: "default" },
    ...overrides,
  };
}

class ApiConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly chainId = "tron-mainnet";
  public readonly sourceName = "TronGrid";
  public readonly sourceType: DataSourceType = "API";
  public readonly sourceEndpoint = "https://api.trongrid.io";

  public async getLatestBlockNumber(): Promise<number> { return 75_000_000; }
  public async getBlock(blockNumber: number): Promise<RawBlock> {
    return {
      blockNumber,
      blockHash: "0000000002faf080abcdef",
      parentHash: "0000000002faf07f123456",
      timestamp: 1_700_000_000_000,
      blockProducer: "41witness_hex",
      txCount: 1,
      sizeBytes: 2048,
      transactions: [makeTx({ raw: { source: "trongrid" } })],
      raw: { blockID: "0000000002faf080abcdef", source: "trongrid" },
    };
  }
}

class ExplorerConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly chainId = "tron-mainnet";
  public readonly sourceName = "TronScan";
  public readonly sourceType: DataSourceType = "EXPLORER";
  public readonly sourceEndpoint = "https://apilist.tronscanapi.com";

  public async getLatestBlockNumber(): Promise<number> { return 75_000_000; }
  public async getBlock(blockNumber: number): Promise<RawBlock> {
    return {
      blockNumber,
      blockHash: "0000000002faf080abcdef",
      parentHash: "0000000002faf07f123456",
      timestamp: 1_700_000_000_000,
      blockProducer: "TRWBqiqoFZysoAeyR1J35ibuyc8EvhUAoY",
      txCount: 1,
      sizeBytes: 2100,
      transactions: [makeTx({ raw: { source: "tronscan" } })],
      raw: { hash: "0000000002faf080abcdef", source: "tronscan" },
    };
  }
}

describe("multi-source comparison: TronGrid vs TronScan", () => {
  let raw: PGlite;
  let service: BlockchainService;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
      await loadMigrations(),
    );
    const database = new Database(raw);
    const registry = new ConnectorRegistry([new ApiConnector(), new ExplorerConnector()]);
    service = new BlockchainService(database, registry, new SqlBlockchainRepository());
  });

  afterEach(async () => raw.close());

  it("single service shares the same network record for all connectors", async () => {
    const network = await service.ensureNetwork();
    expect(network.chainId).toBe("tron-mainnet");
  });

  it("creates separate data source records with correct types", async () => {
    await service.collectBlock(50_000_000, "TronGrid");
    await service.collectBlock(50_000_000, "TronScan");

    const network = await service.ensureNetwork();
    const sources = await service.getDataSourcesForNetwork(network.id);
    expect(sources).toHaveLength(2);
    const grid = sources.find((s) => s.name === "TronGrid")!;
    const scan = sources.find((s) => s.name === "TronScan")!;
    expect(grid.id).not.toBe(scan.id);
    expect(grid.sourceType).toBe("API");
    expect(scan.sourceType).toBe("EXPLORER");
  });

  it("collects the same block independently from both sources", async () => {
    const resultGrid = await service.collectBlock(50_000_000, "TronGrid");
    const resultScan = await service.collectBlock(50_000_000, "TronScan");

    expect(resultGrid.block.blockNumber).toBe(50_000_000);
    expect(resultScan.block.blockNumber).toBe(50_000_000);
    expect(resultGrid.block.blockHash).toBe(resultScan.block.blockHash);
    expect(resultGrid.block.dataSourceId).not.toBe(resultScan.block.dataSourceId);
    expect(resultGrid.block.collectionSource).toBe("TronGrid");
    expect(resultScan.block.collectionSource).toBe("TronScan");
  });

  it("returns both observations via getBlockObservations", async () => {
    const resultGrid = await service.collectBlock(50_000_000, "TronGrid");
    await service.collectBlock(50_000_000, "TronScan");

    const observations = await service.getBlockObservations(
      resultGrid.block.networkId, 50_000_000,
    );

    expect(observations).toHaveLength(2);
    const sources = observations.map((o) => o.collectionSource).sort();
    expect(sources).toEqual(["TronGrid", "TronScan"]);
    const sourceTypes = new Set(observations.map((o) => o.dataSourceId));
    expect(sourceTypes.size).toBe(2);
  });

  it("returns both transaction observations via getTransactionObservations", async () => {
    const resultGrid = await service.collectBlock(50_000_000, "TronGrid");
    await service.collectBlock(50_000_000, "TronScan");

    const observations = await service.getTransactionObservations(
      resultGrid.block.networkId, "abc123def456",
    );

    expect(observations).toHaveLength(2);
    const dataSourceIds = new Set(observations.map((o) => o.dataSourceId));
    expect(dataSourceIds.size).toBe(2);
  });

  it("preserves raw data from each source independently", async () => {
    await service.collectBlock(50_000_000, "TronGrid");
    await service.collectBlock(50_000_000, "TronScan");

    const blocks = await raw.query<{ raw_data: Record<string, unknown>; collection_source: string }>(
      `SELECT raw_data, collection_source FROM blockchain_blocks
       WHERE block_number = 50000000 ORDER BY collection_source`,
    );

    expect(blocks.rows).toHaveLength(2);
    expect(blocks.rows[0]!.collection_source).toBe("TronGrid");
    expect(blocks.rows[0]!.raw_data).toHaveProperty("source", "trongrid");
    expect(blocks.rows[1]!.collection_source).toBe("TronScan");
    expect(blocks.rows[1]!.raw_data).toHaveProperty("source", "tronscan");
  });

  it("records separate domain events for each source", async () => {
    await service.collectBlock(50_000_000, "TronGrid");
    await service.collectBlock(50_000_000, "TronScan");

    const events = await raw.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events
       WHERE event_type = 'blockchain_block_collected'
       ORDER BY recorded_at`,
    );

    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]!.payload).toMatchObject({ dataSourceName: "TronGrid" });
    expect(events.rows[1]!.payload).toMatchObject({ dataSourceName: "TronScan" });
  });

  it("lists both data sources for the network", async () => {
    await service.collectBlock(50_000_000, "TronGrid");
    await service.collectBlock(50_000_000, "TronScan");

    const network = await service.ensureNetwork();
    const sources = await service.getDataSourcesForNetwork(network.id);

    expect(sources).toHaveLength(2);
    const names = sources.map((s) => s.name).sort();
    expect(names).toEqual(["TronGrid", "TronScan"]);
  });

  it("allows querying a specific source's observation", async () => {
    const resultGrid = await service.collectBlock(50_000_000, "TronGrid");
    const resultScan = await service.collectBlock(50_000_000, "TronScan");

    const gridBlock = await service.getBlock(
      resultGrid.block.networkId, 50_000_000, resultGrid.block.dataSourceId,
    );
    const scanBlock = await service.getBlock(
      resultScan.block.networkId, 50_000_000, resultScan.block.dataSourceId,
    );

    expect(gridBlock!.collectionSource).toBe("TronGrid");
    expect(scanBlock!.collectionSource).toBe("TronScan");
    expect(gridBlock!.blockHash).toBe(scanBlock!.blockHash);
  });

  it("creates separate collection runs per source", async () => {
    const resultGrid = await service.collectBlock(50_000_000, "TronGrid");
    const resultScan = await service.collectBlock(50_000_000, "TronScan");

    expect(resultGrid.collectionRun.sourceApi).toBe("TronGrid");
    expect(resultScan.collectionRun.sourceApi).toBe("TronScan");
    expect(resultGrid.collectionRun.id).not.toBe(resultScan.collectionRun.id);
    expect(resultGrid.collectionRun.status).toBe("COMPLETED");
    expect(resultScan.collectionRun.status).toBe("COMPLETED");
  });
});
