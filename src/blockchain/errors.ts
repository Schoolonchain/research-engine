export class BlockchainConnectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainConnectionError";
  }
}

export class BlockchainNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainNotFoundError";
  }
}

export class BlockchainValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainValidationError";
  }
}

export class BlockchainConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BlockchainConflictError";
  }
}

const ALLOWED_ENDPOINT_HOSTS = Object.freeze([
  "api.trongrid.io",
  "api.shasta.trongrid.io",
  "api.nileex.io",
  "apilist.tronscanapi.com",
  "apilist.tronscan.org",
]);

export function assertSafeEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new BlockchainValidationError(`Invalid endpoint URL: ${endpoint}`);
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (isLoopback) return;
  if (parsed.protocol !== "https:") {
    throw new BlockchainValidationError("Endpoint must use HTTPS");
  }
  if (!ALLOWED_ENDPOINT_HOSTS.includes(parsed.hostname)) {
    throw new BlockchainValidationError(
      `Endpoint host ${parsed.hostname} is not in the allowlist`,
    );
  }
}
