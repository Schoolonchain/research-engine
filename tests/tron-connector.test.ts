import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronGridConnector } from "../src/blockchain/tron-connector.js";
import {
  BlockchainConnectionError,
  BlockchainNotFoundError,
} from "../src/blockchain/errors.js";

const VALID_BLOCK = {
  blockID: "0000000002faf0806e3b9a84730c2c8e2c45a3e78e6fc3dc79093e5b5f3b5a2c",
  block_header: {
    raw_data: {
      number: 50_000_000,
      txTrieRoot: "abc123",
      parentHash: "0000000002faf07f1234567890abcdef",
      timestamp: 1_700_000_000_000,
      witness_address: "41witness",
    },
  },
  transactions: [
    {
      txID: "tx001",
      raw_data: {
        contract: [
          {
            type: "TransferContract",
            parameter: {
              value: {
                owner_address: "41sender",
                to_address: "41receiver",
                amount: 5_000_000,
              },
            },
          },
        ],
      },
      ret: [{ contractRet: "SUCCESS" }],
    },
  ],
};

const VALID_TX_INFO = [
  {
    id: "tx001",
    fee: 100_000,
    receipt: {
      energy_usage_total: 50_000,
      net_usage: 267,
    },
  },
];

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

function connector(opts?: { apiKey?: string; timeoutMs?: number }): TronGridConnector {
  const config: { endpoint: string; apiKey?: string; timeoutMs?: number } = {
    endpoint: `http://127.0.0.1:${port}`,
  };
  if (opts?.apiKey !== undefined) config.apiKey = opts.apiKey;
  if (opts?.timeoutMs !== undefined) config.timeoutMs = opts.timeoutMs;
  return new TronGridConnector(config);
}

