import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { TronScanTokenCollector } from "../src/blockchain/tronscan-token-collector.js";
import { TronGridTokenCollector } from "../src/blockchain/tron-token-collector.js";

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

const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

// ── TronScan Token Collector ──

describe("TronScanTokenCollector", () => {
  it("collects TRC20 token info from TronScan", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        trc20_tokens: [
          {
            contract_address: USDT_BASE58,
            name: "Tether USD",
            symbol: "USDT",
            decimals: 6,
            total_supply: "40000000000000000",
            holders_count: 50_000_000,
            transfer_num: 2_000_000_000,
            icon_url: "https://example.com/usdt.png",
            description: "Tether stablecoin on TRON",
            issue_address: USDT_BASE58,
            price: 1.0,
            market_cap: 40_000_000_000,
            volume_24h: 1_500_000_000,
          },
        ],
      });
    };

    const collector = new TronScanTokenCollector(httpClient());
    const result = await collector.collect({ contractAddress: USDT_BASE58 });

    expect(result.contractAddress).toBe(USDT_BASE58);
    expect(result.name).toBe("Tether USD");
    expect(result.symbol).toBe("USDT");
    expect(result.decimals).toBe(6);
    expect(result.totalSupply).toBe("40000000000000000");
    expect(result.holderCount).toBe(50_000_000);
    expect(result.transferCount).toBe(2_000_000_000);
    expect(result.priceUsd).toBe(1.0);
    expect(result.marketCapUsd).toBe(40_000_000_000);
    expect(result.volume24hUsd).toBe(1_500_000_000);
    expect(result.issuerAddress).toBe(USDT_BASE58);
    expect(result.source).toBe("tronscan");
  });

  it("throws on nonexistent token", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, { trc20_tokens: [] });
    };

    const collector = new TronScanTokenCollector(httpClient());
    await expect(
      collector.collect({ contractAddress: USDT_BASE58 }),
    ).rejects.toThrow("Token not found");
  });

  it("handles missing optional fields", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        trc20_tokens: [
          {
            contract_address: USDT_BASE58,
            name: "MinimalToken",
            symbol: "MIN",
          },
        ],
      });
    };

    const collector = new TronScanTokenCollector(httpClient());
    const result = await collector.collect({ contractAddress: USDT_BASE58 });

    expect(result.decimals).toBe(0);
    expect(result.totalSupply).toBe("0");
    expect(result.holderCount).toBe(0);
    expect(result.priceUsd).toBeNull();
    expect(result.iconUrl).toBeNull();
  });

  it("supports hex and base58 addresses", () => {
    const collector = new TronScanTokenCollector(httpClient());
    expect(collector.supports({ contractAddress: USDT_BASE58 })).toBe(true);
    expect(collector.supports({ contractAddress: USDT_HEX })).toBe(true);
    expect(collector.supports({ contractAddress: "invalid" })).toBe(false);
  });

  it("has correct metadata", () => {
    const collector = new TronScanTokenCollector(httpClient());
    expect(collector.collectorName).toBe("tron-token-tronscan");
    expect(collector.sourceName).toBe("tronscan");
    expect(collector.sourceType).toBe("EXPLORER");
  });
});

// ── TronGrid Token Collector ──

function abiEncodeString(value: string): string {
  const utf8 = Buffer.from(value, "utf8");
  const offset = "0000000000000000000000000000000000000000000000000000000000000020";
  const length = utf8.length.toString(16).padStart(64, "0");
  const dataHex = utf8.toString("hex").padEnd(Math.ceil(utf8.length / 32) * 64, "0");
  return offset + length + dataHex;
}

function abiEncodeUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

describe("TronGridTokenCollector", () => {
  it("collects TRC20 token info via constant calls", async () => {
    const nameEncoded = abiEncodeString("Tether USD");
    const symbolEncoded = abiEncodeString("USDT");
    const decimalsEncoded = abiEncodeUint(6n);
    const totalSupplyEncoded = abiEncodeUint(40_000_000_000_000_000n);

    let callIndex = 0;
    handler = (_req, body, res) => {
      const parsed = JSON.parse(body);
      const data = parsed.data as string;

      let result: string;
      if (data === "06fdde03") result = nameEncoded;
      else if (data === "95d89b41") result = symbolEncoded;
      else if (data === "313ce567") result = decimalsEncoded;
      else if (data === "18160ddd") result = totalSupplyEncoded;
      else result = "";

      callIndex++;
      jsonOk(res, {
        result: { result: true },
        constant_result: [result],
      });
    };

    const collector = new TronGridTokenCollector(httpClient());
    const result = await collector.collect({ contractAddress: USDT_BASE58 });

    expect(result.name).toBe("Tether USD");
    expect(result.symbol).toBe("USDT");
    expect(result.decimals).toBe(6);
    expect(result.totalSupply).toBe("40000000000000000");
    expect(result.source).toBe("trongrid");
    expect(callIndex).toBe(4);
  });

  it("throws when contract has no name or symbol", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {
        result: { result: false },
        constant_result: [],
      });
    };

    const collector = new TronGridTokenCollector(httpClient());
    await expect(
      collector.collect({ contractAddress: USDT_BASE58 }),
    ).rejects.toThrow("does not appear to be a TRC20 token");
  });

  it("has correct metadata", () => {
    const collector = new TronGridTokenCollector(httpClient());
    expect(collector.collectorName).toBe("tron-token-trongrid");
    expect(collector.sourceName).toBe("trongrid");
    expect(collector.sourceType).toBe("API");
  });
});
