import { createHash } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdministrationService } from "../src/admin/administration-service.js";
import { buildAdministrationApi } from "../src/admin/api.js";
import {
  AdministrativeAuthenticationError,
  AdministrativeAuthorizationError,
  AdministrativeReauthenticationRequiredError,
} from "../src/admin/errors.js";
import type { AdministrativeContext, AdministrativeRole } from "../src/admin/model.js";
import { AdministrativeSessionService } from "../src/admin/session-service.js";
import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { ScorePolicyManager } from "../src/scoring/policy-manager.js";

class Executor implements DatabaseExecutor {
  public constructor(private readonly db: PGlite | Transaction) {}
  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.db.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}
class Database implements TransactionalDatabase {
  public constructor(private readonly db: PGlite) {}
  public transaction<Result>(
    operation: (tx: DatabaseExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.db.transaction((tx) => operation(new Executor(tx)));
  }
}

describe("Phase 7 administrative security", () => {
  let raw: PGlite;
  let database: Database;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length ? raw.query(sql, [...values]) : raw.exec(sql) },
      await loadMigrations(),
    );
    database = new Database(raw);
  });

  afterEach(async () => raw.close());

  async function identity(role: AdministrativeRole, subject: string): Promise<string> {
    const actor = await raw.query<{ id: string }>(
      "INSERT INTO actors (kind) VALUES ('ADMIN') RETURNING id",
    );
    const result = await raw.query<{ id: string }>(
      `INSERT INTO administrative_identities (actor_id, issuer, subject, role)
       VALUES ($1,'https://idp.example',$2,$3) RETURNING id`,
      [actor.rows[0]!.id, subject, role],
    );
    return result.rows[0]!.id;
  }

  async function context(
    role: AdministrativeRole,
    subject: string,
  ): Promise<{ context: AdministrativeContext; accessToken: string; csrfToken: string }> {
    await identity(role, subject);
    const sessions = new AdministrativeSessionService(database);
    const credentials = await sessions.issue({
      issuer: "https://idp.example",
      subject,
      authenticationMethods: ["pwd", "mfa"],
      authenticatedAt: new Date(),
    });
    return {
      context: await sessions.authenticate(
        credentials.accessToken,
        credentials.csrfToken,
        true,
      ),
      accessToken: credentials.accessToken,
      csrfToken: credentials.csrfToken,
    };
  }

  it("requires a pre-provisioned federated identity and MFA", async () => {
    const sessions = new AdministrativeSessionService(database);
    await identity("MODERATOR", "moderator");
    await expect(sessions.issue({
      issuer: "https://idp.example",
      subject: "moderator",
      authenticationMethods: ["pwd"],
      authenticatedAt: new Date(),
    })).rejects.toBeInstanceOf(AdministrativeAuthenticationError);
    await expect(sessions.issue({
      issuer: "https://idp.example",
      subject: "unknown",
      authenticationMethods: ["mfa"],
      authenticatedAt: new Date(),
    })).rejects.toBeInstanceOf(AdministrativeAuthenticationError);
  });

  it("stores only token hashes and enforces CSRF and revocation", async () => {
    const issued = await context("MODERATOR", "csrf-moderator");
    const sessions = new AdministrativeSessionService(database);
    await expect(
      sessions.authenticate(issued.accessToken, "wrong", true),
    ).rejects.toBeInstanceOf(AdministrativeAuthorizationError);
    const stored = await raw.query<{ token_hash: string; csrf_hash: string }>(
      "SELECT token_hash, csrf_hash FROM administrative_sessions",
    );
    expect(stored.rows[0]!.token_hash).toBe(
      createHash("sha256").update(issued.accessToken).digest("hex"),
    );
    expect(stored.rows[0]!.csrf_hash).not.toBe(issued.csrfToken);
    await sessions.revoke(issued.context);
    await expect(
      sessions.authenticate(issued.accessToken),
    ).rejects.toBeInstanceOf(AdministrativeAuthenticationError);
  });

  it("separates moderation role and records event, Outbox and immutable audit", async () => {
    const moderator = await context("MODERATOR", "moderation-user");
    const policyAdmin = await context("POLICY_ADMIN", "policy-user");
    const proposal = await raw.query<{ id: string }>(
      `INSERT INTO proposals (title, central_question)
       VALUES ('Moderation','Is this controlled?') RETURNING id`,
    );
    const source = await raw.query<{ public_id: string }>(
      `INSERT INTO sources (
        proposal_id, kind, original_url, canonical_url
       ) VALUES ($1,'URL','https://example.com','https://example.com/')
       RETURNING public_id`,
      [proposal.rows[0]!.id],
    );
    const administration = new AdministrationService(database);
    await expect(administration.moderate(
      policyAdmin.context, "SOURCE", source.rows[0]!.public_id,
      "ACCEPTED", "Attempted by wrong role",
    )).rejects.toBeInstanceOf(AdministrativeAuthorizationError);
    await administration.moderate(
      moderator.context, "SOURCE", source.rows[0]!.public_id,
      "ACCEPTED", "Source meets moderation policy",
    );
    const state = await raw.query<{
      status: string; audits: number; events: number; outbox: number; jobs: number; auth: number;
    }>(`
      SELECT (SELECT moderation_status FROM sources) AS status,
        (SELECT count(*)::int FROM administrative_action_audit) AS audits,
        (SELECT count(*)::int FROM domain_events
          WHERE event_type = 'moderation_decided') AS events,
        (SELECT count(*)::int FROM outbox_messages AS outbox
          JOIN domain_events AS event ON event.event_id = outbox.event_id
          WHERE event.event_type = 'moderation_decided') AS outbox,
        (SELECT count(*)::int FROM research_jobs) AS jobs,
        (SELECT count(*)::int FROM authorizations) AS auth
    `);
    expect(state.rows[0]).toEqual({
      status: "ACCEPTED", audits: 1, events: 1, outbox: 1, jobs: 0, auth: 0,
    });
    await expect(raw.query(
      "DELETE FROM administrative_action_audit",
    )).rejects.toThrow("append-only");
  });

  it("requires a live POLICY_ADMIN session and fresh reauthentication for activation", async () => {
    const policyAdmin = await context("POLICY_ADMIN", "fresh-policy-user");
    const manager = new ScorePolicyManager(database);
    await manager.activate(policyAdmin.context, {
      version: 1,
      priorityThreshold: 0.5,
      progressThreshold: 0.5,
      confidenceThreshold: 0.5,
      minimumSupports: 5,
    });
    await raw.query(
      `UPDATE administrative_sessions
       SET authenticated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes',
         reauthenticated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       WHERE id = $1`,
      [policyAdmin.context.sessionId],
    );
    await expect(manager.activate(policyAdmin.context, {
      version: 2,
      priorityThreshold: 0.6,
      progressThreshold: 0.6,
      confidenceThreshold: 0.6,
      minimumSupports: 6,
    })).rejects.toBeInstanceOf(AdministrativeReauthenticationRequiredError);
    expect((await raw.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM score_policy_activations",
    )).rows[0]!.count).toBe(1);
  });

  it("exposes an eligible review queue without creating authorization or jobs", async () => {
    const validator = await context("VALIDATOR", "validator");
    await raw.query(
      `INSERT INTO proposals (title, central_question, status)
       VALUES ('Eligible proposal','Can a validator inspect it?','ELIGIBLE')`,
    );
    const queue = await new AdministrationService(database)
      .listEligible(validator.context);
    expect(queue).toHaveLength(1);
    expect((await raw.query<{ authorizations: number; jobs: number }>(`
      SELECT (SELECT count(*)::int FROM authorizations) AS authorizations,
        (SELECT count(*)::int FROM research_jobs) AS jobs
    `)).rows[0]).toEqual({ authorizations: 0, jobs: 0 });
  });

  it("uses injected IdP proof and rejects claimed roles and CSRF bypasses", async () => {
    await identity("MODERATOR", "api-moderator");
    const sessions = new AdministrativeSessionService(database);
    const app = buildAdministrationApi({
      sessions,
      administration: new AdministrationService(database),
      policies: new ScorePolicyManager(database),
      verifyFederatedIdentity: async (request) =>
        request.headers["x-test-idp-proof"] === "verified"
          ? {
              issuer: "https://idp.example",
              subject: "api-moderator",
              authenticationMethods: ["mfa"],
              authenticatedAt: new Date(),
            }
          : undefined,
    });
    expect((await app.inject({
      method: "POST",
      url: "/admin/sessions",
      payload: { role: "POLICY_ADMIN", mfaVerified: true },
    })).statusCode).toBe(401);
    const issued = await app.inject({
      method: "POST",
      url: "/admin/sessions",
      headers: { "x-test-idp-proof": "verified" },
      payload: { role: "POLICY_ADMIN" },
    });
    const credentials = issued.json<{ accessToken: string; csrfToken: string }>();
    expect(issued.statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: "/admin/score-policies/activate",
      headers: { authorization: `Bearer ${credentials.accessToken}` },
      payload: {
        version: 1, priorityThreshold: 0.5, progressThreshold: 0.5,
        confidenceThreshold: 0.5, minimumSupports: 5,
      },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/admin/score-policies/activate",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "x-csrf-token": credentials.csrfToken,
      },
      payload: {
        version: 1, priorityThreshold: 0.5, progressThreshold: 0.5,
        confidenceThreshold: 0.5, minimumSupports: 5,
      },
    })).statusCode).toBe(403);
    await app.close();
  });
});
