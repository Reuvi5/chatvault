/**
 * The metadata schema (plan §5 "Suggested metadata tables").
 *
 * One declaration drives three things, so they cannot drift apart:
 *   - the row types the whole server is written against,
 *   - the Postgres migration, including row-level security policies,
 *   - the column whitelist both store drivers validate filters against.
 *
 * **What is deliberately absent:** message text, contact names, group names,
 * attachment file names, message timestamps and anything derived from them.
 * Those live only inside encrypted objects. What the server unavoidably learns
 * is account identity, ciphertext sizes, object counts and access timing
 * (plan §6 "Metadata minimization").
 */

/**
 * The scope value background workers use.
 *
 * Replication, metering and deletion genuinely span accounts, so they run with
 * `chatvault.account_id` set to this value, which the policies accept. The
 * protection row-level security gives us is therefore against the failure the
 * plan names — an application query that forgets its owner filter, or a
 * metadata API that is scoped wrongly — rather than against the application
 * itself, which holds the credentials either way. Only the worker paths set it,
 * and nothing that serves a user request does.
 */
export const SERVICE_SCOPE_VALUE = '__service__';

export type ColumnType = 'text' | 'int' | 'bigint' | 'bool' | 'real';

export interface ColumnDef {
  readonly type: ColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
}

export interface TableDef {
  readonly columns: Readonly<Record<string, ColumnDef>>;
  /** Column that names the owning account; drives authorisation and RLS. */
  readonly ownerColumn: string | null;
  readonly indexes: readonly (readonly string[])[];
  readonly comment: string;
}

const id = { type: 'text', primaryKey: true } as const;
const text = { type: 'text' } as const;
const nullableText = { type: 'text', nullable: true } as const;
const bigint = { type: 'bigint' } as const;
const nullableBigint = { type: 'bigint', nullable: true } as const;
const int = { type: 'int' } as const;
const bool = { type: 'bool' } as const;

