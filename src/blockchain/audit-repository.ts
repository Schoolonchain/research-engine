import type { DatabaseExecutor } from "../db/database.js";
import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { AuditReport } from "./audit-orchestrator.js";

export interface PersistedAuditReport {
  readonly id: string;
  readonly networkId: string;
  readonly auditType: AuditReport["auditType"];
  readonly targetAddress: string | null;
  readonly overallRisk: Severity;
  readonly findingCounts: AuditReport["findingCounts"];
  readonly sourcesUsed: readonly string[];
  readonly dataPointsCollected: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly createdAt: Date;
}

export interface PersistedAuditFinding {
  readonly id: string;
  readonly reportId: string;
  readonly analyzerName: string;
  readonly module: AuditModule;
  readonly severity: Severity;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recommendation: string | null;
  readonly createdAt: Date;
}

export interface AuditRepository {
  insertReport(
    tx: DatabaseExecutor,
    id: string,
    networkId: string,
    report: AuditReport,
  ): Promise<PersistedAuditReport>;

  insertFinding(
    tx: DatabaseExecutor,
    id: string,
    reportId: string,
    finding: AuditFinding,
  ): Promise<PersistedAuditFinding>;

  findReportById(
    tx: DatabaseExecutor,
    id: string,
  ): Promise<PersistedAuditReport | null>;

  findReportsByNetwork(
    tx: DatabaseExecutor,
    networkId: string,
    limit: number,
    offset: number,
  ): Promise<readonly PersistedAuditReport[]>;

  findReportsByTarget(
    tx: DatabaseExecutor,
    targetAddress: string,
    limit: number,
    offset: number,
  ): Promise<readonly PersistedAuditReport[]>;

  findFindingsByReport(
    tx: DatabaseExecutor,
    reportId: string,
  ): Promise<readonly PersistedAuditFinding[]>;

  findFindingsByReportAndSeverity(
    tx: DatabaseExecutor,
    reportId: string,
    severity: Severity,
  ): Promise<readonly PersistedAuditFinding[]>;

  countReportsByNetwork(
    tx: DatabaseExecutor,
    networkId: string,
  ): Promise<number>;
}

interface ReportRow {
  readonly id: string;
  readonly network_id: string;
  readonly audit_type: string;
  readonly target_address: string | null;
  readonly overall_risk: string;
  readonly finding_count_critical: number;
  readonly finding_count_high: number;
  readonly finding_count_medium: number;
  readonly finding_count_low: number;
  readonly finding_count_info: number;
  readonly sources_used: string[];
  readonly data_points_collected: number;
  readonly started_at: Date;
  readonly completed_at: Date;
  readonly created_at: Date;
}

interface FindingRow {
  readonly id: string;
  readonly report_id: string;
  readonly analyzer_name: string;
  readonly module: string;
  readonly severity: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly evidence: Record<string, unknown>;
  readonly recommendation: string | null;
  readonly created_at: Date;
}

function toReport(row: ReportRow): PersistedAuditReport {
  return Object.freeze({
    id: row.id,
    networkId: row.network_id,
    auditType: row.audit_type as AuditReport["auditType"],
    targetAddress: row.target_address,
    overallRisk: row.overall_risk as Severity,
    findingCounts: Object.freeze({
      critical: row.finding_count_critical,
      high: row.finding_count_high,
      medium: row.finding_count_medium,
      low: row.finding_count_low,
      info: row.finding_count_info,
    }),
    sourcesUsed: Object.freeze(row.sources_used),
    dataPointsCollected: row.data_points_collected,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  });
}

function toFinding(row: FindingRow): PersistedAuditFinding {
  return Object.freeze({
    id: row.id,
    reportId: row.report_id,
    analyzerName: row.analyzer_name,
    module: row.module as AuditModule,
    severity: row.severity as Severity,
    category: row.category,
    title: row.title,
    description: row.description,
    evidence: Object.freeze(row.evidence),
    recommendation: row.recommendation,
    createdAt: row.created_at,
  });
}

