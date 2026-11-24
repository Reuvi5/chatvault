# ChatVault

A private, end-to-end encrypted archive for chat conversations you have exported
yourself. Exports are parsed and encrypted on the device, stored as two
independent encrypted copies, and read back in a chat view you can search.

This is an implementation of `plan.md`. It runs, it is tested, and the parts the
plan marked as decisions rather than facts are implemented as flags that default
to the un-approved state.

---

## Run it

Node 20.11 or newer. Nothing else — no database, no cloud account, no Docker.

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**.

### First five minutes

1. **Create an account.** No email is sent (no mail provider is configured), so
   the confirmation link appears on screen. Click it.
2. **Set an archive passphrase.** This is not your sign-in password and never
   reaches the server; it derives the key everything is encrypted with. Deriving
   it takes about a second on purpose.
3. **Save the recovery key.** It is shown once. If you lose both it and the
   passphrase, nobody can open the archive — not you and not the operator.
4. **Get something to import.** In another terminal:

   ```bash
   npm run fixtures
   ```

   That writes synthetic exports to `fixtures-generated/`. They are generated,
   not real conversations. Use a real export of your own if you prefer: the
   `.zip` or `.txt` an app's "export chat" produces.

5. **Import** `fixtures-generated/ios-1to1-with-media.zip`. You will see the file
   parsed locally first, with a preview of what was found — message count, date
   range, attachments, anything missing or ambiguous — before anything is
   uploaded. Then it is encrypted and uploaded, and the second copy is made.
6. **Open the conversation.** Read it, play a voice note, search it, jump to a
   date, download a readable copy, check the archive against its index.

### Prove it actually works

```bash
npm run drill:restore
```

The disaster-recovery drill, headless, in about ten seconds. It creates an
account, imports a synthetic export, replicates it, then makes the primary
provider unreachable and restores the whole archive from the backup copy using
**only the offline recovery key** — and greps everything the server stored for
plaintext, failing if it finds any.

```
  ok   account created and email confirmed
  ok   archive key created, wrapped bundle stored — key ece23fe5ca264f94
  ok   export parsed locally — 406 messages, 94 attachments
  ok   encrypted and uploaded — 96 objects, 1.22 MB of ciphertext
  ok   not verified before the backup copy exists — state primary_stored
  ok   replicated and verified on both providers — 96 objects verified
  ok   no message text, name or title found anywhere in stored data
  ok   signed in on a fresh session
  ok   unlocked with the recovery key alone — key ece23fe5ca264f94
  ok   conversation index decrypted — "Lake trip planning", 406 messages
  ok   every page and attachment read back and matched its checksum
  ok   restored messages are identical to the export — 406 of 406 messages
  ok   an attachment decrypts from the backup copy
13 of 13 checks passed.
```

### Everything else

```bash
npm test            # 257 tests: crypto, parser, pricing, API, authorisation
npm run lint        # type-aware ESLint, React hooks rules, accessibility rules
npm run format      # Prettier over everything
npm run typecheck   # tsc over every package and the app
npm run check       # lint + format + typecheck + test + production build
npm run worker      # the replication / verification / deletion / billing worker
npm run worker -- --once
npm run build && npm run start:local   # check the optimised build locally
npm run db:sql      # print the Postgres schema, with its RLS policies
```

CI runs all of that on every push, on Node 20 and 22, plus the restore drill —
see `.github/workflows/ci.yml`.

`npm start` on its own is for a configured deployment and will refuse to run on
development defaults — that refusal is deliberate. Use `npm run dev` locally, or
`npm run start:local` to look at the production build (it prints a warning that
it is using development storage). On Windows, `set CHATVAULT_UNSAFE_LOCAL_PRODUCTION=1`
and then `npm start`.

---

## What is here

```
packages/protocol   types, API contracts, identifiers, pricing and usage maths
packages/crypto     Argon2id key wrapping, HKDF subkeys, streaming AES-256-GCM
packages/parser     export parser, safe ZIP reading, merge/dedupe, fixtures
packages/client     headless vault client: import, read, search, export
apps/web            Next.js app: API routes, the interface, worker and drills
docs                architecture, crypto spec, threat model, operations
```

The server stores ciphertext, ciphertext lengths and opaque identifiers. It holds
no message text, no contact or group names, no file names and no message
timestamps — those exist only inside encrypted objects. `docs/ARCHITECTURE.md`
has the data flow; `docs/CRYPTO-SPEC.md` has the formats, byte for byte.

### Implemented

- Account sign-up, sign-in, email confirmation, TOTP two-factor, sessions.
- Archive key created on the device: Argon2id over a passphrase wraps a random
  master key; a second wrap is held by an offline recovery key. Both wraps and
  the KDF parameters are the only key material the server ever sees.
