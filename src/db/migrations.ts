import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SqlExecutor {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const MIGRATION_FILE = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.sql$/;

export function defaultMigrationsDirectory(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../migrations",
  );
}

export async function loadMigrations(
  directory = defaultMigrationsDirectory(),
): Promise<readonly Migration[]> {
  const fileNames = (await readdir(directory))
    .filter((fileName) => MIGRATION_FILE.test(fileName))
    .sort();

  const migrations = await Promise.all(
    fileNames.map(async (fileName): Promise<Migration> => {
      const match = MIGRATION_FILE.exec(fileName);
      if (!match?.groups) throw new Error(`Invalid migration name: ${fileName}`);
      const sql = await readFile(path.join(directory, fileName), "utf8");

      return Object.freeze({
        version: match.groups["version"] as string,
        name: match.groups["name"] as string,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      });
    }),
  );

  const versions = migrations.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error("Migration versions must be unique");
  }

  return Object.freeze(migrations);
}

export async function migrate(
  database: SqlExecutor,
  migrations: readonly Migration[],
): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const migration of migrations) {
    const result = (await database.query(
      "SELECT checksum FROM schema_migrations WHERE version = $1",
      [migration.version],
    )) as { rows?: Array<{ checksum: string }> };
    const applied = result.rows?.[0];

    if (applied) {
      if (applied.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} checksum differs from the applied version`,
        );
      }
      continue;
    }

    await database.query("BEGIN");
    try {
      await database.query(migration.sql);
      await database.query(
        `
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES ($1, $2, $3)
        `,
        [migration.version, migration.name, migration.checksum],
      );
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
  }
}

