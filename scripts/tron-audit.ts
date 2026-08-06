import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { TronHttpClient } from "../src/blockchain/tron-http-client.js";
import { NetworkMetricsCollector } from "../src/blockchain/network-metrics-collector.js";
import { ResourceRankingsCollector } from "../src/blockchain/resource-rankings-collector.js";
import { Trc20RankingsCollector } from "../src/blockchain/trc20-rankings-collector.js";
import { EnergyRentalCollector, KNOWN_PLATFORMS } from "../src/blockchain/energy-rental-collector.js";
import { TronGovernanceCollector } from "../src/blockchain/tron-governance-collector.js";
import { OnchainAnalytics } from "../src/blockchain/onchain-analytics.js";
import { InMemoryMetricStore } from "../src/blockchain/in-memory-metric-store.js";
import { SqlMetricStore } from "../src/blockchain/sql-metric-store.js";
import { MetricCollectionOrchestrator } from "../src/blockchain/metric-orchestrator.js";
import { AddressLabelResolver, type AddressLabel } from "../src/blockchain/address-label-resolver.js";
import type { DatabaseExecutor } from "../src/db/database.js";

function makeExecutor(db: PGlite): DatabaseExecutor {
  return {
    async query(sql: string, values: readonly unknown[] = []) {
      const result = await db.query(sql, [...values]);
      return { rows: result.rows as any[], rowCount: result.rows.length };
    },
  };
}

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

