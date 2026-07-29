import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { TronGridContractCollector } from "../src/blockchain/tron-contract-collector.js";
import { TronScanContractCollector } from "../src/blockchain/tronscan-contract-collector.js";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server;
let port: number;
let handler: Handler;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    readBody(req).then((body) => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function httpClient(): TronHttpClient {
  return new TronHttpClient({
    endpoint: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    rateLimitPerSecond: 1000,
  });
}

function jsonOk(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const USDT_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const CREATOR_HEX = "410000000000000000000000000000000000000001";

// ── TronGrid Contract Collector ──

describe("TronGridContractCollector", () => {
  it("collects contract data from TronGrid", async () => {
    handler = (req, _body, res) => {
      const url = req.url ?? "";
      if (url === "/wallet/getcontractinfo") {
        jsonOk(res, {
          contract_address: USDT_HEX,
          name: "TetherToken",
          is_verified: true,
          compiler_version: "tron-0.5.10_Odyssey_v3.6.6",
          creator: {
            address: CREATOR_HEX,
            txHash: "abc123def456",
          },
        });
      } else if (url === "/wallet/getcontract") {
        jsonOk(res, {
          contract_address: USDT_HEX,
          origin_address: CREATOR_HEX,
          name: "TetherToken",
          abi: {
            entrys: [
              { name: "transfer", type: "Function" },
              { name: "balanceOf", type: "Function" },
            ],
          },
          contract_state: {
            energy_factor: 10000,
          },
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const collector = new TronGridContractCollector(httpClient());
    const result = await collector.collect({ address: USDT_BASE58 });

    expect(result.address).toBe(USDT_BASE58);
    expect(result.name).toBe("TetherToken");
    expect(result.isVerified).toBe(true);
    expect(result.compilerVersion).toBe("tron-0.5.10_Odyssey_v3.6.6");
    expect(result.creationTxHash).toBe("abc123def456");
    expect(result.abi).toHaveLength(2);
    expect(result.energyFactor).toBe(10000);
    expect(result.source).toBe("trongrid");
  });

  it("throws on nonexistent contract", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {});
    };

    const collector = new TronGridContractCollector(httpClient());
    await expect(
      collector.collect({ address: USDT_BASE58 }),
    ).rejects.toThrow("Contract not found");
  });

  it("handles contract without ABI", async () => {
    handler = (req, _body, res) => {
      const url = req.url ?? "";
      if (url === "/wallet/getcontractinfo") {
        jsonOk(res, { contract_address: USDT_HEX });
      } else {
        jsonOk(res, {
          contract_address: USDT_HEX,
          origin_address: CREATOR_HEX,
        });
      }
    };

    const collector = new TronGridContractCollector(httpClient());
    const result = await collector.collect({ address: USDT_BASE58 });

    expect(result.abi).toBeNull();
    expect(result.isVerified).toBe(false);
  });

  it("has correct metadata", () => {
    const collector = new TronGridContractCollector(httpClient());
    expect(collector.collectorName).toBe("tron-contract-trongrid");
    expect(collector.sourceName).toBe("trongrid");
    expect(collector.sourceType).toBe("API");
  });
});

// ── TronScan Contract Collector ──

describe("TronScanContractCollector", () => {
  it("collects contract data from TronScan", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        data: [
          {
            address: USDT_BASE58,
            name: "TetherToken",
            creator: USDT_BASE58,
            trx_hash: "abc123def456",
            date_created: 1_560_000_000_000,
            verify_status: 2,
            compiler: "tron-0.5.10",
            call_count: 500_000,
            caller_count: 100_000,
            abi: JSON.stringify([
              { name: "transfer", type: "function" },
            ]),
          },
        ],
      });
    };

    const collector = new TronScanContractCollector(httpClient());
    const result = await collector.collect({ address: USDT_BASE58 });

    expect(result.address).toBe(USDT_BASE58);
    expect(result.name).toBe("TetherToken");
    expect(result.isVerified).toBe(true);
    expect(result.createdAt).toBe(1_560_000_000_000);
    expect(result.callCount).toBe(500_000);
    expect(result.callerCount).toBe(100_000);
    expect(result.abi).toHaveLength(1);
    expect(result.source).toBe("tronscan");
  });

  it("handles unverified contracts", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        data: [
          {
            address: USDT_BASE58,
            verify_status: 0,
          },
        ],
      });
    };

    const collector = new TronScanContractCollector(httpClient());
    const result = await collector.collect({ address: USDT_BASE58 });

    expect(result.isVerified).toBe(false);
  });

  it("handles invalid ABI JSON", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        data: [
          {
            address: USDT_BASE58,
            abi: "not-valid-json",
          },
        ],
      });
    };

    const collector = new TronScanContractCollector(httpClient());
    const result = await collector.collect({ address: USDT_BASE58 });

    expect(result.abi).toBeNull();
  });

  it("throws on nonexistent contract", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, { data: [] });
    };

    const collector = new TronScanContractCollector(httpClient());
    await expect(
      collector.collect({ address: USDT_BASE58 }),
    ).rejects.toThrow("Contract not found");
  });

  it("has correct metadata", () => {
    const collector = new TronScanContractCollector(httpClient());
    expect(collector.collectorName).toBe("tron-contract-tronscan");
    expect(collector.sourceName).toBe("tronscan");
    expect(collector.sourceType).toBe("EXPLORER");
  });
});
