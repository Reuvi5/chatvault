/**
 * Choosing the metadata driver.
 *
 * `DATABASE_URL` present → Postgres, and row-level security is verified once at
 * startup. Absent → the file-backed development driver, which `env.ts` refuses
 * to allow in production.
 */
import { join } from 'node:path';
import { getEnv } from '../env';
import { FileStore } from './fileStore';
import { PostgresStore, createPool } from './postgresStore';
import type { Store } from './store';

let instance: Store | null = null;
let readyCheck: Promise<void> | null = null;

export async function getStore(): Promise<Store> {
  const env = getEnv();
  if (!instance) {
    if (env.databaseUrl) {
      const store = new PostgresStore(createPool(env.databaseUrl));
      instance = store;
      readyCheck ??= store.assertRowLevelSecurity();
    } else {
      instance = new FileStore(join(env.dataDir, 'db'));
    }
  }
  if (readyCheck) await readyCheck;
  return instance;
}

export async function resetStoreForTests(): Promise<void> {
  if (instance) await instance.close().catch(() => undefined);
  instance = null;
  readyCheck = null;
}

export { SERVICE_SCOPE } from './store';
export type { Filter, FindOptions, Store } from './store';
export type { RowOf, TableName } from './schema';
