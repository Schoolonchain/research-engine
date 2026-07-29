import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import {
  EnergyRentalCollector,
  KNOWN_PLATFORMS,
} from "../src/blockchain/energy-rental-collector.js";

function transfersResponse(direction: "from" | "to") {
  if (direction === "from") {
    return {
      data: [
        { transaction_id: "tx1", from: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf", to: "TProvider1", amount: 5_000_000, block_timestamp: 1700000000000 },
        { transaction_id: "tx2", from: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf", to: "TProvider2", amount: 3_000_000, block_timestamp: 1699999000000 },
        { transaction_id: "tx3", from: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf", to: "TProvider1", amount: 2_000_000, block_timestamp: 1699998000000 },
      ],
      total: 3,
    };
  }
  return {
    data: [
      { transaction_id: "tx4", from: "TBuyer1", to: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf", amount: 8_000_000, block_timestamp: 1700000500000 },
      { transaction_id: "tx5", from: "TBuyer2", to: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf", amount: 4_000_000, block_timestamp: 1699999500000 },
    ],
    total: 2,
  };
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

function fullHandler(port: number) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      if (path === "/api/transfer/trx") {
        const fromParam = url.searchParams.get("from");
        const direction = fromParam ? "from" : "to";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(transfersResponse(direction)));
      } else if (path === "/wallet/getdelegatedresourceaccountindexV2") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          account: "TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf",
          toAccounts: ["TConsumer1", "TConsumer2", "TConsumer3"],
          fromAccounts: ["TProvider1", "TProvider2", "TProvider3", "TProvider4", "TProvider5"],
        }));
      } else if (path === "/wallet/getaccountresource") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          EnergyLimit: 500_000_000,
          EnergyUsed: 200_000_000,
          NetLimit: 50_000,
          NetUsed: 10_000,
          freeNetLimit: 600,
          freeNetUsed: 100,
        }));
      } else if (path === "/api/accountv2") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ balance: 15_000_000_000 }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  };
}

describe("EnergyRentalCollector", () => {
  afterEach(async () => {
    if (server) await stopServer();
  });

  it("collects platform activity with transfers and delegation data", async () => {
    const port = await startServer(fullHandler(0));
    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new EnergyRentalCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.platforms).toHaveLength(1);
    const brutus = data.platforms[0]!;
    expect(brutus.platform.name).toBe("Brutus Finance");

    expect(brutus.outgoingTransfers).toHaveLength(3);
    expect(brutus.outgoingVolume).toBe(10);
    expect(brutus.incomingTransfers).toHaveLength(2);
    expect(brutus.incomingVolume).toBe(12);

    expect(brutus.uniquePayees).toBe(2);
    expect(brutus.uniquePayers).toBe(2);

    expect(brutus.delegation.delegatedToCount).toBe(3);
    expect(brutus.delegation.receivedFromCount).toBe(5);

    expect(brutus.resources.energyLimit).toBe(500_000_000);
    expect(brutus.resources.energyUsed).toBe(200_000_000);

    expect(brutus.accountBalance).toBe(15_000);

    expect(data.source).toBe("trongrid+tronscan");
  });

  it("converts transfer amounts from SUN to TRX", async () => {
    const port = await startServer(fullHandler(0));
    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new EnergyRentalCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.platforms[0]!.outgoingTransfers[0]!.amount).toBe(5);
    expect(data.platforms[0]!.outgoingTransfers[1]!.amount).toBe(3);
  });

  it("handles TronScan transfer API failure gracefully", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (url.pathname === "/api/transfer/trx") {
          res.writeHead(500);
          res.end("error");
        } else if (url.pathname === "/api/accountv2") {
          res.writeHead(500);
          res.end("error");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new EnergyRentalCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.platforms).toHaveLength(1);
    expect(data.platforms[0]!.outgoingTransfers).toHaveLength(0);
    expect(data.platforms[0]!.incomingTransfers).toHaveLength(0);
    expect(data.platforms[0]!.accountBalance).toBe(0);
  });

  it("handles TronGrid delegation API failure gracefully", async () => {
    const port = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (url.pathname.startsWith("/wallet/")) {
          res.writeHead(500);
          res.end("error");
        } else if (url.pathname === "/api/transfer/trx") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
        } else if (url.pathname === "/api/accountv2") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ balance: 1_000_000 }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new EnergyRentalCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.platforms[0]!.delegation.delegatedToCount).toBe(0);
    expect(data.platforms[0]!.delegation.receivedFromCount).toBe(0);
    expect(data.platforms[0]!.resources.energyLimit).toBe(0);
    expect(data.platforms[0]!.accountBalance).toBe(1);
  });

  it("supports custom platform list", async () => {
    const port = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      });
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const customPlatforms = [
      { name: "Platform A", paymentAddress: "TCustomA" },
      { name: "Platform B", paymentAddress: "TCustomB" },
    ];
    const collector = new EnergyRentalCollector(gridClient, scanClient, customPlatforms);
    const data = await collector.collect();

    expect(data.platforms).toHaveLength(2);
    expect(data.platforms[0]!.platform.name).toBe("Platform A");
    expect(data.platforms[1]!.platform.name).toBe("Platform B");
  });

  it("exports KNOWN_PLATFORMS with Brutus Finance", () => {
    expect(KNOWN_PLATFORMS).toHaveLength(1);
    expect(KNOWN_PLATFORMS[0]!.name).toBe("Brutus Finance");
    expect(KNOWN_PLATFORMS[0]!.paymentAddress).toBe("TPrLC5L3qTVXmKS14ht9UrJX8MCZ19Zgmf");
  });
});