const REPORT_COLUMNS = `
  id, network_id, audit_type, target_address, overall_risk,
  finding_count_critical, finding_count_high, finding_count_medium,
  finding_count_low, finding_count_info,
  sources_used, data_points_collected,
  started_at, completed_at, created_at
`;

const FINDING_COLUMNS = `
  id, report_id, analyzer_name, module, severity,
  category, title, description, evidence, recommendation,
  created_at
`;

export class SqlAuditRepository implements AuditRepository {
  async insertReport(
    tx: DatabaseExecutor,
    id: string,
    networkId: string,
    report: AuditReport,
  ): Promise<PersistedAuditReport> {
    const result = await tx.query<ReportRow>(
      `INSERT INTO audit_reports (
        id, network_id, audit_type, target_address, overall_risk,
        finding_count_critical, finding_count_high, finding_count_medium,
        finding_count_low, finding_count_info,
        sources_used, data_points_collected,
        started_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14
      ) RETURNING ${REPORT_COLUMNS}`,
      [
        id,
        networkId,
        report.auditType,
        report.targetAddress,
        report.overallRisk,
        report.findingCounts.critical,
        report.findingCounts.high,
        report.findingCounts.medium,
        report.findingCounts.low,
        report.findingCounts.info,
        report.sourcesUsed,
        report.dataPointsCollected,
        report.startedAt,
        report.completedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Report insert returned no row");
    return toReport(row);
  }

  async insertFinding(
    tx: DatabaseExecutor,
    id: string,
    reportId: string,
    finding: AuditFinding,
  ): Promise<PersistedAuditFinding> {
    const result = await tx.query<FindingRow>(
      `INSERT INTO audit_findings (
        id, report_id, analyzer_name, module, severity,
        category, title, description, evidence, recommendation
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9::jsonb, $10
      ) RETURNING ${FINDING_COLUMNS}`,
      [
        id,
        reportId,
        finding.analyzerName,
        finding.module,
        finding.severity,
        finding.category,
        finding.title,
        finding.description,
        JSON.stringify(finding.evidence),
        finding.recommendation,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Finding insert returned no row");
    return toFinding(row);
  }

  async findReportById(
    tx: DatabaseExecutor,
    id: string,
  ): Promise<PersistedAuditReport | null> {
    const result = await tx.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM audit_reports WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toReport(row) : null;
  }

  async findReportsByNetwork(
    tx: DatabaseExecutor,
    networkId: string,
    limit: number,
    offset: number,
  ): Promise<readonly PersistedAuditReport[]> {
    const result = await tx.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM audit_reports
       WHERE network_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [networkId, limit, offset],
    );
    return Object.freeze(result.rows.map(toReport));
  }

  async findReportsByTarget(
    tx: DatabaseExecutor,
    targetAddress: string,
    limit: number,
    offset: number,
  ): Promise<readonly PersistedAuditReport[]> {
    const result = await tx.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM audit_reports
       WHERE target_address = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [targetAddress, limit, offset],
    );
    return Object.freeze(result.rows.map(toReport));
  }

  async findFindingsByReport(
    tx: DatabaseExecutor,
    reportId: string,
  ): Promise<readonly PersistedAuditFinding[]> {
    const result = await tx.query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM audit_findings
       WHERE report_id = $1
       ORDER BY CASE severity
         WHEN 'CRITICAL' THEN 0
         WHEN 'HIGH' THEN 1
         WHEN 'MEDIUM' THEN 2
         WHEN 'LOW' THEN 3
         WHEN 'INFO' THEN 4
       END, created_at`,
      [reportId],
    );
    return Object.freeze(result.rows.map(toFinding));
  }

  async findFindingsByReportAndSeverity(
    tx: DatabaseExecutor,
    reportId: string,
    severity: Severity,
  ): Promise<readonly PersistedAuditFinding[]> {
    const result = await tx.query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM audit_findings
       WHERE report_id = $1 AND severity = $2
       ORDER BY created_at`,
      [reportId, severity],
    );
    return Object.freeze(result.rows.map(toFinding));
  }

  async countReportsByNetwork(
    tx: DatabaseExecutor,
    networkId: string,
  ): Promise<number> {
    const result = await tx.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM audit_reports WHERE network_id = $1`,
      [networkId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