export const SCHEMA = {
  accounts: {
    comment: 'One row per customer. Holds login material, never vault keys.',
    ownerColumn: 'id',
    columns: {
      id,
      email: { type: 'text', unique: true },
      password_hash: text,
      password_params: text,
      email_verified: bool,
      verification_token_hash: nullableText,
      /** TOTP secret, encrypted at rest with the server key. */
      mfa_secret_enc: nullableText,
      mfa_enabled: bool,
      mfa_recovery_hashes: nullableText,
      stripe_customer_id: nullableText,
      billing_status: text,
      state: text,
      quota_bytes: bigint,
      created_at_ms: bigint,
      updated_at_ms: bigint,
      deleted_at_ms: nullableBigint,
    },
    indexes: [['email'], ['state']],
  },

  sessions: {
    comment: 'Active logins. Only a hash of each session token is stored.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      token_hash: { type: 'text', unique: true },
      created_at_ms: bigint,
      expires_at_ms: bigint,
      last_seen_ms: bigint,
      client_hash: nullableText,
    },
    indexes: [['account_id'], ['expires_at_ms']],
  },

  vaults: {
    comment: 'Wrapped master-key bundle and the timezone chosen for display.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: { type: 'text', unique: true },
      key_id: text,
      bundle_json: text,
      assumed_time_zone: text,
      created_at_ms: bigint,
      updated_at_ms: bigint,
    },
    indexes: [['account_id']],
  },

  conversations: {
    comment: 'An archived conversation. The title lives in the encrypted manifest.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      vault_id: text,
      manifest_object_id: nullableText,
      manifest_version: int,
      state: text,
      logical_bytes: bigint,
      object_count: int,
      archive_verified: bool,
      created_at_ms: bigint,
      updated_at_ms: bigint,
      trashed_at_ms: nullableBigint,
      purge_after_ms: nullableBigint,
    },
    indexes: [['account_id', 'state'], ['purge_after_ms']],
  },

  imports: {
    comment: 'One attempt to add an export to a conversation.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      vault_id: text,
      conversation_id: text,
      state: text,
      parser_version: int,
      crypto_version: int,
      planned_objects: int,
      planned_bytes: bigint,
      object_count: int,
      ciphertext_bytes: bigint,
      manifest_object_id: nullableText,
      manifest_version: int,
      last_error: nullableText,
      created_at_ms: bigint,
      updated_at_ms: bigint,
      completed_at_ms: nullableBigint,
    },
    indexes: [['account_id', 'state'], ['conversation_id']],
  },

  objects: {
    comment: 'An encrypted blob. The server knows its size, never its contents.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      vault_id: text,
      conversation_id: text,
      import_id: text,
      kind: text,
      state: text,
      storage_key: text,
      ciphertext_bytes: bigint,
      ciphertext_sha256: nullableText,
      part_count: int,
      created_at_ms: bigint,
      updated_at_ms: bigint,
      trashed_at_ms: nullableBigint,
      purge_after_ms: nullableBigint,
    },
    indexes: [
      ['account_id', 'state'],
      ['conversation_id', 'state'],
      ['import_id'],
      ['state'],
      ['purge_after_ms'],
    ],
  },

  replicas: {
    comment: 'Where each object lives, per provider, with its verification state.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      object_id: text,
      provider: text,
      location: text,
      state: text,
      ciphertext_sha256: nullableText,
      ciphertext_bytes: bigint,
      attempts: int,
      last_error: nullableText,
      last_verified_ms: nullableBigint,
      created_at_ms: bigint,
      updated_at_ms: bigint,
    },
    indexes: [['object_id'], ['state', 'attempts'], ['account_id']],
  },

  upload_sessions: {
    comment: 'In-flight multipart uploads, so an interrupted upload can resume.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      object_id: text,
      provider: text,
      provider_upload_id: nullableText,
      parts_json: text,
      created_at_ms: bigint,
      expires_at_ms: bigint,
    },
    indexes: [['object_id'], ['expires_at_ms']],
  },

  usage_ledger: {
    comment: 'Append-only measurements of logical bytes stored, for billing.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      at_ms: bigint,
      logical_bytes: bigint,
      object_count: int,
      source: text,
    },
    indexes: [['account_id', 'at_ms']],
  },

  billing_periods: {
    comment: 'Accrued GB-months per calendar month and what was reported to Stripe.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      period_key: text,
      gb_months: { type: 'real' },
      accrued_cents: int,
      reported_cents: int,
      state: text,
      updated_at_ms: bigint,
    },
    indexes: [['account_id', 'period_key'], ['state']],
  },

  deletion_jobs: {
    comment: 'Deletion requests and their retention windows, with verification.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      target_type: text,
      target_id: text,
      mode: text,
      state: text,
      objects_purged: int,
      requested_at_ms: bigint,
      execute_after_ms: bigint,
      completed_at_ms: nullableBigint,
      last_error: nullableText,
    },
    indexes: [['state', 'execute_after_ms'], ['account_id']],
  },

  security_audit_events: {
    comment: 'Minimal non-content security events. Never holds chat data.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: nullableText,
      kind: text,
      detail: text,
      client_hash: nullableText,
      at_ms: bigint,
    },
    indexes: [['account_id', 'at_ms'], ['kind']],
  },

  idempotency_keys: {
    comment: 'Replay protection for write operations.',
    ownerColumn: 'account_id',
    columns: {
      id,
      account_id: text,
      route: text,
      request_hash: text,
      response_json: nullableText,
      state: text,
      created_at_ms: bigint,
      expires_at_ms: bigint,
    },
    indexes: [['expires_at_ms']],
  },
} as const satisfies Record<string, TableDef>;

export type Schema = typeof SCHEMA;
export type TableName = keyof Schema;

