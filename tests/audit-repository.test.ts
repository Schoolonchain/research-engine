import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { SqlAuditRepository } from "../src/blockchain/audit-repository.js";
import type { AuditReport } from "../src/blockchain/audit-orchestrator.js";
import type { AuditFinding } from "../src/blockchain/audit-analyzer.js";

class Executor implements DatabaseExecutor {
  constructor(private readonly database: PGlite | Transaction) {}
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<DatabaseResult<Row>> {
    const result = await this.database.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}

let db: PGlite;
let tx: Executor;
let networkId: string;

const repo = new SqlAuditRepository();

function makeReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    auditType: "ACCOUNT",
    targetAddress: "TAddr123",
    overallRisk: "MEDIUM",
    findingCounts: { critical: 0, high: 1, medium: 2, low: 0, info: 0 },
    findings: [],
    sourcesUsed: ["TronGrid", "TronScan"],
    dataPointsCollected: 5,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:00:05Z"),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    analyzerName: "security",
    module: "RIESGO",
    severity: "HIGH",
    category: "single-key-owner",
    title: "Single key owner permission",
    description: "Account has a single key controlling owner permission.",
    evidence: { address: "TAddr123", threshold: 1, keyCount: 1 },
    recommendation: "Consider adding multi-signature.",
    ...overrides,
  };
}

beforeEach(async () => {
  db = new PGlite();
  const executor = new Executor(db);
  await migrate(
    { query: (sql: string, values: readonly unknown[] = []) =>
      values.length === 0 ? db.exec(sql) : db.query(sql, [...values]) },
    await loadMigrations(),
  );

  const netResult = await executor.query<{ readonly id: string }>(
    `INSERT INTO blockchain_networks (name, chain_id, network_type)
     VALUES ('TRON Mainnet', 'tron-mainnet', 'MAINNET')
     RETURNING id`,
  );
  networkId = netResult.rows[0]!.id;
  tx = executor;
});

afterEach(async () => {
  await db.close();
});

