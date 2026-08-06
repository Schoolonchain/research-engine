import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadMigrations, migrate, type SqlExecutor } from "../src/db/migrations.js";
import { SqlSnapshotStore } from "../src/blockchain/sql-snapshot-store.js";
import type { WalletAuditSnapshot, NetworkSummary } from "../src/blockchain/snapshot-store.js";
import type { WalletRegistryResult, MonitoredWallet, WalletRole } from "../src/blockchain/wallet-registry.js";
import type { PowerIndexResult, WalletPowerScore } from "../src/blockchain/power-index.js";
import type { DatabaseExecutor } from "../src/db/database.js";

class PGliteExecutor implements SqlExecutor {
  public constructor(private readonly database: PGlite) {}
  public async query(sql: string, values: readonly unknown[] = []): Promise<unknown> {
    if (values.length === 0) return this.database.exec(sql);
    return this.database.query(sql, [...values]);
  }
}

function makeDbExecutor(db: PGlite): DatabaseExecutor {
  return {
    async query(sql: string, values: readonly unknown[] = []) {
      const result = await db.query(sql, [...values]);
      return { rows: result.rows as any[], rowCount: result.rows.length };
    },
  };
}

function makeSnapshot(id: string, walletCount = 2): WalletAuditSnapshot {
  const wallets = new Map<string, MonitoredWallet>();
  const rankings: WalletPowerScore[] = [];

  for (let i = 0; i < walletCount; i++) {
    const address = `TAddr${i + 1}`;
    const balance = (walletCount - i) * 100_000_000;
    const votingPower = (walletCount - i) * 50_000_000;
    const roles: WalletRole[] = i === 0 ? ["whale", "staker"] : ["staker"];

    wallets.set(address, {
      address,
      roles: Object.freeze(roles),
      balance,
      votingPower,
      delegatedToCount: i,
      energyLimit: 10_000 * (i + 1),
    });

    rankings.push({
      address,
      rawBalance: balance,
      rawVotingPower: votingPower,
      rawDelegations: i,
      rawEnergy: 10_000 * (i + 1),
      normalizedBalance: 100 - i * 50,
      normalizedVotingPower: 100 - i * 50,
      normalizedDelegations: i === 0 ? 0 : 100,
      normalizedEnergy: i === 0 ? 50 : 100,
      powerScore: 80 - i * 20,
      rank: i + 1,
    });
  }

  const registry: WalletRegistryResult = {
    wallets,
    totalCount: wallets.size,
    roleBreakdown: Object.freeze({
      whale: 1,
      sr: 0,
      staker: walletCount,
      "energy-consumer": 0,
      delegator: 0,
    }),
    builtAt: new Date("2025-06-01T12:00:00Z"),
  };

  const powerIndex: PowerIndexResult = {
    rankings: Object.freeze(rankings),
    maxBalance: 200_000_000,
    maxVotingPower: 100_000_000,
    maxDelegations: 1,
    maxEnergy: 20_000,
    weightConfig: Object.freeze({
      balance: 0.35,
      votingPower: 0.4,
      delegations: 0.05,
      energy: 0.2,
    }),
    computedAt: new Date("2025-06-01T12:00:00Z"),
  };

  const networkSummary: NetworkSummary = {
    totalStakedTrx: 40_000_000_000,
    stakingRatio: 0.4,
    totalVotes: 15_000_000_000,
    electedSRCount: 27,
    topHolderCount: 50,
  };

  return Object.freeze({
    id,
    registry: Object.freeze(registry),
    powerIndex: Object.freeze(powerIndex),
    networkSummary: Object.freeze(networkSummary),
    createdAt: new Date("2025-06-01T12:00:00Z"),
  });
}

