import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { NetworkMetricsCollector } from "../src/blockchain/network-metrics-collector.js";

function chainParamsResponse() {
  return {
    chainParameter: [
      { key: "getEnergyFee", value: 420 },
      { key: "getTotalEnergyLimit", value: 50_000_000_000 },
      { key: "getTotalEnergyWeight", value: 30_000_000_000_000 },
      { key: "getDynamicEnergyIncreaseFactor", value: 2000 },
      { key: "getDynamicEnergyMaxFactor", value: 12000 },
      { key: "getTransactionFee", value: 1000 },
      { key: "getTotalNetLimit", value: 43_200_000_000 },
      { key: "getTotalNetWeight", value: 15_000_000_000_000 },
      { key: "getCreateAccountFee", value: 100_000 },
      { key: "getBurnTrxAmount", value: 1_000_000 },
      { key: "getWitnessPayPerBlock", value: 16_000_000 },
      { key: "getWitness127PayPerBlock", value: 160_000 },
      { key: "getMaintenanceTimeInterval", value: 21_600_000 },
      { key: "getProposalExpireTime", value: 259_200_000 },
    ],
  };
}

function accountListResponse() {
  return {
    data: [
      { address: "TWhale1", balance: 50_000_000_000_000, totalFrozenV2: 10_000_000_000_000, power: 10_000_000 },
      { address: "TWhale2", balance: 30_000_000_000_000, totalFrozenV2: 5_000_000_000_000, power: 5_000_000 },
      { address: "TWhale3", balance: 20_000_000_000_000, totalFrozenV2: 0, power: 0 },
    ],
    total: 3,
  };
}

let server: Server;
let port: number;

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("NetworkMetricsCollector", () => {
  afterEach(async () => {
    if (server) await stopServer();
  });

  it("collects chain parameters and computes energy/bandwidth yields", async () => {
    await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      if (url === "/wallet/getchainparameters") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chainParamsResponse()));
      } else if (url === "/wallet/getaccountresource") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(client);
    const metrics = await collector.collect();

    expect(metrics.energy.energyFee).toBe(420);
    expect(metrics.energy.totalEnergyLimit).toBe(50_000_000_000);
    expect(metrics.energy.totalEnergyWeight).toBe(30_000_000_000_000);
    expect(metrics.energy.dynamicIncreaseFactor).toBe(2000);
    expect(metrics.energy.dynamicMaxFactor).toBe(12000);
    expect(metrics.energy.energyYieldPerTrx).toBeGreaterThan(0);

    expect(metrics.bandwidth.transactionFee).toBe(1000);
    expect(metrics.bandwidth.totalNetLimit).toBe(43_200_000_000);
    expect(metrics.bandwidth.bandwidthYieldPerTrx).toBeGreaterThan(0);

    expect(metrics.economics.createAccountFee).toBe(100_000);
    expect(metrics.economics.witnessPayPerBlock).toBe(16_000_000);
    expect(metrics.economics.maintenanceIntervalMs).toBe(21_600_000);
  });

  it("computes energy yield as totalEnergyLimit / (totalEnergyWeight / 1M)", async () => {
    await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        chainParameter: [
          { key: "getTotalEnergyLimit", value: 100_000 },
          { key: "getTotalEnergyWeight", value: 2_000_000 },
        ],
      }));
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(client);
    const metrics = await collector.collect();

    expect(metrics.energy.energyYieldPerTrx).toBe(50000);
  });

  it("returns zero yield when weight is zero from both sources", async () => {
    await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const url = req.url?.split("?")[0];
      if (url === "/wallet/getaccountresource") {
        res.end(JSON.stringify({ TotalEnergyWeight: 0, TotalNetWeight: 0 }));
      } else {
        res.end(JSON.stringify({
          chainParameter: [
            { key: "getTotalEnergyLimit", value: 100_000 },
            { key: "getTotalEnergyWeight", value: 0 },
          ],
        }));
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(client);
    const metrics = await collector.collect();

    expect(metrics.energy.energyYieldPerTrx).toBe(0);
    expect(metrics.bandwidth.bandwidthYieldPerTrx).toBe(0);
  });

  it("falls back to getaccountresource globals when getchainparameters returns zero weights", async () => {
    await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url === "/wallet/getchainparameters") {
        res.end(JSON.stringify({
          chainParameter: [
            { key: "getEnergyFee", value: 100 },
            { key: "getTotalEnergyLimit", value: 180_000_000_000 },
            { key: "getTotalEnergyWeight", value: 0 },
            { key: "getTotalNetLimit", value: 43_200_000_000 },
            { key: "getTotalNetWeight", value: 0 },
            { key: "getWitnessPayPerBlock", value: 16_000_000 },
            { key: "getWitness127PayPerBlock", value: 160_000 },
          ],
        }));
      } else if (url === "/wallet/getaccountresource") {
        res.end(JSON.stringify({
          TotalEnergyLimit: 180_000_000_000,
          TotalEnergyWeight: 18_800_000_000,
          TotalNetLimit: 43_200_000_000,
          TotalNetWeight: 9_500_000_000,
        }));
      } else {
        res.end("{}");
      }
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(client);
    const metrics = await collector.collect();

    expect(metrics.energy.totalEnergyWeight).toBe(18_800_000_000);
    expect(metrics.bandwidth.totalNetWeight).toBe(9_500_000_000);
    expect(metrics.energy.energyYieldPerTrx).toBeGreaterThan(0);
    expect(metrics.bandwidth.bandwidthYieldPerTrx).toBeGreaterThan(0);
    // 28.3B TRX staked / ~86.6B supply ≈ 32.7%
    expect(metrics.stakingRatio).toBeCloseTo(0.3268, 3);
  });

  it("fetches top holders from TronScan", async () => {
    await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      if (url === "/wallet/getchainparameters") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chainParamsResponse()));
      } else if (url === "/api/account/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(accountListResponse()));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(gridClient, scanClient);
    const metrics = await collector.collect();

    expect(metrics.topHolders).toHaveLength(3);
    expect(metrics.topHolders[0]!.address).toBe("TWhale1");
    expect(metrics.topHolders[0]!.balance).toBe(50_000_000);
    expect(metrics.topHolders[0]!.totalFrozen).toBe(10_000_000);
    expect(metrics.topHolders[1]!.balance).toBe(30_000_000);
  });

  it("returns empty holders when TronScan is unavailable", async () => {
    await startServer((req, res) => {
      const url = req.url?.split("?")[0];
      if (url === "/wallet/getchainparameters") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chainParamsResponse()));
      } else {
        res.writeHead(500);
        res.end("Internal error");
      }
    });

    const gridClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const scanClient = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(gridClient, scanClient);
    const metrics = await collector.collect();

    expect(metrics.topHolders).toHaveLength(0);
    expect(metrics.energy.energyFee).toBe(420);
  });

  it("returns empty holders when no TronScan client provided", async () => {
    await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chainParamsResponse()));
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(client);
    const metrics = await collector.collect();

    expect(metrics.topHolders).toHaveLength(0);
  });

  it("sets source and collectedAt", async () => {
    await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chainParamsResponse()));
    });

    const client = new TronHttpClient({ endpoint: `http://127.0.0.1:${port}` });
    const collector = new NetworkMetricsCollector(client);
    const before = new Date();
    const metrics = await collector.collect();

    expect(metrics.source).toBe("trongrid+tronscan");
    expect(metrics.collectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
