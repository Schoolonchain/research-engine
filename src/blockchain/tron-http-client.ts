import { BlockchainConnectionError, assertSafeEndpoint } from "./errors.js";

export interface TronHttpClientConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly rateLimitPerSecond?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RATE_LIMIT = 15;

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof TypeError) return true;
  return false;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacity: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1000 * (1 - this.tokens)) / this.capacity);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.capacity);
    this.lastRefill = now;
  }
}

export class TronHttpClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly bucket: TokenBucket;

  constructor(config: TronHttpClientConfig) {
    assertSafeEndpoint(config.endpoint);
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.bucket = new TokenBucket(config.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.execute<T>("POST", path, body);
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.execute<T>("GET", path, undefined, params);
  }

  private async execute<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryBaseMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      await this.bucket.acquire();

      try {
        const result = await this.doFetch<T>(method, path, body, params);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof BlockchainConnectionError && error.statusCode !== undefined) {
          if (!RETRYABLE_STATUS_CODES.has(error.statusCode)) throw error;
          continue;
        }

        if (isRetryableError(error)) continue;

        throw lastError;
      }
    }

    throw lastError ?? new BlockchainConnectionError(`Request to ${path} failed after ${this.maxRetries} retries`);
  }

  private async doFetch<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
  ): Promise<T> {
    let url: string;
    if (method === "GET" && params) {
      const urlObj = new URL(`${this.endpoint}${path}`);
      for (const [key, value] of Object.entries(params)) {
        urlObj.searchParams.set(key, value);
      }
      url = urlObj.toString();
    } else {
      url = `${this.endpoint}${path}`;
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["TRON-PRO-API-KEY"] = this.apiKey;
    }

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new BlockchainConnectionError(
          `Request to ${path} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new BlockchainConnectionError(
        `Failed to connect to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new BlockchainConnectionError(
        `API error: ${response.status} ${response.statusText} on ${path}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new BlockchainConnectionError(`Invalid JSON response from ${path}`);
    }
  }
}
