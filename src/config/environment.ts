export const NODE_ENV_VALUES = ["development", "test", "production"] as const;
export type NodeEnvironment = (typeof NODE_ENV_VALUES)[number];

export interface TrongridConfig {
  readonly endpoint: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
}

export interface Environment {
  readonly nodeEnv: NodeEnvironment;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly participationHmacKeys: readonly {
    readonly id: string;
    readonly key: string;
  }[];
  readonly trongrid: TrongridConfig | null;
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
  const keyringRaw = required(source, "PARTICIPATION_HMAC_KEYS");
  let participationHmacKeys: unknown;
  try {
    participationHmacKeys = JSON.parse(keyringRaw);
  } catch {
    throw new Error("PARTICIPATION_HMAC_KEYS must be valid JSON");
  }
  if (
    !Array.isArray(participationHmacKeys) ||
    participationHmacKeys.length === 0 ||
    participationHmacKeys.some(
      (item) =>
        item === null ||
        typeof item !== "object" ||
        typeof (item as { id?: unknown }).id !== "string" ||
        typeof (item as { key?: unknown }).key !== "string",
    )
  ) {
    throw new Error(
      "PARTICIPATION_HMAC_KEYS must be a non-empty array of id/key objects",
    );
  }
  const keyIds = new Set<string>();
  for (const item of participationHmacKeys) {
    const { id, key } = item as { id: string; key: string };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
      throw new Error(`Invalid participation key ID: ${id}`);
    }
    if (keyIds.has(id)) {
      throw new Error(`Duplicate participation key ID: ${id}`);
    }
    if (key.length < 32) {
      throw new Error(
        `Participation HMAC key ${id} must contain at least 32 characters`,
      );
    }
    keyIds.add(id);
  }

  const trongridApiKey = source["TRONGRID_API_KEY"]?.trim() || undefined;
  const trongridEndpointRaw = source["TRONGRID_ENDPOINT"]?.trim();

  let trongrid: TrongridConfig | null = null;
  if (trongridApiKey || trongridEndpointRaw) {
    const endpoint = trongridEndpointRaw || "https://api.trongrid.io";
    try {
      new URL(endpoint);
    } catch {
      throw new Error("TRONGRID_ENDPOINT must be a valid URL");
    }
    trongrid = Object.freeze({
      endpoint,
      apiKey: trongridApiKey,
      timeoutMs: positiveInteger(source, "TRONGRID_TIMEOUT_MS", 15_000),
    });
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
    participationHmacKeys: Object.freeze(
      participationHmacKeys.map((item) =>
        Object.freeze({
          id: (item as { id: string }).id,
          key: (item as { key: string }).key,
        }),
      ),
    ),
    trongrid,
  });
}

