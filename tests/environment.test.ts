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

  it("sets trongrid to null when no TRONGRID env vars are present", () => {
    const environment = loadEnvironment(validEnvironment);
    expect(environment.trongrid).toBeNull();
  });

  it("loads trongrid config when TRONGRID_API_KEY is set", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONGRID_API_KEY: "test-api-key-value",
    });

    expect(environment.trongrid).not.toBeNull();
    expect(environment.trongrid!.apiKey).toBe("test-api-key-value");
    expect(environment.trongrid!.endpoint).toBe("https://api.trongrid.io");
    expect(environment.trongrid!.timeoutMs).toBe(15_000);
  });

  it("loads trongrid config with custom endpoint", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONGRID_ENDPOINT: "https://custom-tron.example.com",
    });

    expect(environment.trongrid).not.toBeNull();
    expect(environment.trongrid!.endpoint).toBe("https://custom-tron.example.com");
    expect(environment.trongrid!.apiKey).toBeUndefined();
  });

  it("loads trongrid config with custom timeout", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONGRID_API_KEY: "key",
      TRONGRID_TIMEOUT_MS: "30000",
    });

    expect(environment.trongrid!.timeoutMs).toBe(30_000);
  });

  it("rejects invalid TRONGRID_ENDPOINT URL", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        TRONGRID_ENDPOINT: "not-a-url",
      }),
    ).toThrow("TRONGRID_ENDPOINT must be a valid URL");
  });

  it("rejects invalid TRONGRID_TIMEOUT_MS", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        TRONGRID_API_KEY: "key",
        TRONGRID_TIMEOUT_MS: "0",
      }),
    ).toThrow("TRONGRID_TIMEOUT_MS must be a positive integer");
  });

  it("freezes trongrid config to prevent mutation", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONGRID_API_KEY: "test-key",
    });

    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.trongrid)).toBe(true);
  });

  it("sets tronscan to null when no TRONSCAN env vars are present", () => {
    const environment = loadEnvironment(validEnvironment);
    expect(environment.tronscan).toBeNull();
  });

  it("loads tronscan config when TRONSCAN_API_KEY is set", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONSCAN_API_KEY: "test-scan-key",
    });

    expect(environment.tronscan).not.toBeNull();
    expect(environment.tronscan!.apiKey).toBe("test-scan-key");
    expect(environment.tronscan!.endpoint).toBe("https://apilist.tronscanapi.com");
    expect(environment.tronscan!.timeoutMs).toBe(15_000);
  });

  it("loads tronscan config with custom endpoint", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONSCAN_ENDPOINT: "https://custom-scan.example.com",
    });

    expect(environment.tronscan).not.toBeNull();
    expect(environment.tronscan!.endpoint).toBe("https://custom-scan.example.com");
    expect(environment.tronscan!.apiKey).toBeUndefined();
  });

  it("loads tronscan config with custom timeout", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONSCAN_API_KEY: "key",
      TRONSCAN_TIMEOUT_MS: "20000",
    });

    expect(environment.tronscan!.timeoutMs).toBe(20_000);
  });

  it("rejects invalid TRONSCAN_ENDPOINT URL", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        TRONSCAN_ENDPOINT: "not-a-url",
      }),
    ).toThrow("TRONSCAN_ENDPOINT must be a valid URL");
  });

  it("rejects invalid TRONSCAN_TIMEOUT_MS", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        TRONSCAN_API_KEY: "key",
        TRONSCAN_TIMEOUT_MS: "-5",
      }),
    ).toThrow("TRONSCAN_TIMEOUT_MS must be a positive integer");
  });

  it("freezes tronscan config to prevent mutation", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONSCAN_API_KEY: "test-key",
    });

    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.tronscan)).toBe(true);
  });

  it("loads both trongrid and tronscan independently", () => {
    const environment = loadEnvironment({
      ...validEnvironment,
      TRONGRID_API_KEY: "grid-key",
      TRONSCAN_API_KEY: "scan-key",
    });

    expect(environment.trongrid).not.toBeNull();
    expect(environment.tronscan).not.toBeNull();
    expect(environment.trongrid!.apiKey).toBe("grid-key");
    expect(environment.tronscan!.apiKey).toBe("scan-key");
  });
});

