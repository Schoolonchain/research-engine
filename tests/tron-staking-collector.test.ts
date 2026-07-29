import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { TronStakingCollector } from "../src/blockchain/tron-staking-collector.js";

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

const ACCOUNT_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const ACCOUNT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const WITNESS_HEX = "410000000000000000000000000000000000000001";

describe("TronStakingCollector", () => {
  it("collects staking data from TronGrid", async () => {
    handler = (req, _body, res) => {
      const url = req.url ?? "";
      if (url === "/wallet/getaccount") {
        jsonOk(res, {
          frozenV2: [
            { amount: 10_000_000, type: "BANDWIDTH" },
            { amount: 5_000_000, type: "ENERGY" },
          ],
          delegated_frozen_balance_for_bandwidth: 2_000_000,
          account_resource: {
            delegated_frozen_balance_for_energy: 1_000_000,
          },
          votes: [
            { vote_address: WITNESS_HEX, vote_count: 15 },
          ],
        });
      } else if (url === "/wallet/getcanwithdrawunfreezeamount") {
        jsonOk(res, { amount: 500_000 });
      } else if (url === "/wallet/getReward") {
        jsonOk(res, { reward: 100_000 });
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const collector = new TronStakingCollector(httpClient());
    const result = await collector.collect({ address: ACCOUNT_BASE58 });

    expect(result.address).toBe(ACCOUNT_BASE58);
    expect(result.frozenBalanceV2Sun).toBe("15000000");
    expect(result.frozenBandwidthSun).toBe("10000000");
    expect(result.frozenEnergySun).toBe("5000000");
    expect(result.delegatedBandwidthSun).toBe("2000000");
    expect(result.delegatedEnergySun).toBe("1000000");
    expect(result.canWithdrawSun).toBe("500000");
    expect(result.rewardsPendingSun).toBe("100000");
    expect(result.tronPower).toBe(15);
    expect(result.votedWitnesses).toHaveLength(1);
    expect(result.votedWitnesses[0]!.votes).toBe(15);
    expect(result.source).toBe("trongrid");
  });

  it("handles account with no staking", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {});
    };

    const collector = new TronStakingCollector(httpClient());
    const result = await collector.collect({ address: ACCOUNT_BASE58 });

    expect(result.frozenBalanceV2Sun).toBe("0");
    expect(result.delegatedBandwidthSun).toBe("0");
    expect(result.canWithdrawSun).toBe("0");
    expect(result.rewardsPendingSun).toBe("0");
    expect(result.votedWitnesses).toHaveLength(0);
  });

  it("has correct metadata", () => {
    const collector = new TronStakingCollector(httpClient());
    expect(collector.collectorName).toBe("tron-staking-trongrid");
    expect(collector.sourceName).toBe("trongrid");
    expect(collector.sourceType).toBe("API");
  });
});
