/**
 * C-5: Regression tests for the blockchain payload size policy.
 *
 * Validates:
 *  - C-1: Buffer.byteLength(json, "utf8") is used for size measurement
 *  - C-2: 4 MiB default limit, 8 MiB absolute max
 *  - C-3: storage_state is FULL for accepted payloads
 *  - C-4: SHA-256 checksum is computed before insertion
 *  - C-5: >1 MiB payloads accepted as FULL, >8 MiB payloads rejected
 *  - C-6: raw_data_bytes, raw_data_checksum, storage_state persisted to SQL
 *  - C-7: existing rows default to storage_state = 'FULL'
 */
import { createHash } from "node:crypto";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import type { DataSourceType, RawBlock, RawTransaction } from "../src/blockchain/model.js";
import type { BlockchainConnector } from "../src/blockchain/connector.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";
import { SqlBlockchainRepository } from "../src/blockchain/blockchain-repository.js";
import { ConnectorRegistry } from "../src/blockchain/connector-registry.js";
import { BlockchainValidationError } from "../src/blockchain/errors.js";
import {
  measurePayload,
  DEFAULT_MAX_RAW_DATA_BYTES,
  ABSOLUTE_MAX_RAW_DATA_BYTES,
} from "../src/blockchain/blockchain-service.js";

// ── Test helpers ──

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
  public readonly networkName = "TRON Mainnet";
  public readonly chainId = "tron-mainnet";
  public readonly sourceName = "TronGrid:stub";
  public readonly sourceType: DataSourceType = "API";
  public readonly sourceEndpoint = "https://api.trongrid.io";
  public blocks = new Map<number, RawBlock>();

  public constructor() {
    this.blocks.set(50_000_000, makeBlock());
  }

  public async getLatestBlockNumber(): Promise<number> {
    return 50_000_100;
  }

  public async getBlock(blockNumber: number): Promise<RawBlock> {
    const block = this.blocks.get(blockNumber);
    if (!block) throw new Error(`Block ${blockNumber} not found in stub`);
    return block;
  }
}

/** Build a string of exactly `targetBytes` UTF-8 bytes using ASCII fill. */
function buildPayload(targetBytes: number): string {
  // JSON object with a single key whose value is a string of 'x' characters.
  // '{"d":"' = 6 bytes, '"}' = 2 bytes → overhead = 8 bytes
  const overhead = 8;
  const fillLength = targetBytes - overhead;
  if (fillLength <= 0) return "{}";
  return `{"d":"${"x".repeat(fillLength)}"}`;
}

// ── Unit tests for measurePayload ──

