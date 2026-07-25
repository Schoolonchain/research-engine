import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { ScorePolicyConfig } from "../scoring/model.js";
import {
  type ScorePolicyManager,
  validateScorePolicy,
} from "../scoring/policy-manager.js";
import type { AdministrationService } from "./administration-service.js";
import {
  AdministrativeAuthenticationError,
  AdministrativeAuthorizationError,
  AdministrativeNotFoundError,
  AdministrativeReauthenticationRequiredError,
  AdministrativeValidationError,
} from "./errors.js";
import type {
  ModeratedEntityType,
  ModerationDecision,
  VerifiedFederatedPrincipal,
} from "./model.js";
import type { AdministrativeSessionService } from "./session-service.js";

export interface AdministrationApiDependencies {
  readonly sessions: AdministrativeSessionService;
  readonly administration: AdministrationService;
  readonly policies: ScorePolicyManager;
  readonly verifyFederatedIdentity: (
    request: FastifyRequest,
  ) => Promise<VerifiedFederatedPrincipal | undefined>;
}

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new AdministrativeValidationError("JSON object required");
  }
  return request.body as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AdministrativeValidationError(`${label} is required`);
  }
  return value;
}

export function buildAdministrationApi(
  dependencies: AdministrationApiDependencies,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 10_000, requestTimeout: 10_000 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdministrativeValidationError) {
      return reply.status(400).send({ error: "INVALID_REQUEST" });
    }
    if (error instanceof AdministrativeAuthenticationError) {
      return reply.status(401).send({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (
      error instanceof AdministrativeAuthorizationError ||
      error instanceof AdministrativeReauthenticationRequiredError
    ) {
      return reply.status(403).send({ error: "FORBIDDEN" });
    }
    if (error instanceof AdministrativeNotFoundError) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  app.post("/admin/sessions", async (request, reply) => {
    const principal = await dependencies.verifyFederatedIdentity(request);
    if (!principal) throw new AdministrativeAuthenticationError("IdP proof required");
    return reply.status(201).send(await dependencies.sessions.issue(principal));
  });

  app.delete("/admin/session", async (request, reply) => {
    const context = await dependencies.sessions.authenticate(
      bearer(request),
      request.headers["x-csrf-token"] as string | undefined,
      true,
    );
    await dependencies.sessions.revoke(context);
    return reply.status(204).send();
  });

  app.get("/admin/eligible", async (request) => {
    const context = await dependencies.sessions.authenticate(bearer(request));
    const query = request.query as { limit?: string };
    return dependencies.administration.listEligible(
      context,
      query.limit === undefined ? 50 : Number(query.limit),
    );
  });

  app.post("/admin/moderation/:entityType/:publicId", async (request, reply) => {
    const context = await dependencies.sessions.authenticate(
      bearer(request),
      request.headers["x-csrf-token"] as string | undefined,
      true,
    );
    const params = request.params as { entityType?: unknown; publicId?: unknown };
    const input = body(request);
    const entityType = string(params.entityType, "entityType").toUpperCase();
    if (!["SOURCE", "CLAIM", "EVIDENCE"].includes(entityType)) {
      throw new AdministrativeValidationError("Invalid entity type");
    }
    await dependencies.administration.moderate(
      context,
      entityType as ModeratedEntityType,
      string(params.publicId, "publicId"),
      string(input["decision"], "decision") as ModerationDecision,
      string(input["reason"], "reason"),
    );
    return reply.status(204).send();
  });

  app.post("/admin/score-policies/activate", async (request, reply) => {
    const context = await dependencies.sessions.authenticate(
      bearer(request),
      request.headers["x-csrf-token"] as string | undefined,
      true,
    );
    const input = body(request);
    const allowed = new Set([
      "version", "priorityThreshold", "progressThreshold",
      "confidenceThreshold", "minimumSupports",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new AdministrativeValidationError("Unknown policy property");
    }
    const policy = input as unknown as ScorePolicyConfig;
    try {
      validateScorePolicy(policy);
    } catch {
      throw new AdministrativeValidationError("Invalid score policy");
    }
    await dependencies.policies.activate(context, policy);
    return reply.status(204).send();
  });

  return app;
}
