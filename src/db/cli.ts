import { loadEnvironment } from "../config/environment.js";
import { createDatabasePool } from "./client.js";
import { loadMigrations, migrate } from "./migrations.js";

const environment = loadEnvironment();
const pool = createDatabasePool(environment);

try {
  const migrations = await loadMigrations();
  await migrate(pool, migrations);
  console.log(`Applied ${migrations.length} migration(s).`);
} finally {
  await pool.end();
}

