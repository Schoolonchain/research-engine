import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { TransactionalDatabase } from "../db/database.js";
import type { ActorContext } from "../proposals/model.js";
import type { AuditOrchestrator, AuditReport } from "./audit-orchestrator.js";
import type {
  AuditRepository,
  PersistedAuditFinding,
  PersistedAuditReport,
} from "./audit-repository.js";
import type { Severity } from "./audit-analyzer.js";
import {
  BlockchainAuthenticationRequiredError,
  BlockchainConnectionError,
  BlockchainNotFoundError,
  BlockchainRateLimitError,
  BlockchainValidationError,
} from "./errors.js";
import type { BlockchainRateLimiter } from "./blockchain-rate-limiter.js";

export type AuditAuthenticator = (
  request: FastifyRequest,
) => Promise<ActorContext | undefined>;

export interface AuditApiDependencies {
  readonly orchestrator: AuditOrchestrator;
  readonly repository: AuditRepository;
  readonly database: TransactionalDatabase;
  readonly networkId: string;
  readonly authenticate: AuditAuthenticator;
  readonly rateLimiter: BlockchainRateLimiter;
}

const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const VALID_SEVERITIES = new Set<string>(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);

function serializeReport(report: PersistedAuditReport): Record<string, unknown> {
  return {
    id: report.id,
    networkId: report.networkId,
    auditType: report.auditType,
    targetAddress: report.targetAddress,
    overallRisk: report.overallRisk,
    findingCounts: report.findingCounts,
    sourcesUsed: report.sourcesUsed,
    dataPointsCollected: report.dataPointsCollected,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    createdAt: report.createdAt,
  };
}

function serializeFinding(finding: PersistedAuditFinding): Record<string, unknown> {
  return {
    id: finding.id,
    reportId: finding.reportId,
    analyzerName: finding.analyzerName,
    module: finding.module,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    description: finding.description,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    createdAt: finding.createdAt,
  };
}

function serializeInlineReport(
  persisted: PersistedAuditReport,
  findings: readonly PersistedAuditFinding[],
): Record<string, unknown> {
  return {
    ...serializeReport(persisted),
    findings: findings.map(serializeFinding),
  };
}

async function actor(
  request: FastifyRequest,
  authenticate: AuditAuthenticator,
): Promise<ActorContext> {
  const context = await authenticate(request);
  if (!context) throw new BlockchainAuthenticationRequiredError();
  return context;
}

async function persistReport(
  deps: AuditApiDependencies,
  report: AuditReport,
): Promise<{ persisted: PersistedAuditReport; findings: readonly PersistedAuditFinding[] }> {
  return deps.database.transaction(async (tx) => {
    const reportId = crypto.randomUUID();
    const persisted = await deps.repository.insertReport(tx, reportId, deps.networkId, report);

    const findings: PersistedAuditFinding[] = [];
    for (const finding of report.findings) {
      const f = await deps.repository.insertFinding(tx, crypto.randomUUID(), reportId, finding);
      findings.push(f);
    }

    return { persisted, findings };
  });
}