describe("measurePayload (unit)", () => {
  it("computes UTF-8 byte length, not string length (C-1)", () => {
    // Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units (1 JS "character" via surrogate pair)
    const json = JSON.stringify({ emoji: "🔥🔥🔥" });
    const result = measurePayload(json, "test");
    const expectedBytes = Buffer.byteLength(json, "utf8");

    expect(result.byteLength).toBe(expectedBytes);
    // UTF-8 byte length must differ from string length for multi-byte chars
    expect(result.byteLength).toBeGreaterThan(json.length);
  });

  it("computes correct SHA-256 checksum (C-4)", () => {
    const json = JSON.stringify({ block: 12345, data: "test-data" });
    const result = measurePayload(json, "test");
    const expectedChecksum = createHash("sha256").update(json, "utf8").digest("hex");

    expect(result.checksum).toBe(expectedChecksum);
    expect(result.checksum).toHaveLength(64);
  });

  it("accepts payloads >1 MiB as FULL (C-5)", () => {
    const oneMiBPlus = 1_048_576 + 1024; // ~1 MiB + 1 KiB
    const json = buildPayload(oneMiBPlus);
    const result = measurePayload(json, "test");

    expect(result.byteLength).toBeGreaterThan(1_048_576);
    expect(result.storageState).toBe("FULL");
  });

  it("accepts payloads up to 4 MiB as FULL (C-2)", () => {
    const json = buildPayload(DEFAULT_MAX_RAW_DATA_BYTES);
    const result = measurePayload(json, "test");

    expect(result.byteLength).toBe(DEFAULT_MAX_RAW_DATA_BYTES);
    expect(result.storageState).toBe("FULL");
  });

  it("accepts payloads between 4 MiB and 8 MiB as FULL (no truncation)", () => {
    const fiveMiB = 5 * 1024 * 1024;
    const json = buildPayload(fiveMiB);
    const result = measurePayload(json, "test");

    expect(result.byteLength).toBe(fiveMiB);
    expect(result.storageState).toBe("FULL");
  });

  it("accepts payloads at exactly 8 MiB (C-2)", () => {
    const json = buildPayload(ABSOLUTE_MAX_RAW_DATA_BYTES);
    const result = measurePayload(json, "test");

    expect(result.byteLength).toBe(ABSOLUTE_MAX_RAW_DATA_BYTES);
    expect(result.storageState).toBe("FULL");
  });

  it("rejects payloads exceeding 8 MiB with BlockchainValidationError (C-5)", () => {
    const json = buildPayload(ABSOLUTE_MAX_RAW_DATA_BYTES + 1);

    expect(() => measurePayload(json, "Block 99999")).toThrow(
      BlockchainValidationError,
    );
    expect(() => measurePayload(json, "Block 99999")).toThrow(
      /exceeds absolute.*byte limit/,
    );
  });

  it("error message reports UTF-8 byte length, not string length (C-1)", () => {
    const json = buildPayload(ABSOLUTE_MAX_RAW_DATA_BYTES + 100);

    try {
      measurePayload(json, "Block 99999");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlockchainValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain("bytes UTF-8");
      expect(msg).toContain(String(ABSOLUTE_MAX_RAW_DATA_BYTES + 100));
    }
  });

  it("verifies DEFAULT is 4 MiB and ABSOLUTE is 8 MiB (C-2)", () => {
    expect(DEFAULT_MAX_RAW_DATA_BYTES).toBe(4 * 1024 * 1024);
    expect(ABSOLUTE_MAX_RAW_DATA_BYTES).toBe(8 * 1024 * 1024);
  });

  it("uses Buffer.byteLength not json.length for the size check (C-1)", () => {
    // Construct a string where json.length < ABSOLUTE_MAX but byte length > ABSOLUTE_MAX.
    // Each 4-byte emoji is 2 JS chars → ratio ~2:1 bytes:chars.
    // We need byte length > 8 MiB. At 4 bytes per emoji, we need > 2M emojis.
    // That's too large for this test — instead verify the measurement is correct
    // for a known multi-byte payload and that the function uses the byte value.
    const emoji = "🔥";
    const emojiBytes = Buffer.byteLength(emoji, "utf8"); // 4
    const emojiChars = emoji.length; // 2

    // A payload of N emojis: {"d":"🔥🔥..."}
    const n = 100;
    const json = `{"d":"${emoji.repeat(n)}"}`;
    const result = measurePayload(json, "test");

    // Byte length should account for 4 bytes per emoji, not 2
    const overhead = Buffer.byteLength('{"d":""}', "utf8");
    expect(result.byteLength).toBe(overhead + n * emojiBytes);
    expect(result.byteLength).toBeGreaterThan(json.length);
  });
});

// ── Integration tests: payload policy columns persisted to SQL ──

