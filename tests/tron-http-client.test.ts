import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TronHttpClient, type TronHttpClientConfig } from "../src/blockchain/tron-http-client.js";
import { BlockchainConnectionError, BlockchainValidationError } from "../src/blockchain/errors.js";

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

function client(opts?: { apiKey?: string; timeoutMs?: number; maxRetries?: number; retryBaseMs?: number }): TronHttpClient {
  const base = {
    endpoint: `http://127.0.0.1:${port}`,
    timeoutMs: opts?.timeoutMs ?? 5_000,
    maxRetries: opts?.maxRetries ?? 0,
    retryBaseMs: opts?.retryBaseMs ?? 10,
    rateLimitPerSecond: 1000,
  };
  if (opts?.apiKey !== undefined) {
    return new TronHttpClient({ ...base, apiKey: opts.apiKey });
  }
  return new TronHttpClient(base);
}

function jsonOk(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── POST requests ──

describe("TronHttpClient", () => {
  describe("post", () => {
    it("sends POST with JSON body and parses response", async () => {
      handler = (_req, body, res) => {
        const parsed = JSON.parse(body);
        jsonOk(res, { received: parsed });
      };

      const result = await client().post<{ received: { num: number } }>("/wallet/test", { num: 42 });
      expect(result.received.num).toBe(42);
    });

    it("sends Content-Type and Accept headers", async () => {
      let contentType: string | undefined;
      let accept: string | undefined;

      handler = (req, _body, res) => {
        const ct = req.headers["content-type"];
        contentType = Array.isArray(ct) ? ct[0] : ct;
        const ac = req.headers["accept"];
        accept = Array.isArray(ac) ? ac[0] : ac;
        jsonOk(res, {});
      };

      await client().post("/wallet/test", {});
      expect(contentType).toBe("application/json");
      expect(accept).toBe("application/json");
    });

    it("sends API key header when configured", async () => {
      let apiKeyHeader: string | undefined;

      handler = (req, _body, res) => {
        const h = req.headers["tron-pro-api-key"];
        apiKeyHeader = Array.isArray(h) ? h[0] : h;
        jsonOk(res, {});
      };

      await client({ apiKey: "test-key-123" }).post("/wallet/test", {});
      expect(apiKeyHeader).toBe("test-key-123");
    });

    it("does not send API key header when not configured", async () => {
      let hasApiKey = false;

      handler = (req, _body, res) => {
        hasApiKey = "tron-pro-api-key" in req.headers;
        jsonOk(res, {});
      };

      await client().post("/wallet/test", {});
      expect(hasApiKey).toBe(false);
    });
  });

  // ── GET requests ──

  describe("get", () => {
    it("sends GET with query params", async () => {
      let requestUrl = "";

      handler = (req, _body, res) => {
        requestUrl = req.url ?? "";
        jsonOk(res, { ok: true });
      };

      await client().get("/api/account", { address: "T123", limit: "10" });
      expect(requestUrl).toContain("address=T123");
      expect(requestUrl).toContain("limit=10");
    });

    it("sends GET without query params", async () => {
      let requestUrl = "";
      let method = "";

      handler = (req, _body, res) => {
        requestUrl = req.url ?? "";
        method = req.method ?? "";
        jsonOk(res, { ok: true });
      };

      await client().get("/api/status");
      expect(method).toBe("GET");
      expect(requestUrl).toBe("/api/status");
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("throws BlockchainConnectionError on 400", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(400);
        res.end("Bad Request");
      };

      await expect(client().post("/wallet/test", {})).rejects.toThrow(BlockchainConnectionError);
    });

    it("throws BlockchainConnectionError on 404", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(404);
        res.end("Not Found");
      };

      await expect(client().get("/missing")).rejects.toThrow(BlockchainConnectionError);
    });

    it("includes status code in error", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(401);
        res.end("Unauthorized");
      };

      try {
        await client().post("/wallet/test", {});
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BlockchainConnectionError);
        expect((error as BlockchainConnectionError).statusCode).toBe(401);
      }
    });

    it("throws on invalid JSON response", async () => {
      handler = (_req, _body, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not valid json {{{");
      };

      await expect(client().post("/wallet/test", {})).rejects.toThrow("Invalid JSON");
    });

    it("throws on timeout", async () => {
      handler = (_req, _body, _res) => {
        // Never respond — let it time out
      };

      await expect(
        client({ timeoutMs: 200 }).post("/wallet/slow", {}),
      ).rejects.toThrow(BlockchainConnectionError);
    }, 10_000);
  });

  // ── Retry logic ──

  describe("retry logic", () => {
    it("retries on 429 and succeeds", async () => {
      let attempt = 0;

      handler = (_req, _body, res) => {
        attempt++;
        if (attempt === 1) {
          res.writeHead(429);
          res.end("Rate limited");
        } else {
          jsonOk(res, { ok: true });
        }
      };

      const result = await client({ maxRetries: 2, retryBaseMs: 10 }).post<{ ok: boolean }>("/wallet/test", {});
      expect(result.ok).toBe(true);
      expect(attempt).toBe(2);
    });

    it("retries on 502 and succeeds", async () => {
      let attempt = 0;

      handler = (_req, _body, res) => {
        attempt++;
        if (attempt === 1) {
          res.writeHead(502);
          res.end("Bad Gateway");
        } else {
          jsonOk(res, { ok: true });
        }
      };

      const result = await client({ maxRetries: 2, retryBaseMs: 10 }).post<{ ok: boolean }>("/wallet/test", {});
      expect(result.ok).toBe(true);
      expect(attempt).toBe(2);
    });

    it("does not retry on 400", async () => {
      let attempt = 0;

      handler = (_req, _body, res) => {
        attempt++;
        res.writeHead(400);
        res.end("Bad Request");
      };

      await expect(
        client({ maxRetries: 2, retryBaseMs: 10 }).post("/wallet/test", {}),
      ).rejects.toThrow(BlockchainConnectionError);
      expect(attempt).toBe(1);
    });

    it("does not retry on 401", async () => {
      let attempt = 0;

      handler = (_req, _body, res) => {
        attempt++;
        res.writeHead(401);
        res.end("Unauthorized");
      };

      await expect(
        client({ maxRetries: 2, retryBaseMs: 10 }).post("/wallet/test", {}),
      ).rejects.toThrow(BlockchainConnectionError);
      expect(attempt).toBe(1);
    });

    it("throws after exhausting retries", async () => {
      let attempt = 0;

      handler = (_req, _body, res) => {
        attempt++;
        res.writeHead(503);
        res.end("Service Unavailable");
      };

      await expect(
        client({ maxRetries: 2, retryBaseMs: 10 }).post("/wallet/test", {}),
      ).rejects.toThrow(BlockchainConnectionError);
      expect(attempt).toBe(3); // 1 initial + 2 retries
    });
  });

  // ── Endpoint validation ──

  describe("endpoint validation", () => {
    it("rejects non-HTTPS external endpoints", () => {
      expect(() => new TronHttpClient({
        endpoint: "http://api.trongrid.io",
      })).toThrow(BlockchainValidationError);
    });

    it("rejects unknown hosts", () => {
      expect(() => new TronHttpClient({
        endpoint: "https://evil.example.com",
      })).toThrow(BlockchainValidationError);
    });

    it("allows known HTTPS endpoints", () => {
      expect(() => new TronHttpClient({
        endpoint: "https://api.trongrid.io",
      })).not.toThrow();
    });

    it("allows localhost for testing", () => {
      expect(() => new TronHttpClient({
        endpoint: "http://127.0.0.1:8090",
      })).not.toThrow();
    });
  });
});