- Import: iOS and Android transcripts, `.txt` and `.zip`, many locales, 12- and
  24-hour clocks, multi-line bodies, system notices, edit and deletion markers,
  omitted-media placeholders, right-to-left text, emoji. Date order is inferred
  and the confidence is reported rather than guessed silently.
- Untrusted archives are read as a stream with caps on entry count, entry size,
  total size and compression ratio, and with path traversal refused.
- Re-import merges against what you already hold: nothing is duplicated, nothing
  is deleted because a newer export omits it, and anything ambiguous is shown
  instead of being merged quietly.
- Streaming client-side encryption into authenticated frames, uploaded as
  retryable parts; the server verifies the ciphertext digest by reading the
  object back before it accepts it.
- Two independent providers, a durable idempotent replication worker, checksum
  verification on both copies, a dead-letter state, scheduled reconciliation, and
  reads that fail over to the backup copy. **Verified** appears only when both
  copies and the index check out.
- Viewer: chat list, timeline with media, a real image lightbox, audio and video
  playback, document download, date separators, jump to date, per-conversation
  and archive-wide search, all on the device. Long conversations mount a window
  of days that grows as you scroll, so a hundred thousand messages stays
  responsive.
- Conversations are cached on the device after the first read, re-encrypted
  under the vault's own key, so reopening a large archive is one local decrypt
  instead of hundreds of round trips. Locking the vault clears it.
- Imports upload several objects at once through a bounded pool, and no database
  transaction is ever held open across a call to a storage provider.
- Usage measured by integrating stored bytes over time, billed once per logical
  byte at $0.05 per GB-month with a GB of 1,000,000,000 bytes; Stripe metered
  billing when configured, and an honest "not configured" when not.
- Trash with a retention window, restore, deliberate purge of both copies,
  account deletion as a scheduled job, and a readable export of any conversation
  that round-trips back through the parser.
- Postgres with row-level security per account, enforced per request, with a
  startup check that refuses a database role the policies would not apply to.

### Not here, and why

- **No cryptographic audit.** The design is documented and tested, and it uses
  only reviewed primitives, but nobody independent has reviewed it. Plan §6.10
  makes that a gate before real customer data.
- **No passkeys.** TOTP is the second factor; WebAuthn is a follow-up.
- **No resume across a page reload.** Upload parts are retried and addressed
  individually, so a flaky connection is fine, but closing the tab mid-import
  means starting that import again.
- **No ciphertext archive download.** You can download a readable copy of a
  conversation. Exporting the encrypted objects for your own cold storage, with a
  tool to read them back, is not built.
- **No sharing, no multi-user archives, no server-side search or AI.** All
  excluded by the plan's MVP non-goals, and the architecture does not assume them.
- **The file-backed metadata store is for development only.** It is single
  process. Production requires `DATABASE_URL`, and the server refuses to start
  without it.

---

## Configuration

Everything has a working default for local use. `.env.example` documents every
variable; the ones that matter in production:

| Variable                | Purpose                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `SERVER_SECRET`         | Signs session cookies and upload tickets; encrypts stored TOTP secrets. Required, 32+ characters. |
| `DATABASE_URL`          | Postgres, as an **unprivileged** role. Required in production.                                    |
| `PRIMARY_*`             | Primary object store: `s3` in production (Cloudflare R2 in the plan).                             |
| `SECONDARY_*`           | The second copy, with its own credentials (Backblaze B2 in the plan).                             |
| `BILLING_MINIMUM_CENTS` | Minimum charge. **Defaults to 0 — not approved.**                                                 |
| `FREE_ALLOWANCE_GB`     | Free allowance. **Defaults to 0 — not approved.**                                                 |
| `STRIPE_*`              | Enables billing. Absent means nothing is charged.                                                 |
| `TRASH_RETENTION_DAYS`  | How long a deleted conversation stays restorable. Default 30.                                     |

For Postgres and the two buckets locally:

```bash
docker compose up -d     # Postgres + two MinIO instances with separate keys
npm run db:migrate       # schema, indexes and row-level security policies
```

Then copy the settings from the bottom of `docker-compose.yml` into `.env.local`.

---

## Before anyone real uses this

`docs/SECURITY.md` lists the gates the plan sets, and none of them are code:
an independent review of the cryptography and the frontend supply chain, a legal
review of archiving conversations that contain other people's messages, a
privacy policy and retention terms, load testing with real provider accounts, and
a margin review against real bills. Until those are done, treat this as a working
implementation of the plan rather than a product that is ready for customers, and
do not ask anyone to delete an irreplaceable export because of what it shows.

ChatVault is an independent project and is not affiliated with, endorsed by or
connected to WhatsApp, Meta or any other messaging provider. It archives exports
that people make themselves, and it does not work around any export restriction,
including choices other participants in a conversation have made.
