import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { Trc20RankingsCollector } from "../src/blockchain/trc20-rankings-collector.js";

function tokenListResponse() {
  return {
    tokens: [
      {
        contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        name: "Tether USD",
        abbr: "USDT",
        decimals: 6,
        holderCount: 50_000_000,
        transferCount: 2_000_000_000,
        totalSupply: "40000000000000000",
        market_cap: 60_000_000_000,
        priceInUsd: 1.0,
      },
      {
        contractAddress: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
        name: "USD Coin",
        abbr: "USDC",
        decimals: 6,
        holderCount: 2_000_000,
        transferCount: 100_000_000,
        totalSupply: "500000000000000",
        market_cap: 500_000_000,
        priceInUsd: 1.0,
      },
      {
        contractAddress: "TSmallToken111111111111111111111111",
        name: "SmallToken",
        abbr: "SMLT",
        decimals: 18,
        holderCount: 5000,
        transferCount: 200_000,
        totalSupply: "1000000000000000000000000",
        market_cap: 100_000,
        priceInUsd: 0.01,
      },
    ],
    total: 3,
  };
}

function tokenHoldersResponse(contract: string) {
  // TronScan v2 API wraps holders in `trc20_tokens`, not `data`.
  // The real API does NOT return `balance_num` — only the raw `balance` string
  // in smallest token units.  balanceNum is computed client-side via BigInt.
  const holders: Record<string, object> = {
    TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: {
      trc20_tokens: [
        { holder_address: "THolderA1", balance: "8000000000000" },
        { holder_address: "THolderA2", balance: "3000000000000" },
        { holder_address: "THolderA3", balance: "2000000000000" },
      ],
    },
    TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: {
      trc20_tokens: [
        { holder_address: "THolderB1", balance: "100000000000" },
        { holder_address: "THolderB2", balance: "50000000000" },
      ],
    },
    TSmallToken111111111111111111111111: {
      trc20_tokens: [
        { holder_address: "THolderC1", balance: "900000000000000000000000" },
        { holder_address: "THolderC2", balance: "50000000000000000000000" },
      ],
    },
  };
  return holders[contract] ?? { trc20_tokens: [] };
}

let server: Server;

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function stopServer(): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("Trc20RankingsCollector", () => {
  afterEach(async () => {
    if (server) await stopServer();
  });

  it("collects top tokens and analyzes holder distribution", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      const path = url.pathname;

      if (path === "/api/token/all") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenListResponse()));
      } else if (path === "/api/token_trc20/holders") {
        const contract = url.searchParams.get("contract_address") ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenHoldersResponse(contract)));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new Trc20RankingsCollector(client, 3);
    const data = await collector.collect();

    expect(data.topTokens).toHaveLength(3);
    expect(data.topTokens[0]!.symbol).toBe("USDT");
    expect(data.topTokens[0]!.holderCount).toBe(50_000_000);
    expect(data.topTokens[0]!.marketCap).toBe(60_000_000_000);

    expect(data.tokenAnalyses).toHaveLength(3);
    expect(data.tokenAnalyses[0]!.topHolders).toHaveLength(3);
    expect(data.tokenAnalyses[0]!.topHolders[0]!.address).toBe("THolderA1");
    expect(data.tokenAnalyses[0]!.topHolders[0]!.balanceNum).toBe(8_000_000);
    expect(data.tokenAnalyses[0]!.totalSupplyNum).toBe(40_000_000_000);

    expect(data.source).toBe("tronscan");
  });

  it("falls back to well-known tokens when TronScan listing fails", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new Trc20RankingsCollector(client);
    const data = await collector.collect();

    // Fallback provides well-known tokens even when the listing API fails
    expect(data.topTokens.length).toBeGreaterThan(0);
    expect(data.topTokens[0]!.symbol).toBe("USDT");

    // C-02: source must be "hardcoded-fallback" when using static token list
    expect(data.source).toBe("hardcoded-fallback");

    // Holder fetching also fails (500), so analyses exist but with empty holders
    expect(data.tokenAnalyses.length).toBeGreaterThan(0);
    for (const analysis of data.tokenAnalyses) {
      expect(analysis.topHolders).toHaveLength(0);
    }
  });

  it("handles missing holder data gracefully", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname === "/api/token/all") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenListResponse()));
      } else if (url.pathname === "/api/token_trc20/holders") {
        res.writeHead(500);
        res.end("error");
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new Trc20RankingsCollector(client, 2);
    const data = await collector.collect();

    expect(data.topTokens).toHaveLength(3);
    expect(data.tokenAnalyses).toHaveLength(2);
    expect(data.tokenAnalyses[0]!.topHolders).toHaveLength(0);
  });

  it("parses totalSupply with decimals correctly", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname === "/api/token/all") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          tokens: [{
            contractAddress: "TTest1",
            name: "TestToken",
            abbr: "TST",
            decimals: 8,
            holderCount: 100,
            transferCount: 500,
            totalSupply: "2100000000000000",
            market_cap: 50000,
            priceInUsd: 0.5,
          }],
        }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new Trc20RankingsCollector(client, 1);
    const data = await collector.collect();

    expect(data.tokenAnalyses[0]!.totalSupplyNum).toBe(21_000_000);
  });

  it("computes balanceNum from balance string via BigInt (no balance_num from API)", async () => {
    // Regression test for C-01 / H-04 / H-05:
    // The real TronScan API does NOT return balance_num — only a raw balance string
    // in smallest token units.  For 18-decimal tokens the raw string exceeds
    // Number.MAX_SAFE_INTEGER, so BigInt parsing is mandatory.
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname === "/api/token/all") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          tokens: [{
            contractAddress: "TBigToken1111111111111111111111111",
            name: "BigDecimalToken",
            abbr: "BDT",
            decimals: 18,
            holderCount: 1000,
            transferCount: 5000,
            // 30-digit totalSupply — way beyond Number.MAX_SAFE_INTEGER (≈9×10^15)
            totalSupply: "990000000000000000000000000000",
            market_cap: 1_000_000,
            priceInUsd: 0.001,
          }],
        }));
      } else if (url.pathname === "/api/token_trc20/holders") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // Holder balance is a 25-digit string — BigInt required
        res.end(JSON.stringify({
          trc20_tokens: [
            { holder_address: "TBigHolder1", balance: "5000000000000000000000000" },
            { holder_address: "TBigHolder2", balance: "123456789012345678901234" },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new Trc20RankingsCollector(client, 1);
    const data = await collector.collect();

    // totalSupply: 990000000000000000000000000000 / 10^18 = 990_000_000_000
    expect(data.tokenAnalyses[0]!.totalSupplyNum).toBe(990_000_000_000);

    // Holder 1: 5000000000000000000000000 / 10^18 = 5_000_000
    expect(data.tokenAnalyses[0]!.topHolders[0]!.balanceNum).toBe(5_000_000);

    // Holder 2: 123456789012345678901234 / 10^18 ≈ 123456.789012345678901234
    const holder2 = data.tokenAnalyses[0]!.topHolders[1]!.balanceNum;
    expect(holder2).toBeGreaterThan(123456);
    expect(holder2).toBeLessThan(123457);
  });

  it("respects analyzeTopN limit", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname === "/api/token/all") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenListResponse()));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new Trc20RankingsCollector(client, 1);
    const data = await collector.collect();

    expect(data.topTokens).toHaveLength(3);
    expect(data.tokenAnalyses).toHaveLength(1);
    expect(data.tokenAnalyses[0]!.token.symbol).toBe("USDT");
  });
});
