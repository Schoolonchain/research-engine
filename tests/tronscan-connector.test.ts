import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronScanConnector } from "../src/blockchain/tronscan-connector.js";
import {
  BlockchainConnectionError,
  BlockchainNotFoundError,
} from "../src/blockchain/errors.js";

const VALID_BLOCK = {
  number: 50_000_000,
  hash: "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
  parentHash: "0000000002faf07f1234567890abcdef",
  timestamp: 1_700_000_000_000,
  witnessAddress: "TRWBqiqoFZysoAeyR1J35ibuyc8EvhUAoY",
  nrOfTrx: 1,
  size: 2048,
  confirmed: true,
};

const VALID_TX_LIST = {
  total: 1,
  data: [
    {
      hash: "tx001abc",
      contractType: 1,
      ownerAddress: "TSender123",
      toAddress: "TReceiver456",
      amount: 5_000_000,
      result: "SUCCESS",
      cost: {
        fee: 100_000,
        energy_usage_total: 50_000,
        net_usage: 267,
      },
      contractData: {
        amount: 5_000_000,
        owner_address: "TSender123",
        to_address: "TReceiver456",
      },
    },
  ],
};

const BLOCK_LIST = {
  total: 1,
  data: [{ number: 75_000_000, hash: "latest-hash" }],
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let port: number;
let handler: Handler;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connector(opts?: { endpoint?: string; apiKey?: string; timeoutMs?: number }): TronScanConnector {
  const config: { endpoint: string; apiKey?: string; timeoutMs?: number } = {
    endpoint: opts?.endpoint ?? `http://127.0.0.1:${port}`,
  };
  if (opts?.apiKey !== undefined) config.apiKey = opts.apiKey;
  if (opts?.timeoutMs !== undefined) config.timeoutMs = opts.timeoutMs;
  return new TronScanConnector(config);
}

function jsonOk(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function defaultHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (path === "/api/block/info") {
    jsonOk(res, VALID_BLOCK);
  } else if (path === "/api/transaction") {
    jsonOk(res, VALID_TX_LIST);
  } else if (path === "/api/block") {
    jsonOk(res, BLOCK_LIST);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
}

describe("TronScanConnector", () => {
  describe("request construction", () => {
    it("uses GET requests with query parameters", async () => {
      const methods: string[] = [];
      const urls: string[] = [];
      handler = (req, res) => {
        methods.push(req.method!);
        urls.push(req.url!);
        defaultHandler(req, res);
      };

      await connector().getBlock(50_000_000);

      expect(methods.every((m) => m === "GET")).toBe(true);
      expect(urls.some((u) => u.includes("num=50000000"))).toBe(true);
      expect(urls.some((u) => u.includes("block=50000000"))).toBe(true);
    });

    it("includes API key in TRON-PRO-API-KEY header when configured", async () => {
      const receivedKeys: (string | undefined)[] = [];
      handler = (req, res) => {
        receivedKeys.push(req.headers["tron-pro-api-key"] as string | undefined);
        defaultHandler(req, res);
      };

      await connector({ apiKey: "scan-key-123" }).getBlock(50_000_000);

      expect(receivedKeys.length).toBeGreaterThanOrEqual(2);
      for (const key of receivedKeys) {
        expect(key).toBe("scan-key-123");
      }
    });

    it("omits API key header when not configured", async () => {
      const receivedKeys: (string | undefined)[] = [];
      handler = (req, res) => {
        receivedKeys.push(req.headers["tron-pro-api-key"] as string | undefined);
        defaultHandler(req, res);
      };

      await connector().getBlock(50_000_000);

      for (const key of receivedKeys) {
        expect(key).toBeUndefined();
      }
    });

    it("sends Accept: application/json header", async () => {
      const accepts: (string | undefined)[] = [];
      handler = (req, res) => {
        accepts.push(req.headers["accept"] as string | undefined);
        defaultHandler(req, res);
      };

      await connector().getBlock(50_000_000);

      for (const accept of accepts) {
        expect(accept).toBe("application/json");
      }
    });
  });

  describe("response parsing", () => {
    it("parses a valid block response", async () => {
      handler = defaultHandler;

      const block = await connector().getBlock(50_000_000);

      expect(block.blockNumber).toBe(50_000_000);
      expect(block.blockHash).toBe(VALID_BLOCK.hash);
      expect(block.parentHash).toBe(VALID_BLOCK.parentHash);
      expect(block.timestamp).toBe(1_700_000_000_000);
      expect(block.blockProducer).toBe("TRWBqiqoFZysoAeyR1J35ibuyc8EvhUAoY");
      expect(block.sizeBytes).toBe(2048);
    });

    it("parses transactions with fee and resource data", async () => {
      handler = defaultHandler;

      const block = await connector().getBlock(50_000_000);

      expect(block.transactions).toHaveLength(1);
      const tx = block.transactions[0]!;
      expect(tx.txHash).toBe("tx001abc");
      expect(tx.txType).toBe("TransferContract");
      expect(tx.fromAddress).toBe("TSender123");
      expect(tx.toAddress).toBe("TReceiver456");
      expect(tx.amount).toBe("5000000");
      expect(tx.result).toBe("SUCCESS");
      expect(tx.fee).toBe("100000");
      expect(tx.amountUnit).toBe("SUN");
      expect(tx.feeUnit).toBe("SUN");
      expect(tx.chainData).toEqual({ energyUsed: 50000, bandwidthUsed: 267 });
    });

    it("maps numeric contract types to names", async () => {
      handler = (req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${port}`);
        if (url.pathname === "/api/transaction") {
          jsonOk(res, {
            total: 2,
            data: [
              { hash: "tx1", contractType: 31, result: "SUCCESS" },
              { hash: "tx2", contractType: 999, result: "SUCCESS" },
            ],
          });
        } else {
          defaultHandler(req, res);
        }
      };

      const block = await connector().getBlock(50_000_000);

      expect(block.transactions[0]!.txType).toBe("TriggerSmartContract");
      expect(block.transactions[1]!.txType).toBe("ContractType_999");
    });

    it("handles a block with no transactions", async () => {
      handler = (req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${port}`);
        if (url.pathname === "/api/transaction") {
          jsonOk(res, { total: 0, data: [] });
        } else {
          defaultHandler(req, res);
        }
      };

      const block = await connector().getBlock(50_000_000);

      expect(block.transactions).toHaveLength(0);
      expect(block.txCount).toBe(0);
    });

    it("parses latest block number", async () => {
      handler = defaultHandler;

      const num = await connector().getLatestBlockNumber();

      expect(num).toBe(75_000_000);
    });

    it("preserves raw block data", async () => {
      handler = defaultHandler;

      const block = await connector().getBlock(50_000_000);

      expect(block.raw).toHaveProperty("hash", VALID_BLOCK.hash);
      expect(block.raw).toHaveProperty("witnessAddress");
    });
  });

  describe("error handling", () => {
    it("throws BlockchainNotFoundError for missing hash in response", async () => {
      handler = (req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${port}`);
        if (url.pathname === "/api/block/info") {
          jsonOk(res, {});
        } else {
          jsonOk(res, { total: 0, data: [] });
        }
      };

      await expect(connector().getBlock(999_999_999)).rejects.toBeInstanceOf(
        BlockchainNotFoundError,
      );
    });

    it("throws BlockchainNotFoundError for negative block numbers", async () => {
      await expect(connector().getBlock(-1)).rejects.toBeInstanceOf(
        BlockchainNotFoundError,
      );
    });

    it("throws BlockchainConnectionError for HTTP 500", async () => {
      handler = (_req, res) => {
        res.writeHead(500);
        res.end("Server Error");
      };

      await expect(connector().getBlock(50_000_000)).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });

    it("throws BlockchainConnectionError for invalid JSON", async () => {
      handler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not json");
      };

      await expect(connector().getBlock(50_000_000)).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });

    it("throws BlockchainConnectionError on timeout", { timeout: 10_000 }, async () => {
      handler = () => {};

      await expect(
        connector({ timeoutMs: 500 }).getBlock(50_000_000),
      ).rejects.toBeInstanceOf(BlockchainConnectionError);
    });

    it("throws BlockchainConnectionError for missing latest block", async () => {
      handler = (req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${port}`);
        if (url.pathname === "/api/block") {
          jsonOk(res, { data: [] });
        } else {
          defaultHandler(req, res);
        }
      };

      await expect(connector().getLatestBlockNumber()).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });
  });

  describe("credential safety", () => {
    it("does not include API key in error messages", async () => {
      const secretKey = "tronscan-secret-never-leak-key";

      handler = (_req, res) => {
        res.writeHead(500);
        res.end("Error");
      };

      try {
        await connector({ apiKey: secretKey }).getBlock(50_000_000);
        expect.fail("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(secretKey);
        expect(String(error)).not.toContain(secretKey);
      }
    });
  });

  describe("connector identity", () => {
    it("identifies as EXPLORER type", () => {
      const c = connector();
      expect(c.networkName).toBe("TRON Mainnet");
      expect(c.chainId).toBe("tron-mainnet");
      expect(c.sourceType).toBe("EXPLORER");
      expect(c.sourceName).toBe("TronScan");
    });

    it("shares chainId with TronGrid connector", () => {
      const c = connector();
      expect(c.chainId).toBe("tron-mainnet");
      expect(c.networkName).toBe("TRON Mainnet");
    });

    it("rejects HTTP endpoints for non-loopback hosts", () => {
      expect(() => connector({ endpoint: "http://evil.com" })).toThrow("HTTPS");
    });

    it("rejects hosts not in the allowlist", () => {
      expect(() => connector({ endpoint: "https://evil.com" })).toThrow("not in the allowlist");
    });

    it("accepts valid TronScan endpoint", () => {
      const c = connector({ endpoint: "https://apilist.tronscanapi.com" });
      expect(c.sourceEndpoint).toBe("https://apilist.tronscanapi.com");
    });
  });
});
