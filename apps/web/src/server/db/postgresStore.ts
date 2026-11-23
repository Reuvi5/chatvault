/**
 * Postgres metadata store: the deployment driver.
 *
 * Two things make the row-level security policies real rather than decorative:
 *
 *  1. Every operation runs inside a transaction that begins with
 *     `SET LOCAL chatvault.account_id`, which is what the policies compare the
 *     owner column against.
 *  2. The connection must use a role that is neither superuser nor BYPASSRLS.
 *     `assertRowLevelSecurity()` checks this at startup and refuses to run
 *     otherwise, because a privileged role silently disables every policy.
 *
 * Filters are built from the schema's column whitelist and bound as parameters,
 * so no caller can inject SQL through a column name or a value.
 */
import { Pool, type PoolClient } from 'pg';
import { SERVICE_SCOPE, validateFilter, type Filter, type FindOptions, type Store } from './store';
import { SCHEMA, SERVICE_SCOPE_VALUE, assertColumn, columnsOf, type RowOf, type TableName } from './schema';

interface WhereClause {
  text: string;
  values: unknown[];
}

function buildWhere<T extends TableName>(
  table: T,
  filter: Filter<RowOf<T>> | undefined,
  startIndex = 1,
): WhereClause {
  validateFilter(table, filter);
  if (!filter) return { text: '', values: [] };
  const parts: string[] = [];
  const values: unknown[] = [];
  let index = startIndex;

  for (const [column, value] of Object.entries(filter.equals ?? {})) {
    if (value === null) {
      parts.push(`${column} IS NULL`);
    } else {
      parts.push(`${column} = $${String(index)}`);
      values.push(value);
      index += 1;
    }
  }
  if (filter.in) {
    if (filter.in.values.length === 0) {
      parts.push('FALSE');
    } else {
      const placeholders = filter.in.values.map(() => `$${String(index++)}`);
      parts.push(`${filter.in.column} IN (${placeholders.join(', ')})`);
      values.push(...filter.in.values);
    }
  }
  if (filter.lessThan) {
    parts.push(`${filter.lessThan.column} < $${String(index++)}`);
    values.push(filter.lessThan.value);
  }
  if (filter.lessThanOrEqual) {
    parts.push(`${filter.lessThanOrEqual.column} <= $${String(index++)}`);
    values.push(filter.lessThanOrEqual.value);
  }
  if (filter.greaterThan) {
    parts.push(`${filter.greaterThan.column} > $${String(index++)}`);
    values.push(filter.greaterThan.value);
  }
  for (const column of filter.isNull ?? []) parts.push(`${column} IS NULL`);
  for (const column of filter.isNotNull ?? []) parts.push(`${column} IS NOT NULL`);

  return { text: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '', values };
}

/** Postgres returns BIGINT as a string to avoid precision loss; convert back. */
function coerceRow<T extends TableName>(table: T, row: Record<string, unknown>): RowOf<T> {
  const columns = SCHEMA[table].columns as Record<string, { type: string }>;
  const out: Record<string, unknown> = {};
  for (const [column, def] of Object.entries(columns)) {
    const value = row[column];
    if (value === null || value === undefined) {
      out[column] = null;
      continue;
    }
    if (def.type === 'bigint' || def.type === 'int' || def.type === 'real') {
      out[column] = typeof value === 'string' ? Number(value) : value;
    } else {
      out[column] = value;
    }
  }
  return out as RowOf<T>;
}

export class PostgresStore implements Store {
  readonly driver = 'postgres' as const;

  constructor(
    private readonly pool: Pool,
    private readonly scope: string | typeof SERVICE_SCOPE | null = null,
    private readonly client: PoolClient | null = null,
  ) {}

