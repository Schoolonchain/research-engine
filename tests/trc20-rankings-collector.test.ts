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
  const holders: Record<string, object> = {
    TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: {
      data: [
        { holder_address: "THolderA1", balance: "8000000000000", balance_num: 8_000_000 },
        { holder_address: "THolderA2", balance: "3000000000000", balance_num: 3_000_000 },
        { holder_address: "THolderA3", balance: "2000000000000", balance_num: 2_000_000 },
      ],
    },
    TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: {
      data: [
        { holder_address: "THolderB1", balance: "100000000000", balance_num: 100_000 },
        { holder_address: "THolderB2", balance: "50000000000", balance_num: 50_000 },
      ],
    },
    TSmallToken111111111111111111111111: {
      data: [
        { holder_address: "THolderC1", balance: "900000000000000000000000", balance_num: 900_000 },
        { holder_address: "THolderC2", balance: "50000000000000000000000", balance_num: 50_000 },
      ],
    },
  };
  return holders[contract] ?? { data: [] };
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
      } else if (path === "/api/tokenholders") {
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

  it("returns empty when TronScan fails", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new Trc20RankingsCollector(client);
    const data = await collector.collect();

    expect(data.topTokens).toHaveLength(0);
    expect(data.tokenAnalyses).toHaveLength(0);
  });

  it("handles missing holder data gracefully", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname === "/api/token/all") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenListResponse()));
      } else if (url.pathname === "/api/tokenholders") {
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
