import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { ResourceRankingsCollector } from "../src/blockchain/resource-rankings-collector.js";

function accountListResponse() {
  return {
    data: [
      {
        address: "TStaker1",
        balance: 500_000_000_000_000,
        totalFrozenV2: 300_000_000_000_000,
        frozenForEnergyV2: 200_000_000_000_000,
        frozenForBandWidthV2: 100_000_000_000_000,
        power: 300_000_000,
      },
      {
        address: "TStaker2",
        balance: 200_000_000_000_000,
        totalFrozenV2: 150_000_000_000_000,
        frozenForEnergyV2: 100_000_000_000_000,
        frozenForBandWidthV2: 50_000_000_000_000,
        power: 150_000_000,
      },
      {
        address: "TStaker3",
        balance: 100_000_000_000_000,
        totalFrozenV2: 0,
        frozenForEnergyV2: 0,
        frozenForBandWidthV2: 0,
        power: 0,
      },
    ],
    total: 3,
  };
}

function accountResourceResponse(address: string) {
  const resources: Record<string, object> = {
    TStaker1: { EnergyLimit: 50_000_000, EnergyUsed: 30_000_000, NetLimit: 10_000, NetUsed: 5_000, freeNetLimit: 600, freeNetUsed: 100 },
    TStaker2: { EnergyLimit: 20_000_000, EnergyUsed: 100_000, NetLimit: 5_000, NetUsed: 1_000, freeNetLimit: 600, freeNetUsed: 50 },
    TStaker3: { EnergyLimit: 0, EnergyUsed: 0, NetLimit: 0, NetUsed: 0, freeNetLimit: 600, freeNetUsed: 0 },
  };
  return resources[address] ?? {};
}

function delegationIndexResponse(address: string) {
  const delegations: Record<string, object> = {
    TStaker1: { account: address, toAccounts: ["TDel1", "TDel2", "TDel3"], fromAccounts: [] },
    TStaker2: { account: address, toAccounts: [], fromAccounts: ["TFrom1", "TFrom2"] },
    TStaker3: { account: address, toAccounts: [], fromAccounts: [] },
  };
  return delegations[address] ?? { account: address };
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
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("ResourceRankingsCollector", () => {
  afterEach(async () => {
    if (server) await stopServer();
  });

  it("collects top stakers with energy data and delegation summaries", async () => {
    const port = await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (url === "/api/account/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(accountListResponse()));
        } else if (url === "/wallet/getaccountresource") {
          const parsed = JSON.parse(body) as { address: string };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(accountResourceResponse(parsed.address)));
        } else if (url === "/wallet/getdelegatedresourceaccountindexV2") {
          const parsed = JSON.parse(body) as { value: string };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(delegationIndexResponse(parsed.value)));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new ResourceRankingsCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.topStakers).toHaveLength(3);
    expect(data.topStakers[0]!.address).toBe("TStaker1");
    expect(data.topStakers[0]!.balance).toBe(500_000_000);
    expect(data.topStakers[0]!.frozenForEnergy).toBe(200_000_000);
    expect(data.topStakers[0]!.frozenForBandwidth).toBe(100_000_000);
    expect(data.topStakers[0]!.energyLimit).toBe(50_000_000);
    expect(data.topStakers[0]!.energyUsed).toBe(30_000_000);
    expect(data.topStakers[0]!.bandwidthLimit).toBe(10_600);
    expect(data.topStakers[0]!.bandwidthUsed).toBe(5_100);

    expect(data.delegationSummaries).toHaveLength(3);
    expect(data.delegationSummaries[0]!.delegatedToCount).toBe(3);
    expect(data.delegationSummaries[0]!.receivedFromCount).toBe(0);
    expect(data.delegationSummaries[1]!.delegatedToCount).toBe(0);
    expect(data.delegationSummaries[1]!.receivedFromCount).toBe(2);

    expect(data.source).toBe("trongrid+tronscan");
  });

  it("returns empty when no TronScan client provided", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new ResourceRankingsCollector(gridClient);
    const data = await collector.collect();

    expect(data.topStakers).toHaveLength(0);
    expect(data.delegationSummaries).toHaveLength(0);
  });

  it("returns empty stakers when TronScan fails", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal error");
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new ResourceRankingsCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.topStakers).toHaveLength(0);
    expect(data.delegationSummaries).toHaveLength(0);
  });

  it("handles missing energy data gracefully", async () => {
    const port = await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (url === "/api/account/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(accountListResponse()));
        } else if (url === "/wallet/getaccountresource") {
          res.writeHead(500);
          res.end("error");
        } else if (url === "/wallet/getdelegatedresourceaccountindexV2") {
          res.writeHead(500);
          res.end("error");
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const collector = new ResourceRankingsCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.topStakers).toHaveLength(3);
    expect(data.topStakers[0]!.energyLimit).toBe(0);
    expect(data.topStakers[0]!.energyUsed).toBe(0);

    expect(data.delegationSummaries).toHaveLength(3);
    expect(data.delegationSummaries[0]!.delegatedToCount).toBe(0);
  });

  it("converts balances from SUN to TRX", async () => {
    const port = await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (url === "/api/account/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            data: [{
              address: "TConvert1",
              balance: 5_500_000,
              frozenForEnergyV2: 3_000_000,
              frozenForBandWidthV2: 1_000_000,
              power: 100,
            }],
          }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new ResourceRankingsCollector(gridClient, scanClient);
    const data = await collector.collect();

    expect(data.topStakers[0]!.balance).toBe(5.5);
    expect(data.topStakers[0]!.frozenForEnergy).toBe(3);
    expect(data.topStakers[0]!.frozenForBandwidth).toBe(1);
  });
});
