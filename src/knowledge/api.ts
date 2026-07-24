import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { ActorContext } from "../proposals/model.js";
import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeRateLimitError,
  KnowledgeValidationError,
  UnsafeSourceError,
} from "./errors.js";
import type { KnowledgeService } from "./knowledge-service.js";
import type { AddClaimInput, AddEvidenceInput, AddUrlSourceInput } from "./model.js";

export type KnowledgeAuthenticator = (
  request: FastifyRequest,
) => Promise<ActorContext | undefined>;

export interface KnowledgeApiDependencies {
  readonly knowledge: KnowledgeService;
  readonly authenticate: KnowledgeAuthenticator;
}

function body<Body>(request: FastifyRequest, allowed: readonly string[]): Body {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new KnowledgeValidationError("A JSON object body is required");
  }
  const value = request.body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new KnowledgeValidationError("Unknown request property");
  }
  return value as Body;
}

function parameter(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.length > 100) {
    throw new KnowledgeValidationError(`Invalid ${name}`);
  }
  return value;
}

async function actor(
  request: FastifyRequest,
  authenticate: KnowledgeAuthenticator,
): Promise<ActorContext> {
  const context = await authenticate(request);
  if (!context) throw new KnowledgeNotFoundError("Authentication required");
  return context;
}

export function buildKnowledgeApi(
  dependencies: KnowledgeApiDependencies,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 45_000, requestTimeout: 10_000 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof KnowledgeValidationError || error instanceof UnsafeSourceError) {
      return reply.status(400).send({ error: "INVALID_REQUEST" });
    }
    if (error instanceof KnowledgeNotFoundError) {
      if (error.message === "Authentication required") {
        return reply.status(401).send({ error: "AUTHENTICATION_REQUIRED" });
      }
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    if (error instanceof KnowledgeConflictError) {
      return reply.status(409).send({ error: "CONFLICT" });
    }
    if (error instanceof KnowledgeRateLimitError) {
      return reply.header("retry-after", String(error.retryAfterSeconds))
        .status(429).send({ error: "RATE_LIMITED" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  app.post("/proposals/:proposalId/sources", async (request, reply) =>
    reply.status(201).send(
      await dependencies.knowledge.addUrlSource(
        await actor(request, dependencies.authenticate),
        parameter(request, "proposalId"),
        body<AddUrlSourceInput>(request, ["idempotencyKey", "url", "title"]),
      ),
    ));
  app.post("/proposals/:proposalId/claims", async (request, reply) =>
    reply.status(201).send(
      await dependencies.knowledge.addClaim(
        await actor(request, dependencies.authenticate),
        parameter(request, "proposalId"),
        body<AddClaimInput>(request, [
          "idempotencyKey", "sourcePublicId", "statement", "classification", "context",
        ]),
      ),
    ));
  app.post("/claims/:claimId/evidence", async (request, reply) =>
    reply.status(201).send(
      await dependencies.knowledge.addEvidence(
        await actor(request, dependencies.authenticate),
        parameter(request, "claimId"),
        body<AddEvidenceInput>(request, [
          "idempotencyKey", "sourcePublicId", "stance", "locator", "excerpt", "context",
        ]),
      ),
    ));
  return app;
}
