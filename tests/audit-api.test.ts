import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import type { ActorContext } from "../src/proposals/model.js";
import type { AuditReport } from "../src/blockchain/audit-orchestrator.js";
import type { AuditAnalyzer, AuditFinding, AuditSnapshot } from "../src/blockchain/audit-analyzer.js";
import { AuditOrchestrator } from "../src/blockchain/audit-orchestrator.js";
import { SqlAuditRepository } from "../src/blockchain/audit-repository.js";
import { TronCollectorRegistry } from "../src/blockchain/tron-collector-registry.js";
import { BlockchainRateLimiter } from "../src/blockchain/blockchain-rate-limiter.js";
import { buildAuditApi } from "../src/blockchain/audit-api.js";

class Executor implements DatabaseExecutor {
  constructor(private readonly database: PGlite | Transaction) {}
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<DatabaseResult<Row>> {
    const result = await this.database.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}

class Database implements TransactionalDatabase {
  constructor(private readonly database: PGlite) {}
  transaction<Result>(operation: (transaction: DatabaseExecutor) => Promise<Result>): Promise<Result> {
    return this.database.transaction((transaction) => operation(new Executor(transaction)));
  }
}

class StubAnalyzer implements AuditAnalyzer {
  readonly analyzerName = "stub";
  readonly modules = ["RIESGO" as const];
  constructor(private readonly findings: AuditFinding[] = []) {}
  analyze(_snapshot: AuditSnapshot): readonly AuditFinding[] {
    return this.findings;
  }
}

const tokens = new Map<string, ActorContext>([
  ["test-token", { actorId: "actor-1", role: "USER" }],
]);

describe("audit API", () => {
  let raw: PGlite;
  let app: ReturnType<typeof buildAuditApi>;
  let networkId: string;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
      await loadMigrations(),
    );
    const database = new Database(raw);
    const executor = new Executor(raw);

    const netResult = await executor.query<{ readonly id: string }>(
      `INSERT INTO blockchain_networks (name, chain_id, network_type)
       VALUES ('TRON Mainnet', 'tron-mainnet', 'MAINNET')
       RETURNING id`,
    );
    networkId = netResult.rows[0]!.id;

    const stubFindings: AuditFinding[] = [
      {
        analyzerName: "security",
        module: "RIESGO",
        severity: "HIGH",
        category: "single-key-owner",
        title: "Single key owner",
        description: "Account has a single key controlling owner permission.",
        evidence: { address: "TAddr123", threshold: 1 },
        recommendation: "Add multi-signature.",
      },
      {
        analyzerName: "contract",
        module: "DESARROLLO",
        severity: "MEDIUM",
        category: "unverified-source",
        title: "Unverified contract source",
        description: "Contract source code is not verified.",
        evidence: { address: "TAddr123" },
        recommendation: null,
      },
    ];

    const registry = new TronCollectorRegistry();
    const orchestrator = new AuditOrchestrator(registry, [new StubAnalyzer(stubFindings)]);
    const repository = new SqlAuditRepository();
    const rateLimiter = new BlockchainRateLimiter(database);

    app = buildAuditApi({
      orchestrator,
      repository,
      database,
      networkId,
      authenticate: async (request) => {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) return undefined;
        return tokens.get(header.slice("Bearer ".length));
      },
      rateLimiter,
    });
  });

  afterEach(async () => {
    await app.close();
    await raw.close();
  });

  describe("POST /audit/account", () => {
    it("runs an account audit and returns 201 with findings", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.auditType).toBe("ACCOUNT");
      expect(body.targetAddress).toBe("TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW");
      expect(body.overallRisk).toBe("HIGH");
      expect(body.findingCounts.high).toBe(1);
      expect(body.findingCounts.medium).toBe(1);
      expect(body.findings).toHaveLength(2);
      expect(body.findings[0].severity).toBe("HIGH");
      expect(body.id).toBeDefined();
    });

    it("returns 400 for missing address", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 400 for invalid TRON address", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "not-a-tron-address" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain("TRON Base58Check");
    });

    it("returns 401 without authorization", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/account",
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /audit/contract", () => {
    it("runs a contract audit and returns 201", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/contract",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.auditType).toBe("CONTRACT");
      expect(body.findings).toHaveLength(2);
    });
  });

  describe("POST /audit/full", () => {
    it("runs a full audit and returns 201", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/full",
        headers: { authorization: "Bearer test-token" },
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.auditType).toBe("FULL");
      expect(body.targetAddress).toBeNull();
    });

    it("returns 401 without authorization", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/audit/full",
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /audit/reports", () => {
    it("lists reports for the network", async () => {
      await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/audit/reports",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0].auditType).toBe("ACCOUNT");
    });

    it("filters by target address", async () => {
      await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/audit/reports?target=TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.reports).toHaveLength(1);
    });

    it("returns empty for unknown target", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/audit/reports?target=TNonExistent1234567890123456789012",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().reports).toHaveLength(0);
    });

    it("respects pagination", async () => {
      await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });
      await app.inject({
        method: "POST",
        url: "/audit/contract",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });

      const page1 = await app.inject({
        method: "GET",
        url: "/audit/reports?limit=1&offset=0",
      });
      expect(page1.json().reports).toHaveLength(1);

      const page2 = await app.inject({
        method: "GET",
        url: "/audit/reports?limit=1&offset=1",
      });
      expect(page2.json().reports).toHaveLength(1);

      expect(page1.json().reports[0].id).not.toBe(page2.json().reports[0].id);
    });
  });

  describe("GET /audit/reports/:reportId", () => {
    it("returns a specific report", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });
      const reportId = createResponse.json().id;

      const response = await app.inject({
        method: "GET",
        url: `/audit/reports/${reportId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(reportId);
      expect(response.json().auditType).toBe("ACCOUNT");
    });

    it("returns 404 for unknown report", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/audit/reports/${crypto.randomUUID()}`,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /audit/reports/:reportId/findings", () => {
    it("returns all findings for a report", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });
      const reportId = createResponse.json().id;

      const response = await app.inject({
        method: "GET",
        url: `/audit/reports/${reportId}/findings`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.findings).toHaveLength(2);
      expect(body.findings[0].severity).toBe("HIGH");
      expect(body.findings[1].severity).toBe("MEDIUM");
    });

    it("filters findings by severity", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });
      const reportId = createResponse.json().id;

      const response = await app.inject({
        method: "GET",
        url: `/audit/reports/${reportId}/findings?severity=HIGH`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.findings).toHaveLength(1);
      expect(body.findings[0].severity).toBe("HIGH");
    });

    it("returns 400 for invalid severity", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/audit/account",
        headers: { authorization: "Bearer test-token" },
        payload: { address: "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW" },
      });
      const reportId = createResponse.json().id;

      const response = await app.inject({
        method: "GET",
        url: `/audit/reports/${reportId}/findings?severity=INVALID`,
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for unknown report", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/audit/reports/${crypto.randomUUID()}/findings`,
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
