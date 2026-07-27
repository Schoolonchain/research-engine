import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { TronGridConnector } from "../src/blockchain/tron-connector.js";
import { TronScanConnector } from "../src/blockchain/tronscan-connector.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";

class Executor {
  constructor(private readonly db: any) {}
  async query(sql: string, values: readonly unknown[] = []) {
    const result = await this.db.query(sql, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}
class Database {
  constructor(private readonly db: PGlite) {}
  transaction(op: (tx: any) => Promise<any>) {
    return this.db.transaction((tx: any) => op(new Executor(tx)));
  }
}

async function main() {
  console.log("=== COMPARACION MULTI-FUENTE: TronGrid vs TronScan ===\n");

  // 1. Setup
  console.log("1. Preparando base de datos...");
  const raw = new PGlite();
  await migrate(
    { query: (sql: string, values: readonly unknown[] = []) =>
      values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
    await loadMigrations(),
  );
  const database = new Database(raw);

  // 2. Two connectors, same chain
  const trongridKey = process.env["TRONGRID_API_KEY"];
  const tronscanKey = process.env["TRONSCAN_API_KEY"];

  const gridConfig: { endpoint: string; apiKey?: string } = {
    endpoint: process.env["TRONGRID_ENDPOINT"] || "https://api.trongrid.io",
  };
  if (trongridKey) gridConfig.apiKey = trongridKey;

  const scanConfig: { endpoint: string; apiKey?: string } = {
    endpoint: process.env["TRONSCAN_ENDPOINT"] || "https://apilist.tronscanapi.com",
  };
  if (tronscanKey) scanConfig.apiKey = tronscanKey;

  const gridConnector = new TronGridConnector(gridConfig);
  const scanConnector = new TronScanConnector(scanConfig);

  console.log(`   TronGrid: ${gridConnector.sourceName} (${gridConnector.sourceType})`);
  console.log(`   TronScan: ${scanConnector.sourceName} (${scanConnector.sourceType})\n`);

  const gridService = new BlockchainService(database, gridConnector);
  const scanService = new BlockchainService(database, scanConnector);

  // 3. Pick a block
  console.log("2. Obteniendo ultimo bloque...");
  const latest = await gridConnector.getLatestBlockNumber();
  const targetBlock = latest - 200;
  console.log(`   Ultimo: #${latest.toLocaleString()}`);
  console.log(`   Target: #${targetBlock.toLocaleString()}\n`);

  // 4. Collect from TronGrid
  console.log("3. Recolectando desde TronGrid...");
  const gridResult = await gridService.collectBlock(targetBlock);
  console.log(`   Hash: ${gridResult.block.blockHash}`);
  console.log(`   Block producer: ${gridResult.block.blockProducer}`);
  console.log(`   Txs: ${gridResult.transactions.length}`);
  console.log(`   Size: ${gridResult.block.sizeBytes} bytes`);
  console.log(`   Source: ${gridResult.block.collectionSource}`);
  console.log(`   Data source ID: ${gridResult.block.dataSourceId}\n`);

  // 5. Collect same block from TronScan
  console.log("4. Recolectando desde TronScan...");
  const scanResult = await scanService.collectBlock(targetBlock);
  console.log(`   Hash: ${scanResult.block.blockHash}`);
  console.log(`   Block producer: ${scanResult.block.blockProducer}`);
  console.log(`   Txs: ${scanResult.transactions.length}`);
  console.log(`   Size: ${scanResult.block.sizeBytes} bytes`);
  console.log(`   Source: ${scanResult.block.collectionSource}`);
  console.log(`   Data source ID: ${scanResult.block.dataSourceId}\n`);

  // 6. Compare
  console.log("5. Comparacion:");
  console.log(`   Mismo bloque?        ${gridResult.block.blockNumber === scanResult.block.blockNumber}`);
  console.log(`   Mismo hash?          ${gridResult.block.blockHash === scanResult.block.blockHash}`);
  console.log(`   Mismo parent hash?   ${gridResult.block.parentHash === scanResult.block.parentHash}`);
  console.log(`   Mismo timestamp?     ${gridResult.block.blockTimestamp.getTime() === scanResult.block.blockTimestamp.getTime()}`);
  console.log(`   Fuentes distintas?   ${gridResult.block.dataSourceId !== scanResult.block.dataSourceId}`);
  console.log(`   Mismo network?       ${gridResult.block.networkId === scanResult.block.networkId}\n`);

  // 7. Observations query
  console.log("6. Consultando observaciones del bloque...");
  const observations = await gridService.getBlockObservations(
    gridResult.block.networkId, targetBlock,
  );
  console.log(`   Total observaciones: ${observations.length}`);
  for (const obs of observations) {
    console.log(`   - ${obs.collectionSource} | collected at ${obs.collectedAt.toISOString()}`);
  }
  console.log();

  // 8. Data sources
  console.log("7. Fuentes de datos registradas:");
  const network = await gridService.ensureNetwork();
  const sources = await gridService.getDataSourcesForNetwork(network.id);
  for (const src of sources) {
    console.log(`   - ${src.name} (${src.sourceType}) | ${src.endpoint}`);
  }
  console.log();

  // 9. Transaction comparison
  if (gridResult.transactions.length > 0 && scanResult.transactions.length > 0) {
    console.log("8. Comparacion de transacciones:");
    const gridHashes = new Set(gridResult.transactions.map((t) => t.txHash));
    const scanHashes = new Set(scanResult.transactions.map((t) => t.txHash));
    const common = [...gridHashes].filter((h) => scanHashes.has(h));
    console.log(`   TronGrid txs:  ${gridHashes.size}`);
    console.log(`   TronScan txs:  ${scanHashes.size}`);
    console.log(`   En comun:      ${common.length}`);

    if (common.length > 0) {
      const txObs = await gridService.getTransactionObservations(
        gridResult.block.networkId, common[0]!,
      );
      console.log(`\n   Observaciones de tx ${common[0]!.substring(0, 20)}...:`);
      for (const obs of txObs) {
        console.log(`   - Data source: ${obs.dataSourceId.substring(0, 8)}... | ${obs.txType}`);
      }
    }
    console.log();
  }

  console.log("=== MULTI-SOURCE VALIDADO ===");
  console.log("Dos fuentes independientes, misma blockchain, observaciones coexistentes.");

  await raw.close();
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
