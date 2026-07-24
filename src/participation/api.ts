import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import {
  DuplicateSupportError,
  ParticipationAuthenticationRequiredError,
  ParticipationContentionError,
  ParticipationConflictError,
  ParticipationRateLimitError,
  ParticipationValidationError,
  SupportNotFoundError,
} from "./errors.js";
import type { ParticipationIdentity } from "./model.js";
import type { SupportService } from "./support-service.js";

export type ParticipationIdentityResolver = (
  request: FastifyRequest,
) => Promise<ParticipationIdentity | undefined>;

export interface ParticipationApiDependencies {
  readonly supports: Pick<SupportService, "add" | "revoke">;
  readonly resolveIdentity: ParticipationIdentityResolver;
}

function proposalPublicId(request: FastifyRequest): string {
  const value = (request.params as { publicId?: unknown }).publicId;
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new ParticipationValidationError("Invalid proposal public ID");
  }
  return value;
}

async function identity(
  request: FastifyRequest,
  resolve: ParticipationIdentityResolver,
): Promise<ParticipationIdentity> {
  const resolved = await resolve(request);
  if (!resolved) throw new ParticipationAuthenticationRequiredError();
  return resolved;
}

function honeypotTriggered(request: FastifyRequest): boolean {
  if (
    request.body === null ||
    typeof request.body !== "object" ||
    Array.isArray(request.body)
  ) {
    return false;
  }
  const website = (request.body as { website?: unknown }).website;
  return typeof website === "string" && website.trim().length > 0;
}

export function buildParticipationApi(
  dependencies: ParticipationApiDependencies,
): FastifyInstance {
  const application = Fastify({
    logger: false,
    bodyLimit: 1_024,
    requestTimeout: 10_000,
  });

  application.setErrorHandler((error, _request, reply) => {
    if (error instanceof ParticipationValidationError) {
      return reply.status(400).send({ error: "INVALID_REQUEST" });
    }
    if (error instanceof ParticipationAuthenticationRequiredError) {
      return reply.status(401).send({ error: "PARTICIPATION_IDENTITY_REQUIRED" });
    }
    if (error instanceof ParticipationRateLimitError) {
      return reply
        .header("retry-after", String(error.retryAfterSeconds))
        .status(429)
        .send({ error: "RATE_LIMITED" });
    }
    if (error instanceof ParticipationContentionError) {
      return reply
        .header("retry-after", "1")
        .status(503)
        .send({ error: "TEMPORARY_CONTENTION" });
    }
    if (
      error instanceof DuplicateSupportError ||
      error instanceof ParticipationConflictError
    ) {
      return reply.status(409).send({ error: "CONFLICT" });
    }
    if (error instanceof SupportNotFoundError) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  application.post("/proposals/:publicId/supports", async (request, reply) => {
    if (honeypotTriggered(request)) {
      return reply.status(202).send({ status: "accepted" });
    }
    const result = await dependencies.supports.add(
      await identity(request, dependencies.resolveIdentity),
      proposalPublicId(request),
    );
    return reply.status(201).send(result);
  });

  application.delete(
    "/proposals/:publicId/supports/me",
    async (request) =>
      dependencies.supports.revoke(
        await identity(request, dependencies.resolveIdentity),
        proposalPublicId(request),
      ),
  );

  return application;
}