export function buildAuditApi(
  deps: AuditApiDependencies,
): FastifyInstance {
  const app = Fastify({
    logger: process.env["NODE_ENV"] !== "test",
    bodyLimit: 10_000,
    requestTimeout: 120_000,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BlockchainValidationError) {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: error.message });
    }
    if (error instanceof BlockchainAuthenticationRequiredError) {
      return reply.status(401).send({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (error instanceof BlockchainNotFoundError) {
      return reply.status(404).send({ error: "NOT_FOUND", message: error.message });
    }
    if (error instanceof BlockchainRateLimitError) {
      return reply.header("retry-after", String(error.retryAfterSeconds))
        .status(429).send({ error: "RATE_LIMITED" });
    }
    if (error instanceof BlockchainConnectionError) {
      return reply.status(502).send({ error: "UPSTREAM_ERROR", message: "Upstream service temporarily unavailable" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  app.post("/audit/account", async (request, reply) => {
    const ctx = await actor(request, deps.authenticate);
    const body = request.body as { address?: unknown } | null;
    if (!body || typeof body.address !== "string") {
      throw new BlockchainValidationError("address must be a string");
    }
    if (!TRON_ADDRESS_PATTERN.test(body.address)) {
      throw new BlockchainValidationError("address must be a valid TRON Base58Check address");
    }
    await deps.rateLimiter.consume("block_collect", ctx.actorId);

    const report = await deps.orchestrator.auditAccount(body.address);
    const { persisted, findings } = await persistReport(deps, report);
    return reply.status(201).send(serializeInlineReport(persisted, findings));
  });

  app.post("/audit/contract", async (request, reply) => {
    const ctx = await actor(request, deps.authenticate);
    const body = request.body as { address?: unknown } | null;
    if (!body || typeof body.address !== "string") {
      throw new BlockchainValidationError("address must be a string");
    }
    if (!TRON_ADDRESS_PATTERN.test(body.address)) {
      throw new BlockchainValidationError("address must be a valid TRON Base58Check address");
    }
    await deps.rateLimiter.consume("block_collect", ctx.actorId);

    const report = await deps.orchestrator.auditContract(body.address);
    const { persisted, findings } = await persistReport(deps, report);
    return reply.status(201).send(serializeInlineReport(persisted, findings));
  });

  app.post("/audit/full", async (request, reply) => {
    const ctx = await actor(request, deps.authenticate);
    await deps.rateLimiter.consume("block_collect", ctx.actorId);

    const report = await deps.orchestrator.auditFull();
    const { persisted, findings } = await persistReport(deps, report);
    return reply.status(201).send(serializeInlineReport(persisted, findings));
  });

  app.get("/audit/reports", async (request) => {
    const query = request.query as { limit?: string; offset?: string; target?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);

    if (query.target) {
      const reports = await deps.database.transaction((tx) =>
        deps.repository.findReportsByTarget(tx, query.target!, limit, offset),
      );
      return { reports: reports.map(serializeReport), limit, offset };
    }

    const reports = await deps.database.transaction((tx) =>
      deps.repository.findReportsByNetwork(tx, deps.networkId, limit, offset),
    );
    return { reports: reports.map(serializeReport), limit, offset };
  });

  app.get("/audit/reports/:reportId", async (request) => {
    const { reportId } = request.params as { reportId?: string };
    if (!reportId) throw new BlockchainValidationError("reportId is required");

    const report = await deps.database.transaction((tx) =>
      deps.repository.findReportById(tx, reportId),
    );
    if (!report) throw new BlockchainNotFoundError(`Report ${reportId} not found`);
    return serializeReport(report);
  });

  app.get("/audit/reports/:reportId/findings", async (request) => {
    const { reportId } = request.params as { reportId?: string };
    if (!reportId) throw new BlockchainValidationError("reportId is required");

    const query = request.query as { severity?: string };

    const report = await deps.database.transaction((tx) =>
      deps.repository.findReportById(tx, reportId),
    );
    if (!report) throw new BlockchainNotFoundError(`Report ${reportId} not found`);

    if (query.severity) {
      if (!VALID_SEVERITIES.has(query.severity)) {
        throw new BlockchainValidationError(
          `severity must be one of: CRITICAL, HIGH, MEDIUM, LOW, INFO`,
        );
      }
      const findings = await deps.database.transaction((tx) =>
        deps.repository.findFindingsByReportAndSeverity(tx, reportId, query.severity as Severity),
      );
      return { findings: findings.map(serializeFinding) };
    }

    const findings = await deps.database.transaction((tx) =>
      deps.repository.findFindingsByReport(tx, reportId),
    );
    return { findings: findings.map(serializeFinding) };
  });

  return app;
}
