/**
 * Wire contracts between the client and the API (plan §10).
 *
 * Every request body is validated against these schemas on the server, and the
 * same schemas type the client, so the two cannot drift.
 *
 * Hard rule enforced by the shapes below: **no field in any request carries
 * plaintext chat content, contact names, group names or message timestamps.**
 * The server only ever sees opaque identifiers, ciphertext lengths and
 * ciphertext checksums.
 */
import { z } from 'zod';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(EMAIL_RE, 'Enter a valid email address');

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(1024, 'That is too long');

export const idSchema = z
  .string()
  .regex(/^[a-z]{2,3}_[0-9a-hjkmnp-tv-z]{20,32}$/, 'Malformed identifier');

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

export const objectKindSchema = z.enum(['manifest', 'page', 'media', 'index', 'source', 'bundle']);
export type ObjectKind = z.infer<typeof objectKindSchema>;

export const objectStateSchema = z.enum([
  'pending', // authorized, not fully uploaded
  'primary_stored', // in the primary bucket, ciphertext checksum verified
  'verified', // present and verified on both independent providers
  'replication_failed',
  'trashed',
  'purged',
]);
export type ObjectState = z.infer<typeof objectStateSchema>;

export const importStateSchema = z.enum([
  'open',
  'uploading',
  'primary_stored',
  'verified',
  'failed',
  'abandoned',
]);
export type ImportState = z.infer<typeof importStateSchema>;

export const conversationStateSchema = z.enum(['active', 'trashed', 'purged']);
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const replicaStateSchema = z.enum(['pending', 'verified', 'failed', 'deleted']);
export type ReplicaState = z.infer<typeof replicaStateSchema>;

/* ------------------------------------------------------------------ accounts */

export const signupRequest = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type SignupRequest = z.infer<typeof signupRequest>;

export const loginRequest = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
  totp: z
    .string()
    .trim()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const verifyEmailRequest = z.object({ token: z.string().min(10).max(256) });

export const enrollTotpRequest = z.object({ code: z.string().regex(/^\d{6}$/) });

/* -------------------------------------------------------------------- vaults */

/**
 * The wrapped master-key bundle. The server stores this blob and never learns
 * anything from it: both wraps are AES-GCM ciphertext (plan §6.3 items 2-3).
 */
export const vaultBundleSchema = z.object({
  v: z.number().int().positive(),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  createdAtMs: z.number().int().positive(),
  kdf: z.object({
    alg: z.literal('argon2id'),
    memoryKiB: z.number().int().min(8192).max(1_048_576),
    iterations: z.number().int().min(1).max(64),
    parallelism: z.number().int().min(1).max(16),
    saltB64: z.string().min(16).max(128),
  }),
  passphrase: z.object({ nonceB64: z.string().min(8).max(64), ctB64: z.string().min(16).max(256) }),
  recovery: z.object({
    saltB64: z.string().min(16).max(128),
    nonceB64: z.string().min(8).max(64),
    ctB64: z.string().min(16).max(256),
  }),
});
export type VaultBundleWire = z.infer<typeof vaultBundleSchema>;

export const createVaultRequest = z.object({
  bundle: vaultBundleSchema,
  /** Client-chosen display timezone for parsed wall-clock timestamps. */
  assumedTimeZone: z.string().min(1).max(64).default('UTC'),
});
export type CreateVaultRequest = z.infer<typeof createVaultRequest>;

export const updateVaultBundleRequest = z.object({
  bundle: vaultBundleSchema,
  /** Required so a stale client cannot clobber a newer bundle. */
  expectedKeyId: z.string().regex(/^[0-9a-f]{16}$/),
});

/* ------------------------------------------------------------------- imports */

export const createImportRequest = z.object({
  /** Omitted for a brand-new conversation; set when merging into an existing one. */
  conversationId: idSchema.nullish(),
  /** Bytes the client expects to upload, used for quota checks before upload. */
  plannedCiphertextBytes: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 53 - 1),
  plannedObjectCount: z.number().int().nonnegative().max(1_000_000),
  parserVersion: z.number().int().positive(),
  cryptoVersion: z.number().int().positive(),
});
export type CreateImportRequest = z.infer<typeof createImportRequest>;

export const createImportResponse = z.object({
  importId: idSchema,
  conversationId: idSchema,
  quota: z.object({
    allowedBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative(),
  }),
});
export type CreateImportResponse = z.infer<typeof createImportResponse>;

export const uploadAuthorizeRequest = z.object({
  importId: idSchema,
  kind: objectKindSchema,
  expectedCiphertextBytes: z.number().int().nonnegative(),
});
export type UploadAuthorizeRequest = z.infer<typeof uploadAuthorizeRequest>;

