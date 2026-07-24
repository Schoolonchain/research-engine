export const NODE_ENV_VALUES = ["development", "test", "production"] as const;
export type NodeEnvironment = (typeof NODE_ENV_VALUES)[number];

export interface Environment {
  readonly nodeEnv: NodeEnvironment;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly participationHmacKey: string;
}

function required(
  source: NodeJS.ProcessEnv,
  key: keyof NodeJS.ProcessEnv,
): string {
  const value = source[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value;
}

function positiveInteger(
  source: NodeJS.ProcessEnv,
  key: keyof NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = source[key]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${String(key)} must be a positive integer`);
  }
  return value;
}

function nodeEnvironment(source: NodeJS.ProcessEnv): NodeEnvironment {
  const value = source["NODE_ENV"]?.trim() ?? "development";
  if (!NODE_ENV_VALUES.includes(value as NodeEnvironment)) {
    throw new Error(
      `NODE_ENV must be one of: ${NODE_ENV_VALUES.join(", ")}`,
    );
  }
  return value as NodeEnvironment;
}

function postgresUrl(source: NodeJS.ProcessEnv): string {
  const value = required(source, "DATABASE_URL");
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  return value;
}

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const participationHmacKey = required(source, "PARTICIPATION_HMAC_KEY");
  if (participationHmacKey.length < 32) {
    throw new Error(
      "PARTICIPATION_HMAC_KEY must contain at least 32 characters",
    );
  }

  return Object.freeze({
    nodeEnv: nodeEnvironment(source),
    databaseUrl: postgresUrl(source),
    databasePoolMax: positiveInteger(source, "DATABASE_POOL_MAX", 10),
    databaseIdleTimeoutMs: positiveInteger(
      source,
      "DATABASE_IDLE_TIMEOUT_MS",
      30_000,
    ),
    databaseConnectionTimeoutMs: positiveInteger(
      source,
      "DATABASE_CONNECTION_TIMEOUT_MS",
      5_000,
    ),
    participationHmacKey,
  });
}