type ValueOfColumn<C extends ColumnDef> = C['type'] extends 'text'
  ? string
  : C['type'] extends 'bool'
    ? boolean
    : number;

type RowFromColumns<C extends Readonly<Record<string, ColumnDef>>> = {
  -readonly [K in keyof C]: C[K] extends { nullable: true }
    ? ValueOfColumn<C[K]> | null
    : ValueOfColumn<C[K]>;
};

export type RowOf<T extends TableName> = RowFromColumns<Schema[T]['columns']>;

export const TABLE_NAMES = Object.keys(SCHEMA) as TableName[];

export function columnsOf(table: TableName): string[] {
  return Object.keys(SCHEMA[table].columns);
}

export function ownerColumnOf(table: TableName): string | null {
  return SCHEMA[table].ownerColumn;
}

export function assertColumn(table: TableName, column: string): void {
  if (!Object.hasOwn(SCHEMA[table].columns, column)) {
    throw new Error(`Unknown column ${table}.${column}`);
  }
}

/* --------------------------------------------------------------- migration */

const SQL_TYPES: Record<ColumnType, string> = {
  text: 'TEXT',
  int: 'INTEGER',
  bigint: 'BIGINT',
  bool: 'BOOLEAN',
  real: 'DOUBLE PRECISION',
};

/**
 * The Postgres migration.
 *
 * Row-level security is enabled on every table that has an owner, and the
 * policy compares the owner column with `chatvault.account_id`, which the
 * request sets with `SET LOCAL` inside its transaction. The application role
 * must not be a superuser and must not have BYPASSRLS, otherwise the policies
 * are decoration (plan §5: "authorization must never rely merely on being
 * logged in").
 */
export function migrationSql(appRole = 'chatvault_app'): string {
  const statements: string[] = [
    '-- Generated by apps/web/src/server/db/schema.ts. Do not edit by hand.',
    'BEGIN;',
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at_ms BIGINT NOT NULL);`,
  ];

  for (const table of TABLE_NAMES) {
    const def = SCHEMA[table];
    const columns = (Object.entries(def.columns) as Array<[string, ColumnDef]>).map(
      ([name, column]) => {
        const parts = [`  ${name} ${SQL_TYPES[column.type]}`];
        if (column.primaryKey) parts.push('PRIMARY KEY');
        if (!column.nullable) parts.push('NOT NULL');
        if (column.unique && !column.primaryKey) parts.push('UNIQUE');
        return parts.join(' ');
      },
    );
    statements.push(
      `-- ${def.comment}`,
      `CREATE TABLE IF NOT EXISTS ${table} (\n${columns.join(',\n')}\n);`,
    );
    for (const index of def.indexes) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${table}_${index.join('_')}_idx ON ${table} (${index.join(', ')});`,
      );
    }
  }

  statements.push(
    '',
    '-- Row-level security: every exposed table is owner-scoped.',
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN CREATE ROLE ${appRole} NOLOGIN; END IF; END $$;`,
  );

  for (const table of TABLE_NAMES) {
    const owner = SCHEMA[table].ownerColumn;
    if (!owner) continue;
    statements.push(
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS ${table}_owner ON ${table};`,
      `CREATE POLICY ${table}_owner ON ${table} USING (${owner} = current_setting('chatvault.account_id', true) OR current_setting('chatvault.account_id', true) = '${SERVICE_SCOPE_VALUE}') WITH CHECK (${owner} = current_setting('chatvault.account_id', true) OR current_setting('chatvault.account_id', true) = '${SERVICE_SCOPE_VALUE}');`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appRole};`,
    );
  }

  statements.push(
    `GRANT SELECT, INSERT ON schema_migrations TO ${appRole};`,
    "INSERT INTO schema_migrations (version, applied_at_ms) VALUES ('0001_initial', (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT) ON CONFLICT DO NOTHING;",
    'COMMIT;',
    '',
  );
  return statements.join('\n');
}