describe("SqlAuditRepository", () => {
  describe("insertReport + findReportById", () => {
    it("persists and retrieves an audit report", async () => {
      const report = makeReport();
      const id = crypto.randomUUID();
      const persisted = await repo.insertReport(tx, id, networkId, report);

      expect(persisted.id).toBe(id);
      expect(persisted.networkId).toBe(networkId);
      expect(persisted.auditType).toBe("ACCOUNT");
      expect(persisted.targetAddress).toBe("TAddr123");
      expect(persisted.overallRisk).toBe("MEDIUM");
      expect(persisted.findingCounts.high).toBe(1);
      expect(persisted.findingCounts.medium).toBe(2);
      expect(persisted.sourcesUsed).toContain("TronGrid");
      expect(persisted.dataPointsCollected).toBe(5);

      const found = await repo.findReportById(tx, id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(found!.overallRisk).toBe("MEDIUM");
    });

    it("returns null for nonexistent report", async () => {
      const found = await repo.findReportById(tx, crypto.randomUUID());
      expect(found).toBeNull();
    });

    it("persists FULL audit without target address", async () => {
      const report = makeReport({ auditType: "FULL", targetAddress: null });
      const id = crypto.randomUUID();
      const persisted = await repo.insertReport(tx, id, networkId, report);

      expect(persisted.auditType).toBe("FULL");
      expect(persisted.targetAddress).toBeNull();
    });
  });

  describe("insertFinding + findFindingsByReport", () => {
    it("persists and retrieves findings for a report", async () => {
      const reportId = crypto.randomUUID();
      await repo.insertReport(tx, reportId, networkId, makeReport());

      const f1 = makeFinding({ severity: "CRITICAL", category: "proxy-pattern" });
      const f2 = makeFinding({ severity: "MEDIUM", category: "unverified-source" });
      const f3 = makeFinding({ severity: "HIGH", category: "single-key-owner" });

      await repo.insertFinding(tx, crypto.randomUUID(), reportId, f1);
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, f2);
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, f3);

      const findings = await repo.findFindingsByReport(tx, reportId);
      expect(findings).toHaveLength(3);
      expect(findings[0]!.severity).toBe("CRITICAL");
      expect(findings[1]!.severity).toBe("HIGH");
      expect(findings[2]!.severity).toBe("MEDIUM");
    });

    it("stores evidence as JSON and retrieves it", async () => {
      const reportId = crypto.randomUUID();
      await repo.insertReport(tx, reportId, networkId, makeReport());

      const finding = makeFinding({
        evidence: { address: "TAddr", ratio: 0.95, nested: { a: 1 } },
      });
      const id = crypto.randomUUID();
      await repo.insertFinding(tx, id, reportId, finding);

      const findings = await repo.findFindingsByReport(tx, reportId);
      expect(findings[0]!.evidence).toEqual({
        address: "TAddr",
        ratio: 0.95,
        nested: { a: 1 },
      });
    });

    it("stores null recommendation", async () => {
      const reportId = crypto.randomUUID();
      await repo.insertReport(tx, reportId, networkId, makeReport());

      const finding = makeFinding({ recommendation: null });
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, finding);

      const findings = await repo.findFindingsByReport(tx, reportId);
      expect(findings[0]!.recommendation).toBeNull();
    });
  });

  describe("findFindingsByReportAndSeverity", () => {
    it("filters findings by severity", async () => {
      const reportId = crypto.randomUUID();
      await repo.insertReport(tx, reportId, networkId, makeReport());

      await repo.insertFinding(tx, crypto.randomUUID(), reportId, makeFinding({ severity: "HIGH" }));
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, makeFinding({ severity: "MEDIUM" }));
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, makeFinding({ severity: "HIGH" }));

      const highFindings = await repo.findFindingsByReportAndSeverity(tx, reportId, "HIGH");
      expect(highFindings).toHaveLength(2);
      expect(highFindings.every((f) => f.severity === "HIGH")).toBe(true);

      const medFindings = await repo.findFindingsByReportAndSeverity(tx, reportId, "MEDIUM");
      expect(medFindings).toHaveLength(1);
    });
  });

  describe("findReportsByNetwork", () => {
    it("returns reports ordered by creation date desc", async () => {
      const r1 = makeReport({ startedAt: new Date("2026-01-01T00:00:00Z"), completedAt: new Date("2026-01-01T00:00:01Z") });
      const r2 = makeReport({ startedAt: new Date("2026-01-02T00:00:00Z"), completedAt: new Date("2026-01-02T00:00:01Z") });

      await repo.insertReport(tx, crypto.randomUUID(), networkId, r1);
      await repo.insertReport(tx, crypto.randomUUID(), networkId, r2);

      const reports = await repo.findReportsByNetwork(tx, networkId, 10, 0);
      expect(reports).toHaveLength(2);
      expect(reports[0]!.completedAt.getTime()).toBeGreaterThanOrEqual(
        reports[1]!.completedAt.getTime(),
      );
    });

    it("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.insertReport(tx, crypto.randomUUID(), networkId, makeReport());
      }

      const page1 = await repo.findReportsByNetwork(tx, networkId, 2, 0);
      expect(page1).toHaveLength(2);

      const page2 = await repo.findReportsByNetwork(tx, networkId, 2, 2);
      expect(page2).toHaveLength(2);

      const page3 = await repo.findReportsByNetwork(tx, networkId, 2, 4);
      expect(page3).toHaveLength(1);
    });
  });

  describe("findReportsByTarget", () => {
    it("returns only reports for a specific target", async () => {
      await repo.insertReport(tx, crypto.randomUUID(), networkId, makeReport({ targetAddress: "TAddr1" }));
      await repo.insertReport(tx, crypto.randomUUID(), networkId, makeReport({ targetAddress: "TAddr2" }));
      await repo.insertReport(tx, crypto.randomUUID(), networkId, makeReport({ targetAddress: "TAddr1" }));

      const reports = await repo.findReportsByTarget(tx, "TAddr1", 10, 0);
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.targetAddress === "TAddr1")).toBe(true);
    });
  });

  describe("countReportsByNetwork", () => {
    it("counts reports for a network", async () => {
      expect(await repo.countReportsByNetwork(tx, networkId)).toBe(0);

      await repo.insertReport(tx, crypto.randomUUID(), networkId, makeReport());
      await repo.insertReport(tx, crypto.randomUUID(), networkId, makeReport());

      expect(await repo.countReportsByNetwork(tx, networkId)).toBe(2);
    });
  });

  describe("cascade delete", () => {
    it("deletes findings when report is deleted", async () => {
      const reportId = crypto.randomUUID();
      await repo.insertReport(tx, reportId, networkId, makeReport());
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, makeFinding());
      await repo.insertFinding(tx, crypto.randomUUID(), reportId, makeFinding());

      const beforeDelete = await repo.findFindingsByReport(tx, reportId);
      expect(beforeDelete).toHaveLength(2);

      await tx.query("DELETE FROM audit_reports WHERE id = $1", [reportId]);

      const afterDelete = await repo.findFindingsByReport(tx, reportId);
      expect(afterDelete).toHaveLength(0);
    });
  });
});
