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
import type { ActorContext } from "../src/proposals/model.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";
import { SqlBlockchainRepository } from "../src/blockchain/blockchain-repository.js";
import { BlockchainRateLimiter } from "../src/blockchain/blockchain-rate-limiter.js";
import { buildBlockchainApi } from "../src/blockchain/api.js";

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
    chainData: { energyUsed: null, bandwidthUsed: 267 },
    raw: { test: true },
    ...overrides,
  };
}

function makeBlock(overrides?: Partial<RawBlock>): RawBlock {
  return {
    blockNumber: 50_000_000,
    blockHash: "0000000002faf080",
    parentHash: "0000000002faf07f",
    timestamp: 1700000000000,
    blockProducer: "TWitness",
    txCount: 1,
    sizeBytes: 1024,
    transactions: [makeTx()],
    raw: { blockID: "test-block" },
    ...overrides,
  };
}

class StubConnector implements BlockchainConnector {
  public readonly networkName = "TRON Mainnet";
  public readonly chainId = "tron-mainnet";
  public readonly sourceName = "TronGrid:stub";
  public readonly sourceType: DataSourceType = "API";
  public readonly sourceEndpoint = "https://stub.test";
  public latestBlockNumber = 50_000_100;
  public blocks = new Map<number, RawBlock>([[50_000_000, makeBlock()]]);

  public async getLatestBlockNumber(): Promise<number> {
    return this.latestBlockNumber;
  }
  public async getBlock(blockNumber: number): Promise<RawBlock> {
    const block = this.blocks.get(blockNumber);
    if (!block) throw new Error(`Block ${blockNumber} not found in stub`);
    return block;
  }
}

const tokens = new Map<string, ActorContext>([
  ["test-token", { actorId: "actor-1", role: "USER" }],
  ["admin-token", { actorId: "actor-admin", role: "ADMIN" }],
]);

describe("blockchain API", () => {
  let raw: PGlite;
  let app: ReturnType<typeof buildBlockchainApi>;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
      await loadMigrations(),
    );
    const database = new Database(raw);
    const connector = new StubConnector();
    const repository = new SqlBlockchainRepository();
    const service = new BlockchainService(database, connector, repository);
    const rateLimiter = new BlockchainRateLimiter(database);
    app = buildBlockchainApi({
      blockchain: service,
      authenticate: async (request) => {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) return undefined;
        return tokens.get(header.slice("Bearer ".length));
      },
      rateLimiter,
    });
  });

  afterEach(async () => {
    await app.close();
    await raw.close();
  });

  describe("POST /blockchain/collect", () => {
    it("collects a block and returns 201", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.block.blockNumber).toBe(50_000_000);
      expect(body.block.blockHash).toBe("0000000002faf080");
      expect(body.collectionRun.status).toBe("COMPLETED");
    });

    it("serializes transaction fields with generic amount/fee and chainData", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const body = response.json();
      expect(body.transactions).toHaveLength(1);
      expect(body.transactions[0].amount).toBe("1000000");
      expect(body.transactions[0].fee).toBe("100000");
      expect(body.transactions[0].amountUnit).toBe("SUN");
      expect(body.transactions[0].feeUnit).toBe("SUN");
      expect(body.transactions[0].chainData).toEqual({ energyUsed: null, bandwidthUsed: 267 });
    });

    it("returns 409 for duplicate collection", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("CONFLICT");
    });

    it("returns 400 for invalid block number", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: -1 },
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 for missing block number", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 401 without authorization header", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        payload: { blockNumber: 50_000_000 },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("AUTHENTICATION_REQUIRED");
    });

    it("returns 401 with invalid token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer invalid-token" },
        payload: { blockNumber: 50_000_000 },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("AUTHENTICATION_REQUIRED");
    });

    it("returns 429 when rate limited", async () => {
      const database = new Database(raw);
      const connector = new StubConnector();
      connector.blocks = new Map(
        Array.from({ length: 35 }, (_, i) => [
          i,
          makeBlock({
            blockNumber: i,
            blockHash: `hash-${i}`,
            transactions: [makeTx({ txHash: `tx-${i}` })],
          }),
        ]),
      );
      const service = new BlockchainService(database, connector, new SqlBlockchainRepository());
      const rateLimiter = new BlockchainRateLimiter(database, {
        version: 1,
        windowSeconds: 60,
        retentionSeconds: 600,
        actorLimits: Object.freeze({ block_collect: 3 }),
        globalLimit: 500,
      });
      const limitedApp = buildBlockchainApi({
        blockchain: service,
        authenticate: async () => ({ actorId: "actor-1", role: "USER" }),
        rateLimiter,
      });

      for (let i = 0; i < 3; i++) {
        const r = await limitedApp.inject({
          method: "POST",
          url: "/blockchain/collect",
          headers: { authorization: "Bearer test-token" },
          payload: { blockNumber: i },
        });
        expect(r.statusCode).toBe(201);
      }

      const response = await limitedApp.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 4 },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error).toBe("RATE_LIMITED");
      expect(response.headers["retry-after"]).toBeDefined();

      await limitedApp.close();
    });
  });

  describe("GET /blockchain/blocks/:blockNumber", () => {
    it("returns a collected block", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "GET",
        url: "/blockchain/blocks/50000000",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().blockNumber).toBe(50_000_000);
    });

    it("returns 404 for uncollected block", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "GET",
        url: "/blockchain/blocks/99999999",
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 400 for non-numeric block number", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/blockchain/blocks/abc",
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /blockchain/blocks/:blockNumber/observations", () => {
    it("returns observations for a collected block", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "GET",
        url: "/blockchain/blocks/50000000/observations",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].blockNumber).toBe(50_000_000);
    });

    it("returns empty array for uncollected block", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "GET",
        url: "/blockchain/blocks/99999999/observations",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("GET /blockchain/blocks/:blockNumber/transactions", () => {
    it("returns transactions for a collected block", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "GET",
        url: "/blockchain/blocks/50000000/transactions",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].txHash).toBe("abc123def456");
      expect(body[0].amount).toBe("1000000");
    });
  });

  describe("GET /blockchain/latest", () => {
    it("returns the latest block number", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/blockchain/latest",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().blockNumber).toBe(50_000_100);
    });
  });

  describe("GET /blockchain/network", () => {
    it("returns the network information", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/blockchain/network",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe("TRON Mainnet");
      expect(body.chainId).toBe("tron-mainnet");
      expect(body.networkType).toBe("MAINNET");
    });
  });

  describe("GET /blockchain/sources", () => {
    it("returns registered data sources", async () => {
      await app.inject({
        method: "POST",
        url: "/blockchain/collect",
        headers: { authorization: "Bearer test-token" },
        payload: { blockNumber: 50_000_000 },
      });

      const response = await app.inject({
        method: "GET",
        url: "/blockchain/sources",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("TronGrid:stub");
      expect(body[0].sourceType).toBe("API");
    });
  });
});
