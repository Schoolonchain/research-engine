import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate } from "../src/db/migrations.js";
import { TronGridConnector } from "../src/blockchain/tron-connector.js";
import { BlockchainService } from "../src/blockchain/blockchain-service.js";
import { SqlBlockchainRepository } from "../src/blockchain/blockchain-repository.js";
import { ConnectorRegistry } from "../src/blockchain/connector-registry.js";

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
  console.log("=== TRON MAINNET — PRUEBA REAL ===\n");

  console.log("1. Creando base de datos...");
  const raw = new PGlite();
  await migrate(
    { query: (sql: string, values: readonly unknown[] = []) =>
      values.length === 0 ? raw.exec(sql) : raw.query(sql, [...values]) },
    await loadMigrations(),
  );
  console.log("   Base de datos lista con 16 migraciones\n");

  console.log("2. Conectando con TronGrid (API publica)...");
  const connector = new TronGridConnector({
    endpoint: "https://api.trongrid.io",
  });
  console.log(`   Conector: ${connector.sourceName}`);
  console.log(`   Red: ${connector.networkName}`);
  console.log(`   Chain ID: ${connector.chainId}\n`);

  console.log("3. Consultando ultimo bloque de TRON...");
  const latest = await connector.getLatestBlockNumber();
  console.log(`   Ultimo bloque: #${latest.toLocaleString()}\n`);

  const targetBlock = latest - 100;
  console.log(`4. Recolectando bloque #${targetBlock.toLocaleString()}...`);
  const database = new Database(raw);
  const service = new BlockchainService(database, new ConnectorRegistry([connector]), new SqlBlockchainRepository());
  const result = await service.collectBlock(targetBlock);

  console.log(`   Block hash: ${result.block.blockHash}`);
  console.log(`   Parent hash: ${result.block.parentHash}`);
  console.log(`   Timestamp: ${result.block.blockTimestamp.toISOString()}`);
  console.log(`   Block producer: ${result.block.blockProducer}`);
  console.log(`   Transacciones: ${result.transactions.length}`);
  console.log(`   Tamano: ${result.block.sizeBytes} bytes`);
  console.log(`   Data source ID: ${result.block.dataSourceId}`);
  console.log(`   Collection source: ${result.block.collectionSource}`);
  console.log(`   Collection run: ${result.collectionRun.status}\n`);

  console.log("5. Consultando el bloque desde la base de datos...");
  const network = await service.ensureNetwork();
  const found = await service.getBlock(network.id, targetBlock);
  console.log(`   Encontrado: bloque #${found!.blockNumber}`);
  console.log(`   Hash coincide: ${found!.blockHash === result.block.blockHash}`);
  console.log(`   Data source: ${found!.dataSourceId}\n`);

  console.log("6. Consultando observaciones del bloque...");
  const observations = await service.getBlockObservations(network.id, targetBlock);
  console.log(`   Observaciones: ${observations.length}`);
  console.log(`   Fuente: ${observations[0]!.collectionSource}\n`);

  if (result.transactions.length > 0) {
    console.log("7. Detalle de transacciones:");
    for (const tx of result.transactions.slice(0, 5)) {
      console.log(`   - ${tx.txHash.substring(0, 20)}... | ${tx.txType} | ${tx.result}`);
      if (tx.amount !== null) console.log(`     Amount: ${tx.amount} ${tx.amountUnit}`);
      if (tx.fee !== null) console.log(`     Fee: ${tx.fee} ${tx.feeUnit}`);
    }
    if (result.transactions.length > 5) {
      console.log(`   ... y ${result.transactions.length - 5} mas`);
    }
    console.log();
  }

  console.log("8. Verificando evento de dominio...");
  const events = await raw.query<{ event_type: string; payload: any }>(
    "SELECT event_type, payload FROM domain_events WHERE event_type = 'blockchain_block_collected'",
  );
  console.log(`   Evento: ${events.rows[0]!.event_type}`);
  console.log(`   Network: ${events.rows[0]!.payload.networkName}`);
  console.log(`   Data source: ${events.rows[0]!.payload.dataSourceName}\n`);

  console.log("9. Verificando raw_data...");
  const rawRow = await raw.query<{ raw_data: any }>(
    `SELECT raw_data FROM blockchain_blocks WHERE block_number = $1`,
    [targetBlock],
  );
  const rawKeys = Object.keys(rawRow.rows[0]!.raw_data);
  console.log(`   Raw JSON conservado: ${rawKeys.join(", ")}\n`);

  console.log("=== VERTICAL SLICE COMPLETO ===");
  console.log(`TRON Mainnet -> TronGrid -> Bloque #${targetBlock} -> Persistencia -> Consulta`);

  await raw.close();
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