export const uploadAuthorizeResponse = z.object({
  objectId: idSchema,
  /** Opaque, short-lived, scoped to this account + object + operation. */
  ticket: z.string().min(16),
  expiresAtMs: z.number().int().positive(),
  partSizeBytes: z.number().int().positive(),
  /** Where to PUT each part. `{part}` is replaced with the 1-based part number. */
  uploadUrlTemplate: z.string().min(1),
  driver: z.enum(['local', 's3']),
});
export type UploadAuthorizeResponse = z.infer<typeof uploadAuthorizeResponse>;

export const completeObjectRequest = z.object({
  ticket: z.string().min(16),
  ciphertextBytes: z.number().int().nonnegative(),
  ciphertextSha256: sha256HexSchema,
  parts: z
    .array(z.object({ part: z.number().int().positive(), bytes: z.number().int().nonnegative() }))
    .max(10_000),
});
export type CompleteObjectRequest = z.infer<typeof completeObjectRequest>;

export const completeImportRequest = z.object({
  manifestObjectId: idSchema,
  /** Monotonic per conversation; rejected if it is not exactly current + 1. */
  manifestVersion: z.number().int().positive(),
  objectIds: z.array(idSchema).max(200_000),
  /** Objects superseded by this import; they move to the trash, never purged inline. */
  supersededObjectIds: z.array(idSchema).max(200_000).default([]),
});
export type CompleteImportRequest = z.infer<typeof completeImportRequest>;

export const importStatusResponse = z.object({
  importId: idSchema,
  conversationId: idSchema,
  state: importStateSchema,
  objects: z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    primaryStored: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  logicalBytes: z.number().int().nonnegative(),
  /** True only when both copies and the manifest recovery path check out. */
  archiveVerified: z.boolean(),
  lastError: z.string().max(500).nullable(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type ImportStatusResponse = z.infer<typeof importStatusResponse>;

/* ------------------------------------------------------------- conversations */

export const conversationSummary = z.object({
  id: idSchema,
  manifestObjectId: idSchema.nullable(),
  manifestVersion: z.number().int().nonnegative(),
  state: conversationStateSchema,
  logicalBytes: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  archiveVerified: z.boolean(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  trashedAtMs: z.number().int().nonnegative().nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummary>;

export const conversationsResponse = z.object({
  conversations: z.array(conversationSummary),
});
export type ConversationsResponse = z.infer<typeof conversationsResponse>;

export const downloadAuthorizeResponse = z.object({
  objectId: idSchema,
  ticket: z.string().min(16),
  expiresAtMs: z.number().int().positive(),
  downloadUrl: z.string().min(1),
  ciphertextBytes: z.number().int().nonnegative(),
  ciphertextSha256: sha256HexSchema,
  /** Which provider served this authorization; 'secondary' means a failover read. */
  servedBy: z.enum(['primary', 'secondary']),
});
export type DownloadAuthorizeResponse = z.infer<typeof downloadAuthorizeResponse>;

/* --------------------------------------------------------------------- usage */

export const usageResponse = z.object({
  vaultId: idSchema,
  currentLogicalBytes: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  trashedBytes: z.number().int().nonnegative(),
  period: z.object({ key: z.string(), startMs: z.number(), endMs: z.number() }),
  accrued: z.object({
    byteHours: z.number(),
    gbMonths: z.number(),
    usd: z.number(),
  }),
  projected: z.object({ usd: z.number(), usdWithMinimum: z.number() }),
  policy: z.object({
    pricePerGbMonth: z.number(),
    bytesPerGb: z.number(),
    freeAllowanceBytes: z.number(),
    minimumCents: z.number(),
    minimumEnforced: z.boolean(),
    quotaBytes: z.number(),
  }),
  replication: z.object({
    verifiedBytes: z.number().int().nonnegative(),
    pendingBytes: z.number().int().nonnegative(),
    failedBytes: z.number().int().nonnegative(),
  }),
  samples: z.array(z.object({ atMs: z.number(), logicalBytes: z.number() })).max(400),
  billing: z.object({
    configured: z.boolean(),
    status: z.enum(['none', 'active', 'past_due', 'canceled', 'unconfigured']),
    customerPortalAvailable: z.boolean(),
  }),
});
export type UsageResponse = z.infer<typeof usageResponse>;

/* ------------------------------------------------------------------ deletion */

export const deleteConversationRequest = z.object({
  mode: z.enum(['trash', 'purge']),
  /** Typed confirmation, required for `purge`. */
  confirm: z.string().max(64).optional(),
});

export const accountDeleteRequest = z.object({
  confirmEmail: emailSchema,
  /** When false the archive goes to the trash and the retention window applies. */
  purgeImmediately: z.boolean().default(false),
});

/* ------------------------------------------------------------------- billing */

export const checkoutRequest = z.object({
  returnPath: z.string().startsWith('/').max(200).default('/app/usage'),
});

/* -------------------------------------------------------------------- errors */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'quota_exceeded',
      'rate_limited',
      'payload_too_large',
      'not_configured',
      'internal',
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];
