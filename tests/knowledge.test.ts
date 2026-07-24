import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DatabaseExecutor,
  DatabaseResult,
  TransactionalDatabase,
} from "../src/db/database.js";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { KnowledgeConflictError, KnowledgeNotFoundError, UnsafeSourceError } from "../src/knowledge/errors.js";
import { KnowledgeService } from "../src/knowledge/knowledge-service.js";
import { buildKnowledgeApi } from "../src/knowledge/api.js";
import { SafeSourceFetcher } from "../src/knowledge/safe-fetcher.js";
import type { ActorContext } from "../src/proposals/model.js";
import { ProposalService } from "../src/proposals/proposal-service.js";

class Executor implements DatabaseExecutor {
  public constructor(private readonly database: PGlite | Transaction) {}
  public async query<Row>(sql: string, values: readonly unknown[] = []): Promise<DatabaseResult<Row>> {
    const result = await this.database.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}
class Database implements TransactionalDatabase {
  public constructor(private readonly database: PGlite) {}
  public transaction<Result>(operation: (transaction: DatabaseExecutor) => Promise<Result>): Promise<Result> {
    return this.database.transaction((transaction) => operation(new Executor(transaction)));
  }
}

describe("Phase 5 knowledge contributions", () => {
  let raw: PGlite;
  let knowledge: KnowledgeService;
  let proposals: ProposalService;
  let actor: ActorContext;
  let proposalPublicId: string;

  beforeEach(async () => {
    raw = new PGlite();
    await migrate(
      { query: (sql: string, values: readonly unknown[] = []) =>
        values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
      await loadMigrations(),
    );
    const database = new Database(raw);
    knowledge = new KnowledgeService(database);
    proposals = new ProposalService(database);
    const inserted = await raw.query<{ id: string }>("INSERT INTO actors (kind) VALUES ('USER') RETURNING id");
    actor = { actorId: inserted.rows[0]!.id, role: "USER" };
    const created = await proposals.create(actor, {
      title: "Evidence proposal",
      centralQuestion: "What does the evidence establish?",
    });
    proposalPublicId = (await proposals.open(actor, created.publicId, { expectedVersion: 1 })).publicId;
  });

  afterEach(async () => raw.close());

  it("canonicalizes and deduplicates URL sources without creating research work", async () => {
    const source = await knowledge.addUrlSource(actor, proposalPublicId, {
      url: "HTTPS://Example.COM:443/article?utm_source=x&b=2&a=1#fragment",
      title: "  Example ",
    });
    expect(source.canonicalUrl).toBe("https://example.com/article?a=1&b=2");
    expect(source.title).toBe("Example");
    await expect(
      knowledge.addUrlSource(actor, proposalPublicId, {
        url: "https://example.com/article?b=2&a=1",
      }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    const jobs = await raw.query<{ count: number }>("SELECT count(*)::int AS count FROM research_jobs");
    expect(jobs.rows[0]?.count).toBe(0);
  });

  it("keeps claim and evidence separate and auditable", async () => {
    const source = await knowledge.addUrlSource(actor, proposalPublicId, { url: "https://example.org/paper" });
    const claim = await knowledge.addClaim(actor, proposalPublicId, {
      sourcePublicId: source.publicId,
      statement: "The reported effect is measurable.",
      classification: "CLAIM",
    });
    const evidence = await knowledge.addEvidence(actor, claim.publicId, {
      sourcePublicId: source.publicId,
      stance: "SUPPORTS",
      locator: "page 4",
      excerpt: "<script>alert(1)</script>",
    });
    expect(evidence.claimPublicId).toBe(claim.publicId);
    expect(evidence.excerpt).toBe("<script>alert(1)</script>");
    const audit = await raw.query<{ event_type: string }>(
      "SELECT event_type FROM domain_events WHERE event_type LIKE '%_added' ORDER BY recorded_at",
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "source_added", "claim_added", "evidence_added",
    ]);
  });

  it("rejects cross-proposal evidence relationships", async () => {
    const source = await knowledge.addUrlSource(actor, proposalPublicId, { url: "https://example.org/source" });
    const claim = await knowledge.addClaim(actor, proposalPublicId, { statement: "A claim" });
    const other = await proposals.create(actor, { title: "Other", centralQuestion: "Other evidence?" });
    const opened = await proposals.open(actor, other.publicId, { expectedVersion: 1 });
    const foreignSource = await knowledge.addUrlSource(actor, opened.publicId, { url: "https://example.net/foreign" });
    await expect(
      knowledge.addEvidence(actor, claim.publicId, {
        sourcePublicId: foreignSource.publicId,
        stance: "CONTRADICTS",
      }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    expect(source.publicId).not.toBe(foreignSource.publicId);
  });

  it("exposes authenticated contribution routes without accepting actor identity", async () => {
    const app = buildKnowledgeApi({
      knowledge,
      authenticate: async (request) =>
        request.headers.authorization === "Bearer valid" ? actor : undefined,
    });
    const denied = await app.inject({
      method: "POST",
      url: `/proposals/${proposalPublicId}/sources`,
      payload: { url: "https://example.com" },
    });
    expect(denied.statusCode).toBe(401);
    const created = await app.inject({
      method: "POST",
      url: `/proposals/${proposalPublicId}/sources`,
      headers: { authorization: "Bearer valid" },
      payload: { url: "https://example.com", actorId: "spoofed" },
    });
    expect(created.statusCode).toBe(201);
    await app.close();
  });
});

describe("SSRF-resistant source fetch policy", () => {
  it("rejects private DNS answers before transport", async () => {
    let calls = 0;
    const fetcher = new SafeSourceFetcher(
      { resolve: async () => ["127.0.0.1"] },
      { request: async () => {
        calls += 1;
        return { status: 200, contentType: "text/plain", body: new Uint8Array() };
      } },
    );
    await expect(fetcher.fetch("https://example.com")).rejects.toBeInstanceOf(UnsafeSourceError);
    expect(calls).toBe(0);
  });

  it("revalidates DNS after redirects and rejects internal targets", async () => {
    const fetcher = new SafeSourceFetcher(
      { resolve: async (host) => host === "safe.example" ? ["93.184.216.34"] : ["10.0.0.1"] },
      { request: async () => ({
        status: 302,
        contentType: "text/plain",
        body: new Uint8Array(),
        redirectUrl: "http://internal.example/secret",
      }) },
    );
    await expect(fetcher.fetch("https://safe.example")).rejects.toBeInstanceOf(UnsafeSourceError);
  });

  it("enforces MIME and body size limits", async () => {
    const resolver = { resolve: async () => ["93.184.216.34"] };
    const wrongMime = new SafeSourceFetcher(resolver, {
      request: async () => ({
        status: 200,
        contentType: "application/octet-stream",
        body: new Uint8Array(1),
      }),
    });
    await expect(wrongMime.fetch("https://example.com")).rejects.toBeInstanceOf(UnsafeSourceError);
    const oversized = new SafeSourceFetcher(resolver, {
      request: async () => ({
        status: 200,
        contentType: "text/plain",
        contentLength: 2_000_000,
        body: new Uint8Array(1),
      }),
    });
    await expect(oversized.fetch("https://example.com")).rejects.toBeInstanceOf(UnsafeSourceError);
  });
});
