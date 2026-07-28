import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { TronAccountCollector } from "../src/blockchain/tron-account-collector.js";
import { TronScanAccountCollector } from "../src/blockchain/tronscan-account-collector.js";

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

const FOUNDATION_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const FOUNDATION_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ── TronGrid Account Collector ──

describe("TronAccountCollector", () => {
  it("collects account data from TronGrid API", async () => {
    handler = (req, _body, res) => {
      const url = req.url ?? "";
      if (url === "/wallet/getaccountresource") {
        jsonOk(res, {
          freeNetLimit: 600,
          freeNetUsed: 100,
          EnergyLimit: 50000,
          EnergyUsed: 10000,
          NetLimit: 1000,
          NetUsed: 200,
        });
      } else if (url === "/wallet/getaccount") {
        jsonOk(res, {
          address: FOUNDATION_HEX,
          balance: 50_000_000,
          create_time: 1_529_990_700_000,
          latest_opration_time: 1_700_000_000_000,
          owner_permission: {
            type: 0,
            permission_name: "owner",
            threshold: 1,
            keys: [{ address: FOUNDATION_HEX, weight: 1 }],
          },
          trc20: [
            { "41dac17f958d2ee523a2206206994597c13d831ec7": "1000000" },
          ],
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const collector = new TronAccountCollector(httpClient());
    const result = await collector.collect({ address: FOUNDATION_BASE58 });

    expect(result.address).toBe(FOUNDATION_BASE58);
    expect(result.balanceSun).toBe("50000000");
    expect(result.balanceTrx).toBe("50");
    expect(result.createTime).toBe(1_529_990_700_000);
    expect(result.energyLimit).toBe(50000);
    expect(result.energyUsed).toBe(10000);
    expect(result.bandwidthLimit).toBe(1600);
    expect(result.bandwidthUsed).toBe(300);
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0]!.type).toBe("owner");
    expect(result.trc20Balances).toHaveLength(1);
    expect(result.source).toBe("trongrid");
  });

  it("handles frozen balances (v2)", async () => {
    handler = (req, _body, res) => {
      const url = req.url ?? "";
      if (url === "/wallet/getaccount") {
        jsonOk(res, {
          address: FOUNDATION_HEX,
          balance: 10_000_000,
          frozenV2: [
            { amount: 5_000_000, type: "BANDWIDTH" },
            { amount: 3_000_000, type: "ENERGY" },
          ],
        });
      } else {
        jsonOk(res, {});
      }
    };

    const collector = new TronAccountCollector(httpClient());
    const result = await collector.collect({ address: FOUNDATION_HEX });

    expect(result.frozenBalanceSun).toBe("8000000");
  });

  it("throws on nonexistent account", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {});
    };

    const collector = new TronAccountCollector(httpClient());
    await expect(
      collector.collect({ address: FOUNDATION_BASE58 }),
    ).rejects.toThrow("Account not found");
  });

  it("supports both hex and base58 addresses", () => {
    const collector = new TronAccountCollector(httpClient());
    expect(collector.supports({ address: FOUNDATION_HEX })).toBe(true);
    expect(collector.supports({ address: FOUNDATION_BASE58 })).toBe(true);
    expect(collector.supports({ address: "invalid" })).toBe(false);
  });

  it("has correct metadata", () => {
    const collector = new TronAccountCollector(httpClient());
    expect(collector.collectorName).toBe("tron-account-trongrid");
    expect(collector.sourceName).toBe("trongrid");
    expect(collector.sourceType).toBe("API");
  });
});

// ── TronScan Account Collector ──

describe("TronScanAccountCollector", () => {
  it("collects account data from TronScan API", async () => {
    handler = (req, _body, res) => {
      const url = req.url ?? "";
      if (url.includes("/api/accountv2")) {
        jsonOk(res, {
          address: FOUNDATION_BASE58,
          balance: 25_000_000,
          create_time: 1_529_990_700_000,
          latest_operation_time: 1_700_000_000_000,
          accountType: 0,
          name: "Foundation",
          totalFrozen: 10_000_000,
          delegatedFrozen: 2_000_000,
          bandwidth: {
            freeNetLimit: 600,
            freeNetUsed: 50,
            netLimit: 500,
            netUsed: 100,
            energyLimit: 30000,
            energyUsed: 5000,
          },
          withPriceTokens: [
            {
              tokenId: FOUNDATION_BASE58,
              tokenAbbr: "USDT",
              tokenName: "Tether USD",
              balance: "1000000000",
              tokenDecimal: 6,
              tokenType: "trc20",
            },
            {
              tokenId: "1000001",
              tokenAbbr: "TRX",
              tokenName: "Tronix",
              balance: "25000000",
              tokenDecimal: 6,
              tokenType: "trc10",
            },
          ],
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const collector = new TronScanAccountCollector(httpClient());
    const result = await collector.collect({ address: FOUNDATION_BASE58 });

    expect(result.address).toBe(FOUNDATION_BASE58);
    expect(result.balanceSun).toBe("25000000");
    expect(result.balanceTrx).toBe("25");
    expect(result.accountName).toBe("Foundation");
    expect(result.frozenBalanceSun).toBe("10000000");
    expect(result.delegatedFrozenBalanceSun).toBe("2000000");
    expect(result.energyLimit).toBe(30000);
    expect(result.trc20Balances).toHaveLength(1);
    expect(result.trc20Balances[0]!.symbol).toBe("USDT");
    expect(result.isContract).toBe(false);
    expect(result.source).toBe("tronscan");
  });

  it("detects contract accounts", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        address: FOUNDATION_BASE58,
        accountType: 2,
      });
    };

    const collector = new TronScanAccountCollector(httpClient());
    const result = await collector.collect({ address: FOUNDATION_BASE58 });

    expect(result.isContract).toBe(true);
  });

  it("throws on nonexistent account", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {});
    };

    const collector = new TronScanAccountCollector(httpClient());
    await expect(
      collector.collect({ address: FOUNDATION_BASE58 }),
    ).rejects.toThrow("Account not found");
  });

  it("has correct metadata", () => {
    const collector = new TronScanAccountCollector(httpClient());
    expect(collector.collectorName).toBe("tron-account-tronscan");
    expect(collector.sourceName).toBe("tronscan");
    expect(collector.sourceType).toBe("EXPLORER");
  });
});
