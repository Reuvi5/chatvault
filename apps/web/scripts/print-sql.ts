/**
 * Print the Postgres migration to stdout.
 *
 *   npm run db:sql > migration.sql
 *
 * Useful for review, for applying by hand, or for feeding to a migration tool.
 */
import { migrationSql } from '../src/server/db/schema';

process.stdout.write(migrationSql(process.env.DATABASE_APP_ROLE ?? 'chatvault_app'));
