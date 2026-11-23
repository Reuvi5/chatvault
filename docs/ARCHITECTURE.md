# Architecture

## The shape of the thing

```
export file (.zip / .txt)
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ browser (or the headless client used by the drill)          │
│                                                             │
│  parse + preview locally ──▶ merge with what is already     │
│        │                     archived (never deletes)       │
│        ▼                                                    │
│  per-object key from the vault key                          │
│  stream plaintext ──▶ authenticated 1 MiB frames            │
│  decrypted search index, in memory only                     │
└───────────────────────┬─────────────────────────────────────┘
                        │ ciphertext and opaque ids only
                        ▼
      ┌───────────────────────────────────────────┐
      │ API (Next.js route handlers)              │
      │  - sessions, tickets, quotas              │
      │  - verifies the ciphertext digest it was  │
      │    given by reading the object back       │
      └───────┬───────────────────────┬───────────┘
              │                       │
              ▼                       ▼
   primary object store      metadata (Postgres, RLS)
   (Cloudflare R2)            - account ids
              │               - object ids, sizes, checksums
   verified replication       - replica states
              ▼               - usage ledger, billing periods
   secondary object store     - deletion jobs, audit events
   (Backblaze B2, own keys)   - no plaintext, no names, no message times
```

## Packages

| Package | Contains | Notes |
| --- | --- | --- |
| `@chatvault/protocol` | Types, zod request schemas, identifiers, manifest shape, pricing maths | The only place prices and formats are defined. No I/O. |
| `@chatvault/crypto` | Argon2id wrapping, HKDF subkeys, the encrypted object container, recovery keys | Isomorphic: identical code in the browser and in Node. |
| `@chatvault/parser` | Transcript parsing, safe archive reading, attachment matching, merge, fixtures | Pure functions over bytes and strings. No network, no disk. |
| `@chatvault/client` | The headless vault client: preview, import, read, search, export | Used by the interface and by the command-line drills. |
| `@chatvault/web` | API routes, interface, worker, migration, drills | Next.js App Router. |

Workspace packages are TypeScript sources with no build step; Next compiles them
through `transpilePackages`, and `tsx` and Vitest read them directly.

## Request path

Route files under `src/app/api/**/route.ts` are five-line wrappers. The work is
in `src/server/handlers/*`, which are plain `(Request) => Promise<Response>`
functions — which is why the test suite and the drill can drive the real API
in-process through `src/server/localRouter.ts`, with a cookie jar, without
starting a server.

Each handler:

1. resolves the session cookie to an account (`auth/session.ts`),
2. applies a rate limit keyed on a hash of the client, never a raw IP,
3. validates the body against a zod schema from `@chatvault/protocol`,
4. opens a transaction **scoped to that account**, and
5. returns one error envelope shape, `{ error: { code, message, details? } }`.

## Why the metadata store has two drivers

`src/server/db/schema.ts` declares the tables once. From that single declaration
come the row types the server is written against, the Postgres migration
including row-level security policies, and the column whitelist both drivers
validate filters against. Nothing can drift.

- **File driver** (`fileStore.ts`) — one JSON file per table, a process mutex,
  atomic writes, snapshot rollback on error. Zero setup, which is what makes
  `npm run dev` and the test suite instant. Single process, so `env.ts` refuses
  to let it run in production.
- **Postgres driver** (`postgresStore.ts`) — every operation runs inside a
  transaction that begins with `SET LOCAL chatvault.account_id`, which is what
  the RLS policies compare the owner column against. At startup it refuses a
  role that is a superuser or has `BYPASSRLS`, because the policies would be
  decoration.

Authorisation is enforced twice: in application code (every query is scoped and
every row's owner is checked) and in the database. `tests/authz.test.ts` drives
the real handlers to prove the first; the role check and the generated policies
cover the second.

## Objects

Everything stored is an "object": a message page (500 messages), an attachment, a
conversation manifest. Objects are immutable — re-importing writes new ones and
supersedes the old, which is also what keeps AES-GCM nonce reuse structurally
impossible.

An object's life:

```
authorize → pending ──upload parts──▶ complete (digest read back)
                                        │
                                        ▼
                                  primary_stored
                                        │  replication worker
                                        ▼
                                     verified ──trash──▶ trashed ──purge──▶ gone
                                        │
                              replication_failed (dead letter)
```

A conversation is `archive_verified` only when every live object is `verified`
**and** its manifest is one of them — media that survives without a readable
index is not a restore plan.

## What the server knows

| It knows | It does not know |
| --- | --- |
| Which account owns which object | What any object contains |
| Ciphertext length and SHA-256 | Plaintext length beyond the ciphertext size |
| Object kind (`page`, `media`, `manifest`) | File names, senders, group names |
| When objects were created and read | When messages were sent |
| Replica states and verification times | Anything searchable |

Object storage keys are `v1/<accountId>/<objectId>`, both random identifiers, so
a bucket listing leaks nothing.

## The viewer, on long conversations

Messages are grouped by day; each day is a section with
`content-visibility: auto`, so the browser skips layout and paint for off-screen
days while keeping the scrollbar accurate. Only a window of recent days is
mounted at first, with "load earlier" and "load all". This was chosen over a
virtual scroller because message heights vary wildly once media is involved, and
a mis-measured virtual list is worse than a slightly heavier DOM.

Attachments decrypt on demand into blob URLs, which are revoked when the
component unmounts.

## Background work

`npm run worker` runs one idempotent pass a minute: replicate and verify, spot
check already-verified objects, execute due deletion jobs, purge expired trash,
abandon imports that never completed, clear expired sessions and idempotency
keys, then accrue usage per account and report it to Stripe when configured.

Everything it does is also reachable from the app for the signed-in account's own
data, which is how the import screen can show "backing up" become "verified"
without a separate process in development.