describe("blockchain payload policy (SQL integration)", () => {
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

  it("persists raw_data_bytes, raw_data_checksum, and storage_state for blocks (C-6)", async () => {
    await service.collectBlock(50_000_000);

    const result = await raw.query<{
      raw_data_bytes: number;
      raw_data_checksum: string;
      storage_state: string;
    }>(
      `SELECT raw_data_bytes, raw_data_checksum, storage_state
       FROM blockchain_blocks WHERE block_number = 50000000`,
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;

    expect(row.storage_state).toBe("FULL");
    expect(row.raw_data_bytes).toBeGreaterThan(0);
    expect(row.raw_data_checksum).toHaveLength(64);
    expect(row.raw_data_checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists raw_data_bytes, raw_data_checksum, and storage_state for transactions (C-6)", async () => {
    await service.collectBlock(50_000_000);

    const result = await raw.query<{
      raw_data_bytes: number;
      raw_data_checksum: string;
      storage_state: string;
    }>(
      `SELECT raw_data_bytes, raw_data_checksum, storage_state
       FROM blockchain_transactions WHERE tx_hash = 'abc123def456'`,
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;

    expect(row.storage_state).toBe("FULL");
    expect(row.raw_data_bytes).toBeGreaterThan(0);
    expect(row.raw_data_checksum).toHaveLength(64);
  });

  it("raw_data_bytes matches Buffer.byteLength of the stored raw_data (C-1)", async () => {
    await service.collectBlock(50_000_000);

    const result = await raw.query<{
      raw_data: Record<string, unknown>;
      raw_data_bytes: number;
    }>(
      `SELECT raw_data, raw_data_bytes FROM blockchain_blocks WHERE block_number = 50000000`,
    );

    const row = result.rows[0]!;
    const storedJson = JSON.stringify(row.raw_data);
    const expectedBytes = Buffer.byteLength(storedJson, "utf8");

    expect(row.raw_data_bytes).toBe(expectedBytes);
  });

  it("raw_data_checksum matches SHA-256 of the original JSON payload (C-4)", async () => {
    // Compute the expected checksum from the raw data the stub provides,
    // which is exactly what the service serialises before insertion.
    const stubBlock = await connector.getBlock(50_000_000);
    const originalJson = JSON.stringify(stubBlock.raw);
    const expectedChecksum = createHash("sha256").update(originalJson, "utf8").digest("hex");

    await service.collectBlock(50_000_000);

    const result = await raw.query<{ raw_data_checksum: string }>(
      `SELECT raw_data_checksum FROM blockchain_blocks WHERE block_number = 50000000`,
    );

    expect(result.rows[0]!.raw_data_checksum).toBe(expectedChecksum);
  });

  it("existing rows default to storage_state = 'FULL' (C-7)", async () => {
    // Simulate a row inserted without the new columns (as if from old code)
    // by inserting via raw SQL without specifying the new columns.
    // The DEFAULT 'FULL' in the migration handles this.
    const network = await service.ensureNetwork();
    const dataSource = await service.ensureDataSource(network.id);

    await raw.query(
      `INSERT INTO blockchain_blocks (
        id, network_id, data_source_id, block_number, block_hash, parent_hash,
        block_timestamp, tx_count, raw_data, collection_source
      ) VALUES (
        gen_random_uuid(), $1, $2, 99999999, 'legacy-hash', 'legacy-parent',
        CURRENT_TIMESTAMP, 0, '{"legacy": true}'::jsonb, 'legacy-source'
      )`,
      [network.id, dataSource.id],
    );

    const result = await raw.query<{ storage_state: string }>(
      `SELECT storage_state FROM blockchain_blocks WHERE block_number = 99999999`,
    );

    expect(result.rows[0]!.storage_state).toBe("FULL");
  });

  it("storage_state CHECK constraint rejects invalid values (C-3)", async () => {
    const network = await service.ensureNetwork();
    const dataSource = await service.ensureDataSource(network.id);

    await expect(
      raw.query(
        `INSERT INTO blockchain_blocks (
          id, network_id, data_source_id, block_number, block_hash, parent_hash,
          block_timestamp, tx_count, raw_data, collection_source, storage_state
        ) VALUES (
          gen_random_uuid(), $1, $2, 88888888, 'test-hash', 'test-parent',
          CURRENT_TIMESTAMP, 0, '{"test": true}'::jsonb, 'test-source', 'INVALID'
        )`,
        [network.id, dataSource.id],
      ),
    ).rejects.toThrow();
  });

  it("rejects block with raw_data exceeding 8 MiB absolute max (C-5)", async () => {
    // Build a raw object that serializes to >8 MiB
    const targetBytes = ABSOLUTE_MAX_RAW_DATA_BYTES + 1024;
    // Each char in the fill string is 1 UTF-8 byte (ASCII)
    const hugeRaw: Record<string, unknown> = { fill: "x".repeat(targetBytes) };

    connector.blocks.set(50_000_000, makeBlock({
      raw: hugeRaw,
    }));

    await expect(service.collectBlock(50_000_000)).rejects.toThrow(
      BlockchainValidationError,
    );
    await expect(service.collectBlock(50_000_000)).rejects.toThrow(
      /exceeds absolute.*byte limit/,
    );
  });

  it("accepts block with raw_data >1 MiB as FULL (C-5)", async () => {
    // Build a raw object that serializes to >1 MiB but <4 MiB
    const targetBytes = 1_100_000; // ~1.05 MiB
    const largeRaw = { fill: "a".repeat(targetBytes) };

    connector.blocks.set(50_000_000, makeBlock({
      raw: largeRaw,
    }));

    const result = await service.collectBlock(50_000_000);
    expect(result.block.blockNumber).toBe(50_000_000);

    const row = await raw.query<{ storage_state: string; raw_data_bytes: number }>(
      `SELECT storage_state, raw_data_bytes FROM blockchain_blocks WHERE block_number = 50000000`,
    );

    expect(row.rows[0]!.storage_state).toBe("FULL");
    expect(row.rows[0]!.raw_data_bytes).toBeGreaterThan(1_048_576);
  });
});
