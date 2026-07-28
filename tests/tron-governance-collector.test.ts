import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { TronGovernanceCollector } from "../src/blockchain/tron-governance-collector.js";

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

const WITNESS_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const WITNESS_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe("TronGovernanceCollector", () => {
  it("collects governance data from TronGrid", async () => {
    handler = (req, _body, res) => {
      const url = (req.url ?? "").split("?")[0]!;
      if (url === "/wallet/listwitnesses") {
        jsonOk(res, {
          witnesses: [
            {
              address: WITNESS_HEX,
              url: "https://example.com/sr1",
              isJobs: true,
              voteCount: 100_000_000,
              totalProduced: 50000,
              totalMissed: 500,
              latestBlockNum: 60_000_000,
            },
            {
              address: "410000000000000000000000000000000000000001",
              url: "https://example.com/sr2",
              isJobs: false,
              voteCount: 50_000_000,
              totalProduced: 10000,
              totalMissed: 100,
              latestBlockNum: 59_999_000,
            },
          ],
        });
      } else if (url === "/wallet/listproposals") {
        jsonOk(res, {
          proposals: [
            {
              proposal_id: 42,
              proposer_address: WITNESS_HEX,
              state: "APPROVED",
              parameters: [
                { key: 1, value: 100 },
              ],
              approvals: [WITNESS_HEX, "410000000000000000000000000000000000000001"],
              create_time: 1_700_000_000_000,
              expiration_time: 1_700_086_400_000,
            },
          ],
        });
      } else if (url === "/wallet/getchainparameters") {
        jsonOk(res, {
          chainParameter: [
            { key: "getMaintenanceTimeInterval", value: 21600000 },
            { key: "getEnergyFee", value: 420 },
          ],
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const collector = new TronGovernanceCollector(httpClient());
    const result = await collector.collect({ scope: "full" });

    expect(result.witnesses).toHaveLength(2);
    expect(result.witnesses[0]!.address).toBe(WITNESS_BASE58);
    expect(result.witnesses[0]!.isElected).toBe(true);
    expect(result.witnesses[0]!.voteCount).toBe(100_000_000);
    expect(result.witnesses[0]!.productivityPct).toBeGreaterThan(98);
    expect(result.witnesses[0]!.totalProduced).toBe(50000);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.proposalId).toBe(42);
    expect(result.proposals[0]!.state).toBe("APPROVED");
    expect(result.proposals[0]!.approvalCount).toBe(2);
    expect(result.proposals[0]!.parameters["1"]).toBe("100");

    expect(result.chainParameters["getEnergyFee"]).toBe("420");

    expect(result.totalVotes).toBe(150_000_000);
    expect(result.electedCount).toBe(1);
    expect(result.source).toBe("trongrid");
  });

  it("handles empty governance data", async () => {
    handler = (_req, _body, res) => {
      jsonOk(res, {});
    };

    const collector = new TronGovernanceCollector(httpClient());
    const result = await collector.collect({ scope: "full" });

    expect(result.witnesses).toHaveLength(0);
    expect(result.proposals).toHaveLength(0);
    expect(result.totalVotes).toBe(0);
    expect(result.electedCount).toBe(0);
  });

  it("always supports governance target", () => {
    const collector = new TronGovernanceCollector(httpClient());
    expect(collector.supports({ scope: "full" })).toBe(true);
  });

  it("has correct metadata", () => {
    const collector = new TronGovernanceCollector(httpClient());
    expect(collector.collectorName).toBe("tron-governance-trongrid");
    expect(collector.sourceName).toBe("trongrid");
    expect(collector.sourceType).toBe("API");
  });
});
