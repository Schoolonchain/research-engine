import { Pool, type PoolConfig } from "pg";

import type { Environment } from "../config/environment.js";

export function poolConfig(environment: Environment): PoolConfig {
  return {
    connectionString: environment.databaseUrl,
    max: environment.databasePoolMax,
    idleTimeoutMillis: environment.databaseIdleTimeoutMs,
    connectionTimeoutMillis: environment.databaseConnectionTimeoutMs,
    application_name: "research-engine",
    allowExitOnIdle: environment.nodeEnv !== "production",
  };
}

export function createDatabasePool(environment: Environment): Pool {
  return new Pool(poolConfig(environment));
}

