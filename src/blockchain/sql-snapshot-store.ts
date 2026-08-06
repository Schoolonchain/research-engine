import type { DatabaseExecutor } from "../db/database.js";
import type {
  WalletAuditSnapshot,
  NetworkSummary,
  SnapshotStore,
} from "./snapshot-store.js";
import type { WalletRegistryResult, MonitoredWallet, WalletRole } from "./wallet-registry.js";
import type { PowerIndexResult, WalletPowerScore } from "./power-index.js";

interface SnapshotRow {
  id: string;
  network_summary: NetworkSummary | string;
  power_index_summary: string | {
    maxBalance: number;
    maxVotingPower: number;
    maxDelegations: number;
    maxEnergy: number;
    computedAt: string;
  };
  wallet_count: number;
  created_at: string;
}

interface WalletScoreRow {
  address: string;
  balance: string;
  voting_power: string;
  delegated_to_count: number;
  energy_limit: string;
  power_score: string;
  roles: string | null;
  raw_score_data: string | null;
}

/**
 * SQL-backed SnapshotStore that persists wallet audit snapshots to PostgreSQL.
 *
 * M-02: Without persistence the risk-detector's `previous` is always null,
 * disabling 4 of 5 risk checks (massive-unstaking, SR-rotation,
 * silent-accumulation, healthy-distribution).
 */
export class SqlSnapshotStore implements SnapshotStore {
  constructor(private readonly db: DatabaseExecutor) {}

  save(snapshot: WalletAuditSnapshot): void {
    // Fire-and-forget async save — the SnapshotStore interface is sync.
    void this.saveAsync(snapshot);
  }