  private async withClient<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
    if (this.client) return fn(this.client);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyScope(client, this.scope ?? SERVICE_SCOPE);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw normaliseError(error);
    } finally {
      client.release();
    }
  }

  private async applyScope(
    client: PoolClient,
    scope: string | typeof SERVICE_SCOPE,
  ): Promise<void> {
    const value = scope === SERVICE_SCOPE ? SERVICE_SCOPE_VALUE : scope;
    await client.query("SELECT set_config('chatvault.account_id', $1, true)", [value]);
  }

  async insert<T extends TableName>(table: T, row: RowOf<T>): Promise<void> {
    const columns = columnsOf(table);
    const values = columns.map((column) => (row as Record<string, unknown>)[column] ?? null);
    const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
    await this.withClient((client) =>
      client.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        values,
      ),
    );
  }

  async get<T extends TableName>(table: T, identifier: string): Promise<RowOf<T> | null> {
    return this.withClient(async (client) => {
      const result = await client.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [identifier]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? coerceRow(table, row) : null;
    });
  }

  async find<T extends TableName>(table: T, options?: FindOptions<RowOf<T>>): Promise<RowOf<T>[]> {
    const where = buildWhere(table, options);
    let sql = `SELECT * FROM ${table}${where.text}`;
    if (options?.orderBy) {
      assertColumn(table, options.orderBy.column);
      sql += ` ORDER BY ${options.orderBy.column} ${options.orderBy.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }
    if (options?.limit !== undefined) sql += ` LIMIT ${String(Math.max(0, Math.floor(options.limit)))}`;
    if (options?.offset !== undefined) sql += ` OFFSET ${String(Math.max(0, Math.floor(options.offset)))}`;
    return this.withClient(async (client) => {
      const result = await client.query(sql, where.values);
      return (result.rows as Record<string, unknown>[]).map((row) => coerceRow(table, row));
    });
  }

  async findOne<T extends TableName>(
    table: T,
    options?: FindOptions<RowOf<T>>,
  ): Promise<RowOf<T> | null> {
    const rows = await this.find(table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async update<T extends TableName>(
    table: T,
    identifier: string,
    patch: Partial<RowOf<T>>,
  ): Promise<boolean> {
    const entries = Object.entries(patch);
    if (entries.length === 0) return true;
    for (const [column] of entries) assertColumn(table, column);
    const assignments = entries.map(([column], index) => `${column} = $${String(index + 2)}`);
    return this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $1`,
        [identifier, ...entries.map(([, value]) => value ?? null)],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async updateWhere<T extends TableName>(
    table: T,
    filter: Filter<RowOf<T>>,
    patch: Partial<RowOf<T>>,
  ): Promise<number> {
    const entries = Object.entries(patch);
    if (entries.length === 0) return 0;
    for (const [column] of entries) assertColumn(table, column);
    const assignments = entries.map(([column], index) => `${column} = $${String(index + 1)}`);
    const where = buildWhere(table, filter, entries.length + 1);
    return this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE ${table} SET ${assignments.join(', ')}${where.text}`,
        [...entries.map(([, value]) => value ?? null), ...where.values],
      );
      return result.rowCount ?? 0;
    });
  }

  async remove<T extends TableName>(table: T, identifier: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query(`DELETE FROM ${table} WHERE id = $1`, [identifier]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async removeWhere<T extends TableName>(table: T, filter: Filter<RowOf<T>>): Promise<number> {
    const where = buildWhere(table, filter);
    return this.withClient(async (client) => {
      const result = await client.query(`DELETE FROM ${table}${where.text}`, where.values);
      return result.rowCount ?? 0;
    });
  }

  async count<T extends TableName>(table: T, filter?: Filter<RowOf<T>>): Promise<number> {
    const where = buildWhere(table, filter);
    return this.withClient(async (client) => {
      const result = await client.query(`SELECT COUNT(*)::BIGINT AS value FROM ${table}${where.text}`, where.values);
      return Number((result.rows[0] as { value: string }).value);
    });
  }

  async sum<T extends TableName>(
    table: T,
    column: keyof RowOf<T> & string,
    filter?: Filter<RowOf<T>>,
  ): Promise<number> {
    assertColumn(table, column);
    const where = buildWhere(table, filter);
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT COALESCE(SUM(${column}), 0)::DOUBLE PRECISION AS value FROM ${table}${where.text}`,
        where.values,
      );
      return Number((result.rows[0] as { value: number }).value);
    });
  }

  async transaction<R>(
    scope: string | typeof SERVICE_SCOPE,
    fn: (tx: Store) => Promise<R>,
  ): Promise<R> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyScope(client, scope);
      const result = await fn(new PostgresStore(this.pool, scope, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw normaliseError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }

  /**
   * Refuse to run with a role that row-level security does not apply to.
   * Called once at startup; a misconfigured role is a silent tenant-isolation
   * failure, which is exactly the failure this project cannot afford.
   */
  async assertRowLevelSecurity(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      const row = role.rows[0];
      if (!row) throw new Error('Could not determine the current database role.');
      if (row.rolsuper || row.rolbypassrls) {
        throw new Error(
          `The database role "${row.rolname}" is a superuser or has BYPASSRLS, so row-level security would not be enforced. ` +
            'Create a plain role for the application (see docs/OPERATIONS.md) and point DATABASE_URL at it.',
        );
      }
      const tables = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
           AND c.relname = ANY($1::text[])`,
        [Object.keys(SCHEMA).filter((table) => SCHEMA[table as TableName].ownerColumn !== null)],
      );
      if (tables.rows.length > 0) {
        throw new Error(
          `Row-level security is not enabled on: ${tables.rows.map((r) => r.relname).join(', ')}. Run "npm run db:migrate".`,
        );
      }
    } finally {
      client.release();
    }
  }
}

function normaliseError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      const wrapped = new Error('Unique constraint violated');
      (wrapped as Error & { code?: string }).code = 'unique_violation';
      return wrapped;
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    // Keep statements from pinning a connection forever.
    statement_timeout: 20_000,
    idle_in_transaction_session_timeout: 20_000,
  });
}
