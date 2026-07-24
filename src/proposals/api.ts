import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import {
  ProposalAuthenticationRequiredError,
  ProposalConflictError,
  ProposalForbiddenError,
  ProposalNotFoundError,
  ProposalValidationError,
} from "./errors.js";
import type {
  ActorContext,
  CreateProposalInput,
  TransitionProposalInput,
  UpdateProposalInput,
} from "./model.js";
import type { ProposalService } from "./proposal-service.js";

export type ProposalAuthenticator = (
  request: FastifyRequest,
) => Promise<ActorContext | undefined>;

export interface ProposalApiDependencies {
  readonly proposals: ProposalService;
  readonly authenticate: ProposalAuthenticator;
}

function publicId(request: FastifyRequest): string {
  const params = request.params as { publicId?: unknown };
  if (typeof params.publicId !== "string") {
    throw new ProposalValidationError("publicId is required");
  }
  return params.publicId;
}

function bodyObject<Body>(request: FastifyRequest): Body {
  if (
    request.body === null ||
    typeof request.body !== "object" ||
    Array.isArray(request.body)
  ) {
    throw new ProposalValidationError("A JSON object body is required");
  }
  return request.body as Body;
}

async function actor(
  request: FastifyRequest,
  authenticate: ProposalAuthenticator,
): Promise<ActorContext> {
  const context = await authenticate(request);
  if (!context) throw new ProposalAuthenticationRequiredError();
  return context;
}

export function buildProposalApi(
  dependencies: ProposalApiDependencies,
): FastifyInstance {
  const application = Fastify({
    logger: false,
    bodyLimit: 25_000,
    requestTimeout: 10_000,
  });

  application.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProposalValidationError) {
      return reply.status(400).send({ error: "INVALID_REQUEST" });
    }
    if (error instanceof ProposalAuthenticationRequiredError) {
      return reply.status(401).send({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (error instanceof ProposalForbiddenError) {
      return reply.status(403).send({ error: "FORBIDDEN" });
    }
    if (error instanceof ProposalNotFoundError) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    if (error instanceof ProposalConflictError) {
      return reply.status(409).send({ error: "CONFLICT" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  application.post("/proposals", async (request, reply) => {
    const context = await actor(request, dependencies.authenticate);
    const created = await dependencies.proposals.create(
      context,
      bodyObject<CreateProposalInput>(request),
    );
    return reply.status(201).send(created);
  });

  application.get("/proposals", async (request) => {
    const context = await dependencies.authenticate(request);
    const query = request.query as { limit?: string; offset?: string };
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    return dependencies.proposals.list(context, limit, offset);
  });

  application.get("/proposals/:publicId", async (request) => {
    const context = await dependencies.authenticate(request);
    return dependencies.proposals.get(publicId(request), context);
  });

  application.patch("/proposals/:publicId", async (request) => {
    const context = await actor(request, dependencies.authenticate);
    return dependencies.proposals.update(
      context,
      publicId(request),
      bodyObject<UpdateProposalInput>(request),
    );
  });

  application.post("/proposals/:publicId/open", async (request) => {
    const context = await actor(request, dependencies.authenticate);
    return dependencies.proposals.open(
      context,
      publicId(request),
      bodyObject<TransitionProposalInput>(request),
    );
  });

  application.post("/proposals/:publicId/archive", async (request) => {
    const context = await actor(request, dependencies.authenticate);
    return dependencies.proposals.archive(
      context,
      publicId(request),
      bodyObject<TransitionProposalInput>(request),
    );
  });

  application.delete("/proposals/:publicId", async (request, reply) => {
    const context = await actor(request, dependencies.authenticate);
    await dependencies.proposals.delete(
      context,
      publicId(request),
      bodyObject<TransitionProposalInput>(request),
    );
    return reply.status(204).send();
  });

  return application;
}
