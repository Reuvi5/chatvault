/**
 * File-backed metadata store: the zero-setup driver for local development.
 *
 * One JSON file per table under `.data/`, written atomically, with a process
 * mutex so concurrent requests cannot interleave. Transactions snapshot the
 * affected tables and roll back on error.
 *
 * This driver is for development and for the test suite. It is single-process,
 * so it must not be used for deployment, where `DATABASE_URL` selects the
 * Postgres driver instead. The server refuses to start in production with this
 * driver selected (see `env.ts`).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SERVICE_SCOPE,
  rowMatchesFilter,
  validateFilter,
  type Filter,
  type FindOptions,
  type Store,
} from './store';
import { SCHEMA, TABLE_NAMES, assertColumn, columnsOf, type RowOf, type TableName } from './schema';

type Tables = Record<string, Record<string, unknown>[]>;

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class FileStore implements Store {
  readonly driver = 'file' as const;
  private tables: Tables | null = null;
  private readonly mutex = new Mutex();
  private dirty = new Set<string>();
  private inTransaction = false;

  constructor(private readonly directory: string) {}

  private async load(): Promise<Tables> {
    if (this.tables) return this.tables;
    await mkdir(this.directory, { recursive: true });
    const tables: Tables = {};
    for (const table of TABLE_NAMES) {
      try {
        const text = await readFile(join(this.directory, `${table}.json`), 'utf8');
        const parsed: unknown = JSON.parse(text);
        tables[table] = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
      } catch {
        tables[table] = [];
      }
    }
    this.tables = tables;
    return tables;
  }

  private async flush(): Promise<void> {
    if (this.inTransaction) return; // the transaction flushes once at the end
    const tables = this.tables;
    if (!tables) return;
    for (const table of this.dirty) {
      const path = join(this.directory, `${table}.json`);
      const temporary = `${path}.${String(process.pid)}.tmp`;
      await writeFile(temporary, JSON.stringify(tables[table] ?? [], null, 0), 'utf8');
      await rename(temporary, path);
    }
    this.dirty.clear();
  }

  private rowsOf(tables: Tables, table: TableName): Record<string, unknown>[] {
    tables[table] ??= [];
    return tables[table] as Record<string, unknown>[];
  }

  private normalise<T extends TableName>(table: T, row: RowOf<T>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const column of columnsOf(table)) {
      out[column] = (row as Record<string, unknown>)[column] ?? null;
    }
    return out;
  }

  async insert<T extends TableName>(table: T, row: RowOf<T>): Promise<void> {
    await this.mutex.run(async () => {
      const tables = await this.load();
      const rows = this.rowsOf(tables, table);
      const candidate = this.normalise(table, row);
      const identifier = candidate.id as string;
      if (rows.some((existing) => existing.id === identifier)) {
        throw new Error(`Duplicate primary key in ${table}: ${identifier}`);
      }
      for (const [column, def] of Object.entries(
        SCHEMA[table].columns as Record<string, { unique?: boolean }>,
      )) {
        if (def.unique && candidate[column] !== null) {
          if (rows.some((existing) => existing[column] === candidate[column])) {
            const error = new Error(`Unique constraint violated on ${table}.${column}`);
            (error as Error & { code?: string }).code = 'unique_violation';
            throw error;
          }
        }
      }
      rows.push(candidate);
      this.dirty.add(table);
      await this.flush();
    });
  }

  async get<T extends TableName>(table: T, identifier: string): Promise<RowOf<T> | null> {
    const tables = await this.load();
    const found = this.rowsOf(tables, table).find((row) => row.id === identifier);
    return found ? ({ ...found } as RowOf<T>) : null;
  }

  async find<T extends TableName>(table: T, options?: FindOptions<RowOf<T>>): Promise<RowOf<T>[]> {
    validateFilter(table, options);
    const tables = await this.load();
    let rows = this.rowsOf(tables, table).filter((row) =>
      rowMatchesFilter(row, options as Filter<never> | undefined),
    );
    if (options?.orderBy) {
      const { column, direction } = options.orderBy;
      rows = [...rows].sort((a, b) => {
        const left = a[column] as string | number | null;
        const right = b[column] as string | number | null;
        if (left === right) return 0;
        if (left === null) return direction === 'asc' ? -1 : 1;
        if (right === null) return direction === 'asc' ? 1 : -1;
        const comparison = left < right ? -1 : 1;
        return direction === 'asc' ? comparison : -comparison;
      });
    }
    const offset = options?.offset ?? 0;
    const limited = options?.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + options.limit);
    return limited.map((row) => ({ ...row }) as RowOf<T>);
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
    return this.mutex.run(async () => {
      const tables = await this.load();
      const rows = this.rowsOf(tables, table);
      const row = rows.find((candidate) => candidate.id === identifier);
      if (!row) return false;
      for (const [column, value] of Object.entries(patch)) {
        assertColumn(table, column);
        row[column] = value ?? null;
      }
      this.dirty.add(table);
      await this.flush();
      return true;
    });
  }

  async updateWhere<T extends TableName>(
    table: T,
    filter: Filter<RowOf<T>>,
    patch: Partial<RowOf<T>>,
  ): Promise<number> {
    validateFilter(table, filter);
    return this.mutex.run(async () => {
      const tables = await this.load();
      const rows = this.rowsOf(tables, table).filter((row) =>
        rowMatchesFilter(row, filter as Filter<never>),
      );
      for (const row of rows) {
        for (const [column, value] of Object.entries(patch)) {
          assertColumn(table, column);
          row[column] = value ?? null;
        }
      }
      if (rows.length > 0) {
        this.dirty.add(table);
        await this.flush();
      }
      return rows.length;
    });
  }

  async remove<T extends TableName>(table: T, identifier: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const tables = await this.load();
      const rows = this.rowsOf(tables, table);
      const index = rows.findIndex((row) => row.id === identifier);
      if (index < 0) return false;
      rows.splice(index, 1);
      this.dirty.add(table);
      await this.flush();
      return true;
    });
  }

  async removeWhere<T extends TableName>(table: T, filter: Filter<RowOf<T>>): Promise<number> {
    validateFilter(table, filter);
    return this.mutex.run(async () => {
      const tables = await this.load();
      const rows = this.rowsOf(tables, table);
      const keep = rows.filter((row) => !rowMatchesFilter(row, filter as Filter<never>));
      const removed = rows.length - keep.length;
      if (removed > 0) {
        tables[table] = keep;
        this.dirty.add(table);
        await this.flush();
      }
      return removed;
    });
  }

  async count<T extends TableName>(table: T, filter?: Filter<RowOf<T>>): Promise<number> {
    return (await this.find(table, filter as FindOptions<RowOf<T>>)).length;
  }

  async sum<T extends TableName>(
    table: T,
    column: keyof RowOf<T> & string,
    filter?: Filter<RowOf<T>>,
  ): Promise<number> {
    assertColumn(table, column);
    const rows = await this.find(table, filter as FindOptions<RowOf<T>>);
    return rows.reduce((total, row) => {
      const value = (row as Record<string, unknown>)[column];
      return total + (typeof value === 'number' ? value : 0);
    }, 0);
  }

  async transaction<R>(
    _scope: string | typeof SERVICE_SCOPE,
    fn: (tx: Store) => Promise<R>,
  ): Promise<R> {
    return this.mutex.run(async () => {
      const tables = await this.load();
      const snapshot: Tables = {};
      for (const table of TABLE_NAMES) {
        snapshot[table] = (tables[table] ?? []).map((row) => ({ ...row }));
      }
      const wasInTransaction = this.inTransaction;
      this.inTransaction = true;
      try {
        // The inner store shares state but bypasses the mutex (already held).
        const result = await fn(new InnerFileStore(this) as unknown as Store);
        this.inTransaction = wasInTransaction;
        await this.flush();
        return result;
      } catch (error) {
        this.tables = snapshot;
        this.inTransaction = wasInTransaction;
        this.dirty = new Set(TABLE_NAMES);
        await this.flush();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      this.dirty = new Set(TABLE_NAMES);
      const wasInTransaction = this.inTransaction;
      this.inTransaction = false;
      await this.flush();
      this.inTransaction = wasInTransaction;
    });
  }

  /* Used by the transaction wrapper below. */
  unsafeDirect(): FileStoreInternals {
    return {
      load: () => this.load(),
      markDirty: (table: string) => this.dirty.add(table),
      rows: (tables: Tables, table: TableName) => this.rowsOf(tables, table),
      normalise: (table, row) => this.normalise(table, row),
    };
  }
}

