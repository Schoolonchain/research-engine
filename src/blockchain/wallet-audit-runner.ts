import type { TronNetworkMetrics } from "./network-metrics-collector.js";
import type { TronGovernanceData } from "./tron-governance-collector.js";
import type { ResourceRankingsData } from "./resource-rankings-collector.js";
import type { AuditFinding } from "./audit-analyzer.js";
import type { WalletRegistryResult } from "./wallet-registry.js";
import type { PowerIndexResult } from "./power-index.js";
import type { WalletAuditSnapshot, NetworkSummary, SnapshotStore } from "./snapshot-store.js";
import { buildWalletRegistry } from "./wallet-registry.js";
import { computePowerIndex } from "./power-index.js";
import { generateSnapshotId } from "./snapshot-store.js";
import { detectRisks } from "./risk-detector.js";

export interface WalletAuditInput {
  readonly networkMetrics: TronNetworkMetrics;
  readonly governance: TronGovernanceData | null;
  readonly resourceRankings: ResourceRankingsData;
}

export interface WalletAuditResult {
  readonly registry: WalletRegistryResult;
  readonly powerIndex: PowerIndexResult;
  readonly alerts: readonly AuditFinding[];
  readonly snapshotId: string;
  readonly snapshotCreatedAt: Date;
  readonly previousSnapshotId: string | null;
}

export function runWalletAudit(
  input: WalletAuditInput,
  store: SnapshotStore,
): WalletAuditResult {
  // Step 1: Build wallet registry
  const registry = buildWalletRegistry(
    input.networkMetrics,
    input.governance,
    input.resourceRankings,
  );

  // Step 2: Compute power index
  const powerIndex = computePowerIndex(registry);

  // Step 3: Build network summary
  const networkSummary: NetworkSummary = Object.freeze({
    totalStakedTrx: input.networkMetrics.staking.totalStakedTrx,
    stakingRatio: input.networkMetrics.stakingRatio,
    totalVotes: input.governance?.totalVotes ?? 0,
    electedSRCount: input.governance?.electedCount ?? 0,
    topHolderCount: input.networkMetrics.topHolders.length,
  });

  // Step 4: Create and store snapshot
  const snapshotId = generateSnapshotId();
  const createdAt = new Date();
  const snapshot: WalletAuditSnapshot = Object.freeze({
    id: snapshotId,
    registry,
    powerIndex,
    networkSummary,
    createdAt,
  });

  const previousSnapshot = store.getLatest();
  store.save(snapshot);

  // Step 5: Run risk detection
  const alerts = detectRisks(snapshot, previousSnapshot);

  return Object.freeze({
    registry,
    powerIndex,
    alerts,
    snapshotId,
    snapshotCreatedAt: createdAt,
    previousSnapshotId: previousSnapshot?.id ?? null,
  });
}
