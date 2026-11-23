/**
 * The metadata store interface.
 *
 * Narrow on purpose: two drivers implement it (a file-backed one for local
 * development, Postgres for deployment) and a narrow surface keeps them honest.
 * Every filter column is validated against the schema, so no caller can build a
 * query against a column that does not exist.
 */
import { assertColumn, type RowOf, type TableName } from './schema';

export type FilterValue = string | number | boolean | null;

export interface Filter<T> {
  equals?: Partial<Record<keyof T & string, FilterValue>>;
  in?: { column: keyof T & string; values: readonly FilterValue[] };
  lessThan?: { column: keyof T & string; value: number };
  lessThanOrEqual?: { column: keyof T & string; value: number };
  greaterThan?: { column: keyof T & string; value: number };
  isNull?: readonly (keyof T & string)[];
  isNotNull?: readonly (keyof T & string)[];
}

export interface FindOptions<T> extends Filter<T> {
  limit?: number;
  offset?: number;
  orderBy?: { column: keyof T & string; direction: 'asc' | 'desc' };
}

export interface Store {
  readonly driver: 'file' | 'postgres';
  insert<T extends TableName>(table: T, row: RowOf<T>): Promise<void>;
  get<T extends TableName>(table: T, id: string): Promise<RowOf<T> | null>;
  find<T extends TableName>(table: T, options?: FindOptions<RowOf<T>>): Promise<RowOf<T>[]>;
  findOne<T extends TableName>(table: T, options?: FindOptions<RowOf<T>>): Promise<RowOf<T> | null>;
  update<T extends TableName>(table: T, id: string, patch: Partial<RowOf<T>>): Promise<boolean>;
  updateWhere<T extends TableName>(
    table: T,
    filter: Filter<RowOf<T>>,
    patch: Partial<RowOf<T>>,
  ): Promise<number>;
  remove<T extends TableName>(table: T, id: string): Promise<boolean>;
  removeWhere<T extends TableName>(table: T, filter: Filter<RowOf<T>>): Promise<number>;
  count<T extends TableName>(table: T, filter?: Filter<RowOf<T>>): Promise<number>;
  sum<T extends TableName>(
    table: T,
    column: keyof RowOf<T> & string,
    filter?: Filter<RowOf<T>>,
  ): Promise<number>;
  /**
   * Run `fn` inside a transaction scoped to one account.
   *
   * On Postgres this also sets `chatvault.account_id` for the transaction, which
   * is what the row-level security policies compare against. Passing
   * `SERVICE_SCOPE` runs without an account scope, for background workers; use
   * it only where the operation genuinely spans accounts.
   */
  transaction<R>(scope: string | typeof SERVICE_SCOPE, fn: (tx: Store) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export const SERVICE_SCOPE = Symbol('chatvault.service-scope');

export function validateFilter<T extends TableName>(
  table: T,
  filter: Filter<RowOf<T>> | undefined,
): void {
  if (!filter) return;
  for (const column of Object.keys(filter.equals ?? {})) assertColumn(table, column);
  if (filter.in) assertColumn(table, filter.in.column);
  if (filter.lessThan) assertColumn(table, filter.lessThan.column);
  if (filter.lessThanOrEqual) assertColumn(table, filter.lessThanOrEqual.column);
  if (filter.greaterThan) assertColumn(table, filter.greaterThan.column);
  for (const column of filter.isNull ?? []) assertColumn(table, column);
  for (const column of filter.isNotNull ?? []) assertColumn(table, column);
}

export function rowMatchesFilter(row: Record<string, unknown>, filter: Filter<never> | undefined): boolean {
  if (!filter) return true;
  for (const [column, value] of Object.entries(filter.equals ?? {})) {
    if (row[column] !== value) return false;
  }
  if (filter.in && !filter.in.values.includes(row[filter.in.column] as FilterValue)) return false;
  if (filter.lessThan) {
    const value = row[filter.lessThan.column];
    if (typeof value !== 'number' || !(value < filter.lessThan.value)) return false;
  }
  if (filter.lessThanOrEqual) {
    const value = row[filter.lessThanOrEqual.column];
    if (typeof value !== 'number' || !(value <= filter.lessThanOrEqual.value)) return false;
  }
  if (filter.greaterThan) {
    const value = row[filter.greaterThan.column];
    if (typeof value !== 'number' || !(value > filter.greaterThan.value)) return false;
  }
  for (const column of filter.isNull ?? []) {
    if (row[column] !== null && row[column] !== undefined) return false;
  }
  for (const column of filter.isNotNull ?? []) {
    if (row[column] === null || row[column] === undefined) return false;
  }
  return true;
}