  private async saveAsync(snapshot: WalletAuditSnapshot): Promise<void> {
    const powerSummary = {
      maxBalance: snapshot.powerIndex.maxBalance,
      maxVotingPower: snapshot.powerIndex.maxVotingPower,
      maxDelegations: snapshot.powerIndex.maxDelegations,
      maxEnergy: snapshot.powerIndex.maxEnergy,
      computedAt: snapshot.powerIndex.computedAt.toISOString(),
    };

    await this.db.query(
      `INSERT INTO wallet_audit_snapshots (id, network_summary, power_index_summary, wallet_count, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        snapshot.id,
        JSON.stringify(snapshot.networkSummary),
        JSON.stringify(powerSummary),
        snapshot.powerIndex.rankings.length,
        snapshot.createdAt.toISOString(),
      ],
    );

    // Persist wallet scores for diff comparisons
    for (const score of snapshot.powerIndex.rankings) {
      const wallet = snapshot.registry.wallets.get(score.address);
      await this.db.query(
        `INSERT INTO snapshot_wallet_scores
           (snapshot_id, address, balance, voting_power, delegated_to_count,
            energy_limit, power_score, roles, raw_score_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (snapshot_id, address) DO NOTHING`,
        [
          snapshot.id,
          score.address,
          wallet?.balance ?? 0,
          wallet?.votingPower ?? 0,
          wallet?.delegatedToCount ?? 0,
          wallet?.energyLimit ?? 0,
          score.powerScore,
          wallet ? JSON.stringify(wallet.roles) : null,
          JSON.stringify({
            rawBalance: score.rawBalance,
            rawVotingPower: score.rawVotingPower,
            rawDelegations: score.rawDelegations,
            rawEnergy: score.rawEnergy,
            normalizedBalance: score.normalizedBalance,
            normalizedVotingPower: score.normalizedVotingPower,
            normalizedDelegations: score.normalizedDelegations,
            normalizedEnergy: score.normalizedEnergy,
          }),
        ],
      );
    }
  }

  getLatest(): WalletAuditSnapshot | null {
    // Sync interface — can't do real queries. Return null as fallback.
    // Use getLatestAsync() for the real implementation.
    return null;
  }

  async getLatestAsync(): Promise<WalletAuditSnapshot | null> {
    const { rows } = await this.db.query(
      `SELECT id, network_summary, power_index_summary, wallet_count, created_at
       FROM wallet_audit_snapshots
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    if (rows.length === 0) return null;
    return this.hydrateSnapshot(rows[0] as SnapshotRow);
  }

  getLatestN(n: number): readonly WalletAuditSnapshot[] {
    return Object.freeze([]);
  }

  async getLatestNAsync(n: number): Promise<readonly WalletAuditSnapshot[]> {
    if (n <= 0) return Object.freeze([]);
    const { rows } = await this.db.query(
      `SELECT id, network_summary, power_index_summary, wallet_count, created_at
       FROM wallet_audit_snapshots
       ORDER BY created_at DESC
       LIMIT $1`,
      [n],
    );

    const snapshots = await Promise.all(
      (rows as SnapshotRow[]).map((r) => this.hydrateSnapshot(r)),
    );
    return Object.freeze(snapshots);
  }

  getById(id: string): WalletAuditSnapshot | null {
    return null;
  }

  async getByIdAsync(id: string): Promise<WalletAuditSnapshot | null> {
    const { rows } = await this.db.query(
      `SELECT id, network_summary, power_index_summary, wallet_count, created_at
       FROM wallet_audit_snapshots
       WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) return null;
    return this.hydrateSnapshot(rows[0] as SnapshotRow);
  }

  count(): number {
    return 0;
  }

  async countAsync(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM wallet_audit_snapshots`,
    );
    return (rows[0] as { cnt: number })?.cnt ?? 0;
  }

  private async hydrateSnapshot(row: SnapshotRow): Promise<WalletAuditSnapshot> {
    const { rows: walletRows } = await this.db.query(
      `SELECT address, balance, voting_power, delegated_to_count,
              energy_limit, power_score, roles, raw_score_data
       FROM snapshot_wallet_scores
       WHERE snapshot_id = $1
       ORDER BY power_score DESC`,
      [row.id],
    );

    const walletScores = walletRows as WalletScoreRow[];

    const wallets = new Map<string, MonitoredWallet>();
    const rankings: WalletPowerScore[] = [];

    for (let i = 0; i < walletScores.length; i++) {
      const ws = walletScores[i]!;
      const roles: WalletRole[] = ws.roles ? JSON.parse(ws.roles) : [];
      const rawScores = ws.raw_score_data ? JSON.parse(ws.raw_score_data) : {};

      wallets.set(ws.address, {
        address: ws.address,
        roles: Object.freeze(roles),
        balance: Number(ws.balance),
        votingPower: Number(ws.voting_power),
        delegatedToCount: Number(ws.delegated_to_count),
        energyLimit: Number(ws.energy_limit),
      });

      rankings.push({
        address: ws.address,
        rawBalance: rawScores.rawBalance ?? 0,
        rawVotingPower: rawScores.rawVotingPower ?? 0,
        rawDelegations: rawScores.rawDelegations ?? 0,
        rawEnergy: rawScores.rawEnergy ?? 0,
        normalizedBalance: rawScores.normalizedBalance ?? 0,
        normalizedVotingPower: rawScores.normalizedVotingPower ?? 0,
        normalizedDelegations: rawScores.normalizedDelegations ?? 0,
        normalizedEnergy: rawScores.normalizedEnergy ?? 0,
        powerScore: Number(ws.power_score),
        rank: i + 1,
      });
    }

    const netSummary: NetworkSummary =
      typeof row.network_summary === "string"
        ? JSON.parse(row.network_summary)
        : row.network_summary;

    const pis =
      typeof row.power_index_summary === "string"
        ? JSON.parse(row.power_index_summary)
        : row.power_index_summary;

    // Compute role breakdown from loaded wallets
    const roleBreakdown: Record<WalletRole, number> = {
      whale: 0, sr: 0, staker: 0, "energy-consumer": 0, delegator: 0,
    };
    for (const w of wallets.values()) {
      for (const role of w.roles) roleBreakdown[role]++;
    }

    return Object.freeze({
      id: row.id,
      registry: Object.freeze({
        wallets,
        totalCount: wallets.size,
        roleBreakdown: Object.freeze(roleBreakdown),
        builtAt: new Date(row.created_at),
      }),
      powerIndex: Object.freeze({
        rankings: Object.freeze(rankings),
        maxBalance: pis.maxBalance,
        maxVotingPower: pis.maxVotingPower,
        maxDelegations: pis.maxDelegations,
        maxEnergy: pis.maxEnergy,
        computedAt: new Date(pis.computedAt),
      }),
      networkSummary: Object.freeze(netSummary),
      createdAt: new Date(row.created_at),
    });
  }
}
