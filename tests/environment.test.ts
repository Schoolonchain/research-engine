import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";
import { poolConfig } from "../src/db/client.js";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@localhost:5432/research_engine",
  PARTICIPATION_HMAC_KEYS: JSON.stringify([
    {
      id: "legacy-v1",
      key: "test-participation-key-at-least-32-characters",
    },
  ]),
} satisfies NodeJS.ProcessEnv;

describe("environment", () => {
  it("loads safe defaults and produces a bounded pool configuration", () => {
    const environment = loadEnvironment(validEnvironment);
    const config = poolConfig(environment);

    expect(environment.nodeEnv).toBe("test");
    expect(environment.databasePoolMax).toBe(10);
    expect(config.max).toBe(10);
    expect(config.application_name).toBe("research-engine");
    expect(config.allowExitOnIdle).toBe(true);
  });

  it("rejects a missing database URL", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        PARTICIPATION_HMAC_KEYS: validEnvironment.PARTICIPATION_HMAC_KEYS,
      }),
    ).toThrow(
      "Missing required environment variable: DATABASE_URL",
    );
  });

  it("rejects non-PostgreSQL URLs", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        DATABASE_URL: "https://example.com/database",
      }),
    ).toThrow("DATABASE_URL must use postgres:// or postgresql://");
  });

  it("rejects invalid resource limits", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        DATABASE_POOL_MAX: "0",
      }),
    ).toThrow("DATABASE_POOL_MAX must be a positive integer");
  });

  it("rejects an invalid participation HMAC keyring", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        PARTICIPATION_HMAC_KEYS: "not-json",
      }),
    ).toThrow("PARTICIPATION_HMAC_KEYS must be valid JSON");
  });
});