interface FileStoreInternals {
  load: () => Promise<Tables>;
  markDirty: (table: string) => void;
  rows: (tables: Tables, table: TableName) => Record<string, unknown>[];
  normalise: <T extends TableName>(table: T, row: RowOf<T>) => Record<string, unknown>;
}

/**
 * Inside a transaction the mutex is already held, so this proxy performs the
 * same operations without taking it again (which would deadlock).
 */
class InnerFileStore implements Store {
  readonly driver = 'file' as const;
  private readonly internals: FileStoreInternals;

  constructor(private readonly parent: FileStore) {
    this.internals = parent.unsafeDirect();
  }

  async insert<T extends TableName>(table: T, row: RowOf<T>): Promise<void> {
    const tables = await this.internals.load();
    const rows = this.internals.rows(tables, table);
    const candidate = this.internals.normalise(table, row);
    if (rows.some((existing) => existing.id === candidate.id)) {
      throw new Error(`Duplicate primary key in ${table}: ${String(candidate.id)}`);
    }
    for (const [column, def] of Object.entries(
      SCHEMA[table].columns as Record<string, { unique?: boolean }>,
    )) {
      if (def.unique && candidate[column] !== null) {
        if (rows.some((existing) => existing[column] === candidate[column])) {
          const error = new Error(`Unique constraint violated on ${table}.${column}`);
          (error as Error & { code?: string }).code = 'unique_violation';
          throw error;
        }
      }
    }
    rows.push(candidate);
    this.internals.markDirty(table);
  }

