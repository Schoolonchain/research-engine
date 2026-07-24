import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";

export interface DatabaseResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface DatabaseExecutor {
  query<Row>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<DatabaseResult<Row>>;
}

export interface TransactionalDatabase {
  transaction<Result>(
    operation: (transaction: DatabaseExecutor) => Promise<Result>,
  ): Promise<Result>;
}

class PgExecutor implements DatabaseExecutor {
  public constructor(private readonly client: PoolClient) {}

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result: QueryResult<QueryResultRow> = await this.client.query(
      sql,
      [...values],
    );
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? 0,
    };
  }
}

export class PgTransactionalDatabase implements TransactionalDatabase {
  public constructor(private readonly pool: Pool) {}

  public async transaction<Result>(
    operation: (transaction: DatabaseExecutor) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await operation(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

