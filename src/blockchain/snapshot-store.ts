import type { WalletRegistryResult } from "./wallet-registry.js";
import type { PowerIndexResult } from "./power-index.js";

export interface NetworkSummary {
  readonly totalStakedTrx: number;
  readonly stakingRatio: number;
  readonly totalVotes: number;
  readonly electedSRCount: number;
  readonly topHolderCount: number;
}

export interface WalletAuditSnapshot {
  readonly id: string;
  readonly registry: WalletRegistryResult;
  readonly powerIndex: PowerIndexResult;
  readonly networkSummary: NetworkSummary;
  readonly createdAt: Date;
}

export interface SnapshotStore {
  save(snapshot: WalletAuditSnapshot): void;
  getLatest(): WalletAuditSnapshot | null;
  getLatestN(n: number): readonly WalletAuditSnapshot[];
  getById(id: string): WalletAuditSnapshot | null;
  count(): number;
}

let nextSnapshotCounter = 0;

export function generateSnapshotId(): string {
  const timestamp = Date.now();
  const counter = nextSnapshotCounter++;
  return `snap-${timestamp}-${counter}`;
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots: WalletAuditSnapshot[] = [];

  save(snapshot: WalletAuditSnapshot): void {
    this.snapshots.push(snapshot);
  }

  getLatest(): WalletAuditSnapshot | null {
    if (this.snapshots.length === 0) return null;
    return this.snapshots[this.snapshots.length - 1]!;
  }

  getLatestN(n: number): readonly WalletAuditSnapshot[] {
    if (n <= 0) return Object.freeze([]);
    const start = Math.max(0, this.snapshots.length - n);
    return Object.freeze(this.snapshots.slice(start));
  }

  getById(id: string): WalletAuditSnapshot | null {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }

  count(): number {
    return this.snapshots.length;
  }
}