  async get<T extends TableName>(table: T, identifier: string): Promise<RowOf<T> | null> {
    return this.parent.get(table, identifier);
  }

  async find<T extends TableName>(table: T, options?: FindOptions<RowOf<T>>): Promise<RowOf<T>[]> {
    return this.parent.find(table, options);
  }

  async findOne<T extends TableName>(
    table: T,
    options?: FindOptions<RowOf<T>>,
  ): Promise<RowOf<T> | null> {
    return this.parent.findOne(table, options);
  }

  async update<T extends TableName>(
    table: T,
    identifier: string,
    patch: Partial<RowOf<T>>,
  ): Promise<boolean> {
    const tables = await this.internals.load();
    const row = this.internals.rows(tables, table).find((candidate) => candidate.id === identifier);
    if (!row) return false;
    for (const [column, value] of Object.entries(patch)) {
      assertColumn(table, column);
      row[column] = value ?? null;
    }
    this.internals.markDirty(table);
    return true;
  }

  async updateWhere<T extends TableName>(
    table: T,
    filter: Filter<RowOf<T>>,
    patch: Partial<RowOf<T>>,
  ): Promise<number> {
    validateFilter(table, filter);
    const tables = await this.internals.load();
    const rows = this.internals
      .rows(tables, table)
      .filter((row) => rowMatchesFilter(row, filter as Filter<never>));
    for (const row of rows) {
      for (const [column, value] of Object.entries(patch)) {
        assertColumn(table, column);
        row[column] = value ?? null;
      }
    }
    if (rows.length > 0) this.internals.markDirty(table);
    return rows.length;
  }

  async remove<T extends TableName>(table: T, identifier: string): Promise<boolean> {
    const tables = await this.internals.load();
    const rows = this.internals.rows(tables, table);
    const index = rows.findIndex((row) => row.id === identifier);
    if (index < 0) return false;
    rows.splice(index, 1);
    this.internals.markDirty(table);
    return true;
  }

  async removeWhere<T extends TableName>(table: T, filter: Filter<RowOf<T>>): Promise<number> {
    validateFilter(table, filter);
    const tables = await this.internals.load();
    const rows = this.internals.rows(tables, table);
    const keep = rows.filter((row) => !rowMatchesFilter(row, filter as Filter<never>));
    const removed = rows.length - keep.length;
    if (removed > 0) {
      tables[table] = keep;
      this.internals.markDirty(table);
    }
    return removed;
  }

  async count<T extends TableName>(table: T, filter?: Filter<RowOf<T>>): Promise<number> {
    return this.parent.count(table, filter);
  }

  async sum<T extends TableName>(
    table: T,
    column: keyof RowOf<T> & string,
    filter?: Filter<RowOf<T>>,
  ): Promise<number> {
    return this.parent.sum(table, column, filter);
  }

  async transaction<R>(_scope: string | typeof SERVICE_SCOPE, fn: (tx: Store) => Promise<R>): Promise<R> {
    // Already inside one; nested transactions join the outer one.
    return fn(this as unknown as Store);
  }

  async close(): Promise<void> {
    await this.parent.close();
  }
}