describe("SqlSnapshotStore", () => {
  let database: PGlite;
  let dbExecutor: DatabaseExecutor;
  let store: SqlSnapshotStore;

  beforeEach(async () => {
    database = new PGlite();
    await migrate(
      new PGliteExecutor(database),
      await loadMigrations(),
    );
    dbExecutor = makeDbExecutor(database);
    store = new SqlSnapshotStore(dbExecutor);
  });

  afterEach(async () => {
    await database.close();
  });

  it("saves and retrieves a snapshot via async methods", { timeout: 15_000 }, async () => {
    const snapshot = makeSnapshot("snap-test-1");

    await store.saveAsync(snapshot);

    const retrieved = await store.getLatestAsync();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("snap-test-1");
    expect(retrieved!.powerIndex.rankings).toHaveLength(2);
    expect(retrieved!.powerIndex.rankings[0]!.address).toBe("TAddr1");
    expect(retrieved!.powerIndex.rankings[0]!.powerScore).toBe(80);
    expect(retrieved!.powerIndex.rankings[1]!.address).toBe("TAddr2");
    expect(retrieved!.registry.totalCount).toBe(2);
    expect(retrieved!.networkSummary.totalStakedTrx).toBe(40_000_000_000);
    expect(retrieved!.networkSummary.electedSRCount).toBe(27);
  });

  it("roundtrips wallet roles correctly", { timeout: 15_000 }, async () => {
    const snapshot = makeSnapshot("snap-test-roles");
    await store.saveAsync(snapshot);

    const retrieved = await store.getLatestAsync();
    const wallet = retrieved!.registry.wallets.get("TAddr1");
    expect(wallet).toBeDefined();
    expect(wallet!.roles).toContain("whale");
    expect(wallet!.roles).toContain("staker");
  });

  it("persists weightConfig in the power index summary", { timeout: 15_000 }, async () => {
    const snapshot = makeSnapshot("snap-test-weights");
    await store.saveAsync(snapshot);

    const retrieved = await store.getLatestAsync();
    expect(retrieved!.powerIndex.weightConfig).toEqual({
      balance: 0.35,
      votingPower: 0.4,
      delegations: 0.05,
      energy: 0.2,
    });
  });

  it("retrieves by ID", { timeout: 15_000 }, async () => {
    await store.saveAsync(makeSnapshot("snap-a"));
    await store.saveAsync(makeSnapshot("snap-b"));

    const a = await store.getByIdAsync("snap-a");
    const b = await store.getByIdAsync("snap-b");
    expect(a!.id).toBe("snap-a");
    expect(b!.id).toBe("snap-b");
    expect(await store.getByIdAsync("snap-nonexistent")).toBeNull();
  });

  it("counts snapshots", { timeout: 15_000 }, async () => {
    expect(await store.countAsync()).toBe(0);

    await store.saveAsync(makeSnapshot("snap-c1"));
    expect(await store.countAsync()).toBe(1);

    await store.saveAsync(makeSnapshot("snap-c2"));
    expect(await store.countAsync()).toBe(2);
  });

  it("returns latest N snapshots in reverse chronological order", { timeout: 15_000 }, async () => {
    // Insert with distinct created_at so ordering is deterministic
    const snap1 = { ...makeSnapshot("snap-n1"), createdAt: new Date("2025-06-01T12:00:00Z") };
    const snap2 = { ...makeSnapshot("snap-n2"), createdAt: new Date("2025-06-02T12:00:00Z") };
    const snap3 = { ...makeSnapshot("snap-n3"), createdAt: new Date("2025-06-03T12:00:00Z") };
    await store.saveAsync(snap1);
    await store.saveAsync(snap2);
    await store.saveAsync(snap3);

    const latest2 = await store.getLatestNAsync(2);
    expect(latest2).toHaveLength(2);
    expect(latest2[0]!.id).toBe("snap-n3");
    expect(latest2[1]!.id).toBe("snap-n2");
  });

  it("is idempotent — second save with same ID is ignored", { timeout: 15_000 }, async () => {
    const snapshot = makeSnapshot("snap-idem");
    await store.saveAsync(snapshot);
    await store.saveAsync(snapshot);

    expect(await store.countAsync()).toBe(1);
  });

  it("rolls back on error — no partial snapshots (Issue 3)", { timeout: 15_000 }, async () => {
    const snapshot = makeSnapshot("snap-txn");
    await store.saveAsync(snapshot);

    // Verify both tables have data
    const { rows: headerRows } = await dbExecutor.query(
      "SELECT id FROM wallet_audit_snapshots WHERE id = $1",
      ["snap-txn"],
    );
    expect(headerRows).toHaveLength(1);

    const { rows: walletRows } = await dbExecutor.query(
      "SELECT address FROM snapshot_wallet_scores WHERE snapshot_id = $1",
      ["snap-txn"],
    );
    expect(walletRows).toHaveLength(2);
  });

  it("save() logs errors instead of silently swallowing them (Issue 1)", { timeout: 15_000 }, async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Create a store with a broken executor that rejects
    const brokenExecutor: DatabaseExecutor = {
      async query() {
        throw new Error("connection lost");
      },
    };
    const brokenStore = new SqlSnapshotStore(brokenExecutor);
    const snapshot = makeSnapshot("snap-fail");

    brokenStore.save(snapshot);

    // Wait for the fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 100));

    expect(errorSpy).toHaveBeenCalledWith(
      "Snapshot save failed:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