async function main() {
  const t0 = Date.now();
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║        TRON BLOCKCHAIN — AUDITORÍA COMPLETA     ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const trongridKey = process.env["TRONGRID_API_KEY"];
  const tronscanKey = process.env["TRONSCAN_API_KEY"];

  const trongrid = new TronHttpClient({
    endpoint: "https://api.trongrid.io",
    apiKey: trongridKey,
    rateLimitPerSecond: trongridKey ? 15 : 5,
  });

  const tronscan = new TronHttpClient({
    endpoint: "https://apilist.tronscanapi.com",
    apiKey: tronscanKey,
    rateLimitPerSecond: tronscanKey ? 10 : 3,
  });

  // Secondary TronScan client — some holder endpoints only work on this host.
  const tronscanAlt = new TronHttpClient({
    endpoint: "https://apilist.tronscan.org",
    apiKey: tronscanKey,
    rateLimitPerSecond: tronscanKey ? 10 : 3,
  });

  console.log("1. Preparando base de datos...");
  const db = new PGlite();
  const executor = makeExecutor(db);
  await migrate(
    { query: (sql: string, vals: readonly unknown[] = []) =>
      vals.length === 0 ? db.exec(sql) : db.query(sql, [...vals]) },
    await loadMigrations(),
  );
  const sqlStore = new SqlMetricStore(executor);
  const memStore = new InMemoryMetricStore();
  const orchestrator = new MetricCollectionOrchestrator(memStore, "tron");
  const sqlOrchestrator = new MetricCollectionOrchestrator(sqlStore, "tron");
  console.log(`   Base de datos lista [${elapsed(t0)}]\n`);

  let totalMetrics = 0;

  async function persistToSql(label: string, fn: () => Promise<number>): Promise<void> {
    try {
      const n = await fn();
      console.log(`   [SQL] ${n} métricas persistidas`);
    } catch (err) {
      console.log(`   [SQL] Warning: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Collect raw data for JSON export
  const exportData: Record<string, unknown> = {};

  // ── Network Metrics ──
  console.log("2. Recolectando métricas de red (TronGrid)...");
  let t1 = Date.now();
  let networkData;
  try {
    const networkCollector = new NetworkMetricsCollector(trongrid, tronscan);
    networkData = await networkCollector.collect();
    const count = await orchestrator.ingestNetworkMetrics(networkData);
    totalMetrics += count;
    console.log(`   Energía fee: ${networkData.energy.energyFee} SUN`);
    console.log(`   Energía total: ${(networkData.energy.totalEnergyLimit / 1e9).toFixed(1)}B`);
    console.log(`   Bandwidth total: ${(networkData.bandwidth.totalNetLimit / 1e9).toFixed(1)}B`);
    console.log(`   Staking V1+V2 energía: ${(networkData.staking.stakedForEnergyTrx / 1e9).toFixed(2)}B TRX`);
    console.log(`   Staking V1+V2 ancho de banda: ${(networkData.staking.stakedForBandwidthTrx / 1e9).toFixed(2)}B TRX`);
    console.log(`   Total staked: ${(networkData.staking.totalStakedTrx / 1e9).toFixed(2)}B TRX`);
    console.log(`   Supply (${networkData.staking.supplySource}): ${(networkData.staking.totalSupplyTrx / 1e9).toFixed(1)}B TRX`);
    console.log(`   Staking ratio: ${(networkData.stakingRatio * 100).toFixed(1)}%`);
    console.log(`   Top holders: ${networkData.topHolders.length}`);
    console.log(`   → ${count} métricas [${elapsed(t1)}]`);
    await persistToSql("network", () => sqlOrchestrator.ingestNetworkMetrics(networkData!));

    exportData.network = {
      energy: networkData.energy,
      bandwidth: networkData.bandwidth,
      economics: networkData.economics,
      staking: networkData.staking,
      stakingRatio: networkData.stakingRatio,
      topHolders: networkData.topHolders.map(h => ({
        address: h.address,
        balance: h.balance,
        totalFrozen: h.totalFrozen,
        power: h.power,
        accountType: h.accountType ?? "unknown",
        ...(h.name ? { name: h.name } : {}),
      })),
    };
    console.log();
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }

  // ── Governance ──
  console.log("3. Recolectando gobernanza (TronGrid)...");
  t1 = Date.now();
  try {
    const govCollector = new TronGovernanceCollector(trongrid);
    const govData = await govCollector.collect({ scope: "full" });
    const count = await orchestrator.ingestGovernance(govData);
    totalMetrics += count;
    console.log(`   Super Representatives: ${govData.witnesses.length} (${govData.electedCount} elegidos)`);
    console.log(`   Propuestas: ${govData.proposals.length}`);
    console.log(`   Votos totales: ${(govData.totalVotes / 1e6).toFixed(1)}M`);
    console.log(`   → ${count} métricas [${elapsed(t1)}]`);
    await persistToSql("governance", () => sqlOrchestrator.ingestGovernance(govData));

    const topSRs = [...govData.witnesses]
      .sort((a, b) => b.voteCount - a.voteCount)
      .slice(0, 27);
    exportData.governance = {
      totalVotes: govData.totalVotes,
      electedCount: govData.electedCount,
      totalWitnesses: govData.witnesses.length,
      totalProposals: govData.proposals.length,
      topSuperRepresentatives: topSRs.map(w => ({
        address: w.address,
        url: w.url,
        isElected: w.isElected,
        voteCount: w.voteCount,
        totalProduced: w.totalProduced,
        totalMissed: w.totalMissed,
        productivityPct: w.productivityPct,
      })),
    };
    console.log();
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }

  // ── Resource Rankings ──
  console.log("4. Recolectando rankings de recursos (TronGrid + TronScan)...");
  t1 = Date.now();
  try {
    const resourceCollector = new ResourceRankingsCollector(trongrid, tronscan);
    const resourceData = await resourceCollector.collect();
    const count = await orchestrator.ingestResourceRankings(resourceData);
    totalMetrics += count;
    console.log(`   Top stakers (por poder): ${resourceData.topStakers.length}`);
    console.log(`   Top consumidores energía: ${resourceData.topEnergyConsumers.length}`);
    console.log(`   Top delegadores energía: ${resourceData.topEnergyDelegators.length}`);
    console.log(`   Delegaciones: ${resourceData.delegationSummaries.length}`);
    console.log(`   Top contratos: ${resourceData.topContracts.length}`);
    console.log(`   → ${count} métricas [${elapsed(t1)}]`);
    await persistToSql("resources", () => sqlOrchestrator.ingestResourceRankings(resourceData));

    const mapAccount = (s: typeof resourceData.topStakers[number]) => ({
      address: s.address,
      balance: s.balance,
      frozenForEnergy: s.frozenForEnergy,
      frozenForBandwidth: s.frozenForBandwidth,
      votingPower: s.votingPower,
      energyLimit: s.energyLimit,
      energyUsed: s.energyUsed,
      bandwidthLimit: s.bandwidthLimit,
      bandwidthUsed: s.bandwidthUsed,
    });

    exportData.resources = {
      topStakers: resourceData.topStakers.map(mapAccount),
      topEnergyConsumers: resourceData.topEnergyConsumers.map(mapAccount),
      topEnergyDelegators: resourceData.topEnergyDelegators.map(d => ({
        address: d.address,
        delegatedToCount: d.delegatedToCount,
        energyLimit: d.energyLimit,
        energyUsed: d.energyUsed,
      })),
      delegations: resourceData.delegationSummaries.map(d => ({
        address: d.address,
        delegatedToCount: d.delegatedToCount,
        receivedFromCount: d.receivedFromCount,
      })),
      topContracts: resourceData.topContracts.map(c => ({
        address: c.address,
        name: c.name,
        trxCount: c.trxCount,
        balance: c.balance,
        tag: c.tag,
      })),
    };
    console.log();
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }

  // ── TRC20 Token Rankings ──
  console.log("5. Recolectando rankings TRC20 (TronScan)...");
  t1 = Date.now();

  let trc20Data = null;
  try {
    const trc20Collector = new Trc20RankingsCollector(tronscan, 5, [tronscanAlt]);
    trc20Data = await trc20Collector.collect();
    const count = await orchestrator.ingestTrc20Rankings(trc20Data);
    totalMetrics += count;
    console.log(`   Tokens encontrados: ${trc20Data.topTokens.length}`);
    console.log(`   Análisis detallados: ${trc20Data.tokenAnalyses.length}`);
    if (trc20Data.topTokens[0]) {
      console.log(`   Top token: ${trc20Data.topTokens[0].symbol} (${(trc20Data.topTokens[0].holderCount / 1e6).toFixed(1)}M holders)`);
    }
    for (const a of trc20Data.tokenAnalyses) {
      console.log(`   ${a.token.symbol}: ${a.topHolders.length} holders fetched`);
    }
    console.log(`   → ${count} métricas [${elapsed(t1)}]`);
    await persistToSql("trc20", () => sqlOrchestrator.ingestTrc20Rankings(trc20Data!));

    exportData.trc20 = {
      topTokens: trc20Data.topTokens.map(t => ({
        contractAddress: t.contractAddress,
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        holderCount: t.holderCount,
        transferCount: t.transferCount,
        totalSupply: t.totalSupply,
        marketCap: t.marketCap,
        priceUsd: t.priceUsd,
      })),
      tokenAnalyses: trc20Data.tokenAnalyses.map(a => ({
        token: {
          contractAddress: a.token.contractAddress,
          name: a.token.name,
          symbol: a.token.symbol,
          decimals: a.token.decimals,
          holderCount: a.token.holderCount,
          totalSupply: a.token.totalSupply,
          marketCap: a.token.marketCap,
          priceUsd: a.token.priceUsd,
        },
        totalSupplyNum: a.totalSupplyNum,
        topHolders: a.topHolders.slice(0, 10).map(h => ({
          address: h.address,
          balance: h.balance,
          balanceNum: h.balanceNum,
        })),
      })),
    };
    console.log();
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }

  // ── Energy Rental Market ──
  console.log("6. Recolectando mercado de alquiler de energía...");
  t1 = Date.now();
  try {
    const rentalCollector = new EnergyRentalCollector(trongrid, tronscan, [...KNOWN_PLATFORMS]);
    const rentalData = await rentalCollector.collect();
    const count = await orchestrator.ingestEnergyRental(rentalData, null);
    totalMetrics += count;
    console.log(`   Plataformas analizadas: ${rentalData.platforms.length}`);
    for (const p of rentalData.platforms) {
      console.log(`   - ${p.platform.name}: volumen ${(p.outgoingVolume + p.incomingVolume).toLocaleString()} TRX`);
    }
    console.log(`   → ${count} métricas [${elapsed(t1)}]`);
    await persistToSql("rental", () => sqlOrchestrator.ingestEnergyRental(rentalData, null));

    exportData.energyRental = {
      platforms: rentalData.platforms.map(p => ({
        name: p.platform.name,
        address: p.platform.paymentAddress,
        balance: p.accountBalance,
        outgoingVolume: p.outgoingVolume,
        incomingVolume: p.incomingVolume,
        uniquePayees: p.uniquePayees,
        uniquePayers: p.uniquePayers,
        energyLimit: p.resources.energyLimit,
        energyUsed: p.resources.energyUsed,
        delegatedToCount: p.delegation.delegatedToCount,
        receivedFromCount: p.delegation.receivedFromCount,
      })),
    };
    console.log();
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }

  // ── On-chain Analytics ──
  console.log("7. Ejecutando análisis on-chain...");
  t1 = Date.now();
  try {
    const analyticsNetworkData = networkData ?? await new NetworkMetricsCollector(trongrid).collect();
    const analytics = new OnchainAnalytics();
    const result = analytics.compute(analyticsNetworkData, trc20Data);
    const findings = analytics.analyze(analyticsNetworkData, trc20Data);
    const now = new Date();

    const analyticsCount = await orchestrator.ingestAnalytics(result, "tron-audit", now);
    const findingsCount = await orchestrator.ingestFindings(findings);
    totalMetrics += analyticsCount + findingsCount;

    console.log(`   Emisión diaria: ${result.deflation.totalDailyEmissionTrx.toLocaleString()} TRX`);
    console.log(`   Quemado diario estimado: ${result.deflation.estimatedDailyBurnTrx.toLocaleString()} TRX`);
    console.log(`   ¿Deflacionario?: ${result.deflation.isDeflationary ? "SÍ" : "NO"}`);
    console.log(`   Health Score: ${result.healthScore.overall}/100 (${result.healthScore.grade})`);
    console.log(`   - Staking: ${result.healthScore.components.stakingHealth}`);
    console.log(`   - Descentralización: ${result.healthScore.components.decentralization}`);
    console.log(`   - Mercado energía: ${result.healthScore.components.energyMarket}`);
    console.log(`   - Diversidad tokens: ${result.healthScore.components.tokenDiversity}`);
    console.log(`   - Sostenibilidad: ${result.healthScore.components.emissionSustainability}`);
    if (result.tokenVelocities.length > 0) {
      console.log(`   Velocidades token: ${result.tokenVelocities.length}`);
    }
    if (result.giniCoefficients.length > 0) {
      console.log(`   Coeficientes Gini: ${result.giniCoefficients.length}`);
    }
    console.log(`   Findings: ${findings.length}`);
    for (const f of findings.slice(0, 5)) {
      console.log(`   [${f.severity}] ${f.title}`);
    }
    console.log(`   → ${analyticsCount + findingsCount} métricas [${elapsed(t1)}]`);
    await persistToSql("analytics", () => sqlOrchestrator.ingestAnalytics(result, "tron-audit", now));
    await persistToSql("findings", () => sqlOrchestrator.ingestFindings(findings));

    exportData.analytics = {
      deflation: result.deflation,
      healthScore: result.healthScore,
      tokenVelocities: result.tokenVelocities.map(v => ({
        symbol: v.symbol,
        contractAddress: v.contractAddress,
        holderCount: v.holderCount,
        transferCount: v.transferCount,
        velocity: v.velocity,
        classification: v.classification,
      })),
      giniCoefficients: result.giniCoefficients.map(g => ({
        symbol: g.symbol,
        contractAddress: g.contractAddress,
        giniCoefficient: g.giniCoefficient,
        classification: g.classification,
        topHolderCount: g.topHolderCount,
        totalHolderCount: g.totalHolderCount,
      })),
      findings: findings.map(f => ({ severity: f.severity, title: f.title, description: f.description })),
    };
    console.log();
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }

  // ── Address Label Resolution ──
  console.log("8. Resolviendo etiquetas de direcciones...");
  t1 = Date.now();
  try {
    const allAddresses = new Set<string>();

    // Collect all unique addresses from TRX holders
    if (networkData) {
      for (const h of networkData.topHolders) allAddresses.add(h.address);
    }
    // Collect all unique addresses from TRC-20 holders
    if (trc20Data) {
      for (const a of trc20Data.tokenAnalyses) {
        for (const h of a.topHolders) allAddresses.add(h.address);
      }
    }

    console.log(`   Direcciones únicas a resolver: ${allAddresses.size}`);
    const resolver = new AddressLabelResolver([tronscan, tronscanAlt]);
    const labels = await resolver.resolveAll([...allAddresses]);

    // Attach labels to export
    const labelMap: Record<string, { name: string; category: string; isContract: boolean }> = {};
    let resolved = 0;
    for (const [addr, label] of labels) {
      labelMap[addr] = { name: label.name, category: label.category, isContract: label.isContract };
      if (label.category !== "unknown" && label.category !== "unknown-contract") resolved++;
    }
    exportData.addressLabels = labelMap;

    const byCat: Record<string, number> = {};
    for (const label of labels.values()) {
      byCat[label.category] = (byCat[label.category] ?? 0) + 1;
    }
    console.log(`   Resueltas: ${resolved}/${allAddresses.size}`);
    console.log(`   🏦 Exchanges: ${byCat["exchange"] ?? 0}  📄 DeFi: ${byCat["defi"] ?? 0}  🏛️ Fundación: ${byCat["foundation"] ?? 0}  📝 Contrato desc.: ${byCat["unknown-contract"] ?? 0}  👤 Desconocido: ${byCat["unknown"] ?? 0}`);
    console.log(`   → [${elapsed(t1)}]`);
  } catch (err) {
    console.log(`   ERROR: ${err instanceof Error ? err.message : err}\n`);
  }
  console.log();

  // ── JSON Export ──
  console.log("__AUDIT_JSON_START__");
  console.log(JSON.stringify(exportData));
  console.log("__AUDIT_JSON_END__");

  // ── Minimum Coverage Assertions (C-04) ──
  // CI must fail if critical data is missing, not silently produce empty results.
  const coverageErrors: string[] = [];

  if (totalMetrics === 0) {
    coverageErrors.push("FATAL: 0 métricas recolectadas — ningún collector devolvió datos.");
  }
  if (!trc20Data || trc20Data.tokenAnalyses.length === 0) {
    coverageErrors.push("FATAL: Sin análisis TRC-20 — no se recolectó información de tokens.");
  } else {
    // At least one token analysis must have holders with non-zero balances
    const hasNonZeroHolder = trc20Data.tokenAnalyses.some(
      (a) => a.topHolders.some((h) => h.balanceNum > 0),
    );
    if (!hasNonZeroHolder) {
      coverageErrors.push("FATAL: Todos los balanceNum de holders TRC-20 son 0 — BigInt parsing puede estar roto.");
    }
  }
  if (!networkData) {
    coverageErrors.push("FATAL: Sin datos de red — NetworkMetricsCollector falló por completo.");
  }

  if (coverageErrors.length > 0) {
    console.error("\n╔══════════════════════════════════════════════════╗");
    console.error("║        COBERTURA MÍNIMA NO ALCANZADA             ║");
    console.error("╠══════════════════════════════════════════════════╣");
    for (const err of coverageErrors) {
      console.error(`║  ${err}`);
    }
    console.error("╚══════════════════════════════════════════════════╝");
    await db.close();
    process.exit(1);
  }

  // ── Summary ──
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║                   RESUMEN                       ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Total métricas recolectadas: ${String(totalMetrics).padStart(5)}            ║`);

  const categories = await memStore.categories("tron");
  console.log(`║  Categorías cubiertas:       ${String(categories.length).padStart(5)}            ║`);
  for (const cat of categories) {
    const count = await memStore.count({ blockchain: "tron", category: cat });
    console.log(`║    ${cat.padEnd(20)} ${String(count).padStart(5)} métricas   ║`);
  }

  const sqlCount = await sqlStore.count({ blockchain: "tron" });
  console.log(`║  Métricas en PostgreSQL:     ${String(sqlCount).padStart(5)}            ║`);
  console.log(`║  Tiempo total:          ${elapsed(t0).padStart(10)}            ║`);
  console.log("╚══════════════════════════════════════════════════╝");

  await db.close();
}

main().catch((err) => {
  console.error("\nERROR FATAL:", err);
  process.exit(1);
});
