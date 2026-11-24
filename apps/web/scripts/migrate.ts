/**
 * Apply the schema to Postgres.
 *
 *   DATABASE_URL=postgres://… npm run db:migrate
 *
 * Connect as a role that may create tables and policies. The application should
 * then use a *different*, unprivileged role (`chatvault_app` by default), because
 * row-level security does not apply to superusers — see docs/OPERATIONS.md.
 */
import { Pool } from 'pg';
import { migrationSql } from '../src/server/db/schema';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'Set DATABASE_URL (or DATABASE_ADMIN_URL for a privileged connection) before migrating.',
    );
    process.exit(2);
  }

  const appRole = process.env.DATABASE_APP_ROLE ?? 'chatvault_app';
  const pool = new Pool({ connectionString });
  try {
    const sql = migrationSql(appRole);
    await pool.query(sql);
    console.log(`Schema applied. Row-level security is enabled and granted to "${appRole}".`);
    const check = await pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
       ORDER BY c.relname`,
    );
    console.log(
      `Tables with row-level security: ${check.rows.map((row) => row.relname).join(', ')}`,
    );
  } catch (error) {
    console.error('The migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