function jsonOk(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function defaultBlockHandler(req: IncomingMessage, _body: string, res: ServerResponse): void {
  if (req.url === "/wallet/getblockbynum") {
    jsonOk(res, VALID_BLOCK);
  } else if (req.url === "/wallet/gettransactioninfobyblocknum") {
    jsonOk(res, VALID_TX_INFO);
  } else if (req.url === "/wallet/getnowblock") {
    jsonOk(res, VALID_BLOCK);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
}

describe("TronGridConnector", () => {
  describe("request construction", () => {
    it("sends POST with correct Content-Type and Accept headers", async () => {
      const headers: Record<string, string | string[] | undefined>[] = [];
      handler = (req, _body, res) => {
        headers.push({ ...req.headers });
        defaultBlockHandler(req, _body, res);
      };

      await connector().getBlock(50_000_000);

      expect(headers.length).toBeGreaterThanOrEqual(2);
      for (const h of headers) {
        expect(h["content-type"]).toBe("application/json");
        expect(h["accept"]).toBe("application/json");
      }
    });

    it("includes API key in TRON-PRO-API-KEY header when configured", async () => {
      const receivedKeys: (string | undefined)[] = [];
      handler = (req, _body, res) => {
        receivedKeys.push(req.headers["tron-pro-api-key"] as string | undefined);
        defaultBlockHandler(req, _body, res);
      };

      await connector({ apiKey: "test-key-abc" }).getBlock(50_000_000);

      expect(receivedKeys.length).toBeGreaterThanOrEqual(2);
      for (const key of receivedKeys) {
        expect(key).toBe("test-key-abc");
      }
    });

    it("omits API key header when not configured", async () => {
      const receivedKeys: (string | undefined)[] = [];
      handler = (req, _body, res) => {
        receivedKeys.push(req.headers["tron-pro-api-key"] as string | undefined);
        defaultBlockHandler(req, _body, res);
      };

      await connector().getBlock(50_000_000);

      for (const key of receivedKeys) {
        expect(key).toBeUndefined();
      }
    });

    it("sends correct POST body for getblockbynum", async () => {
      let blockBody = "";
      handler = (req, body, res) => {
        if (req.url === "/wallet/getblockbynum") blockBody = body;
        defaultBlockHandler(req, body, res);
      };

      await connector().getBlock(50_000_000);

      expect(JSON.parse(blockBody)).toEqual({ num: 50_000_000 });
    });

    it("sends correct POST body for getnowblock", async () => {
      let nowBody = "";
      handler = (req, body, res) => {
        if (req.url === "/wallet/getnowblock") nowBody = body;
        defaultBlockHandler(req, body, res);
      };

      await connector().getLatestBlockNumber();

      expect(JSON.parse(nowBody)).toEqual({});
    });
  });

  describe("response parsing", () => {
    it("parses a valid block response", async () => {
      handler = defaultBlockHandler;

      const block = await connector().getBlock(50_000_000);

      expect(block.blockNumber).toBe(50_000_000);
      expect(block.blockHash).toBe(VALID_BLOCK.blockID);
      expect(block.parentHash).toBe("0000000002faf07f1234567890abcdef");
      expect(block.timestamp).toBe(1_700_000_000_000);
      expect(block.witnessAddress).toBe("41witness");
    });

    it("parses transactions with info from gettransactioninfobyblocknum", async () => {
      handler = defaultBlockHandler;

      const block = await connector().getBlock(50_000_000);

      expect(block.transactions).toHaveLength(1);
      const tx = block.transactions[0]!;
      expect(tx.txHash).toBe("tx001");
      expect(tx.txType).toBe("TransferContract");
      expect(tx.fromAddress).toBe("41sender");
      expect(tx.toAddress).toBe("41receiver");
      expect(tx.amountSun).toBe(BigInt(5_000_000));
      expect(tx.result).toBe("SUCCESS");
      expect(tx.feeSun).toBe(BigInt(100_000));
      expect(tx.energyUsed).toBe(BigInt(50_000));
      expect(tx.bandwidthUsed).toBe(BigInt(267));
    });

    it("handles a block with no transactions", async () => {
      handler = (req, _body, res) => {
        if (req.url === "/wallet/getblockbynum") {
          jsonOk(res, { ...VALID_BLOCK, transactions: undefined });
        } else if (req.url === "/wallet/gettransactioninfobyblocknum") {
          jsonOk(res, []);
        } else {
          defaultBlockHandler(req, _body, res);
        }
      };

      const block = await connector().getBlock(50_000_000);

      expect(block.transactions).toHaveLength(0);
      expect(block.txCount).toBe(0);
    });

    it("parses latest block number from getnowblock", async () => {
      handler = defaultBlockHandler;

      const num = await connector().getLatestBlockNumber();

      expect(num).toBe(50_000_000);
    });

    it("preserves raw block data", async () => {
      handler = defaultBlockHandler;

      const block = await connector().getBlock(50_000_000);

      expect(block.raw).toHaveProperty("blockID", VALID_BLOCK.blockID);
    });
  });

  describe("error handling", () => {
    it("throws BlockchainNotFoundError for missing blockID", async () => {
      handler = (req, _body, res) => {
        if (req.url === "/wallet/getblockbynum") {
          jsonOk(res, {});
        } else {
          jsonOk(res, []);
        }
      };

      await expect(connector().getBlock(999_999_999)).rejects.toBeInstanceOf(
        BlockchainNotFoundError,
      );
    });

    it("throws BlockchainNotFoundError for negative block numbers", async () => {
      handler = defaultBlockHandler;

      await expect(connector().getBlock(-1)).rejects.toBeInstanceOf(
        BlockchainNotFoundError,
      );
    });

    it("throws BlockchainConnectionError for HTTP 500", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      };

      await expect(connector().getBlock(50_000_000)).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });

    it("throws BlockchainConnectionError for HTTP 429", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("Too Many Requests");
      };

      await expect(connector().getBlock(50_000_000)).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });

    it("throws BlockchainConnectionError for invalid JSON response", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not valid json {{{");
      };

      await expect(connector().getBlock(50_000_000)).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });

    it("throws BlockchainConnectionError on timeout", { timeout: 10_000 }, async () => {
      handler = (_req, _body, _res) => {
        // never respond — let the timeout fire
      };

      await expect(
        connector({ timeoutMs: 500 }).getBlock(50_000_000),
      ).rejects.toBeInstanceOf(BlockchainConnectionError);
    });

    it("throws BlockchainConnectionError when missing block number in getnowblock", async () => {
      handler = (req, _body, res) => {
        if (req.url === "/wallet/getnowblock") {
          jsonOk(res, { block_header: { raw_data: {} } });
        } else {
          defaultBlockHandler(req, _body, res);
        }
      };

      await expect(connector().getLatestBlockNumber()).rejects.toBeInstanceOf(
        BlockchainConnectionError,
      );
    });
  });

  describe("credential safety", () => {
    it("does not include API key value in error messages", async () => {
      const secretKey = "super-secret-trongrid-key-never-leak";

      handler = (_req, _body, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server Error");
      };

      try {
        await connector({ apiKey: secretKey }).getBlock(50_000_000);
        expect.fail("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(secretKey);
        expect(String(error)).not.toContain(secretKey);
        if ((error as Error).stack) {
          expect((error as Error).stack).not.toContain(secretKey);
        }
      }
    });
  });

  describe("connector identity", () => {
    it("exposes correct network and source metadata", () => {
      const c = connector({ apiKey: "key" });
      expect(c.networkName).toBe("TRON Mainnet");
      expect(c.chainId).toBe("tron-mainnet");
      expect(c.sourceType).toBe("API");
      expect(c.sourceName).toBe("TronGrid");
      expect(c.sourceEndpoint).toBe(`http://127.0.0.1:${port}`);
    });

    it("allows custom source name", () => {
      const c = new TronGridConnector({
        endpoint: `http://127.0.0.1:${port}`,
        sourceName: "TronGrid-Secondary",
      });
      expect(c.sourceName).toBe("TronGrid-Secondary");
    });
  });
});
