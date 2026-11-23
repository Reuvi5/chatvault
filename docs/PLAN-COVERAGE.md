# Coverage against plan.md

Every checklist item in the plan, and what happened to it. "Deferred" means
deliberately not built, with the reason; nothing is marked done unless it is
exercised by a test or the drill.

## §4 MVP — required

| Item | State | Where / note |
| --- | --- | --- |
| Email signup/login and MFA/passkey path | **Done** (TOTP) | `handlers/auth.ts`, `auth/totp.ts`. WebAuthn passkeys deferred. |
| Recovery-key generation and confirmation | **Done** | `crypto/recoveryKey.ts`, `components/SetupVault.tsx`; typed acknowledgement before continuing. |
| Local `.txt` and `.zip` import, iOS/Android detection | **Done** | `parser/transcript.ts`, `parser/archive.ts`; 28 parser tests. |
| Parser: dates, senders, groups, multiline, system events | **Done** | Same, plus locale and ambiguity handling with reported confidence. |
| Media matching and integrity validation | **Done** | `parser/attachments.ts`; plaintext digests per attachment in the manifest. |
| Client-side encryption before upload | **Done** | `crypto/objectFormat.ts`; the drill greps stored data for plaintext. |
| Resumable upload of encrypted data | **Partly** | Parts are addressed individually and retried with backoff. Resume across a page reload is deferred. |
| Primary R2, secondary B2 replication | **Done** | S3 driver per provider; local drivers for development and tests. |
| Import status: imported, backed up, verified | **Done** | `/app/imports/[id]`; `archiveVerified` requires both copies and a readable index. |
| Chat list, timeline, images, video, audio, documents | **Done** | `components/MessageTimeline.tsx`, `components/Attachment.tsx`. |
| Local decrypted search after unlock | **Done** | `client/search.ts`; in-memory index, phrases, sender/date/attachment filters. |
| Re-import deduplication and preview | **Done** | `parser/merge.ts` with 16 tests; preview shown before upload. |
| Per-user usage and projected charges | **Done** | `services/metering.ts`, `/app/usage`; 10 metering tests. |
| Stripe subscription / usage billing | **Done, gated** | `services/billing.ts`: metered GB-months, signed webhooks. Needs real keys and a price. |
| Downloadable archive and tested restore | **Partly** | Readable per-conversation export, round-trip tested; restore proven by `npm run drill:restore`. A ciphertext archive download with an offline reader is deferred. |
| Account deletion and archive deletion flow | **Done** | `services/deletion.ts`; 7 deletion tests including a full account purge. |
| Responsive mobile web | **Done** | Layouts are mobile-first; not yet tested on real devices. |

## §4 Later versions

All deferred, as the plan intends: native share-sheet integration, persistent
encrypted search indexes, batch import, client-side semantic search, a media
gallery, an offline encrypted cache, device-to-device key recovery, family or
shared archives, downloadable integrity proofs.

Two notes. The crypto layer reserves an `index` subkey purpose so a persistent
encrypted index does not need a format change. Shared archives would need key
sharing designed from scratch; nothing in the current model assumes a second
reader, which is the right starting point.

## §5 Architecture

| Item | State |
| --- | --- |
| Client parses, normalises, deduplicates, encrypts locally | Done |
| Ciphertext-only to the server | Done, enforced by the request schemas |
| R2 primary with verified replication to B2 | Done |
| Postgres with account ids, object pointers, statuses, usage ledger | Done, `db/schema.ts` |
| **No plaintext messages in Postgres** | Done: there is no column that could hold one |
| Versioned encrypted chunks/manifests in object storage | Done, `CVOBJ01` + versioned manifests |
| All ten suggested tables | Done, plus `upload_sessions` for resumable uploads |
| Strict owner-based row-level security on every exposed table | Done, generated from the schema, with a startup check |
| Provider secrets kept off the browser | Done: uploads and downloads go through the API with scoped tickets |

## §6 Encryption and privacy

| Item | State |
| --- | --- |
| Random vault master key, locally generated | Done |
| Argon2id with per-user salt and calibrated parameters | Done — 64 MiB / 3 / 1, stored per vault |
| Store only the wrapped key and non-secret KDF metadata | Done |
| Independent data keys per object | Done — HKDF per object with a random salt |
| Audited AEAD with guaranteed nonce uniqueness | Done — AES-256-GCM, per-object keys, counter nonces, immutable objects |
| Encrypt bodies, attachments, names and manifests | Done |
| Authenticate identifiers, versions and metadata as AAD | Done |
| Validate tags and checksums on read and restore | Done, plus plaintext digests to catch rollback |
| Offline recovery key with documented consequences | Done |
| Cryptographic architecture review before real data | **Not done — a launch gate** |
| Streaming encryption, bounded memory, ZIP-bomb limits, resumable uploads | Done |
| Metadata minimisation | Done — random ids, no names in keys, no message timestamps server-side |
| No plaintext in logs, analytics or telemetry | Done — redacting logger, no analytics at all |
| Avoid cross-user deduplication | Done — never implemented |
| Short-lived scoped upload/download authorizations | Done — signed tickets |
| Tight CSP, pinned dependencies, minimal third-party JS | Done — nonce CSP, zero third-party script |
| Do not claim to be impossible to compromise | Done — stated on the landing page and in `SECURITY.md` |
| Privacy policy, retention terms, legal review | **Not done — launch gates** |
| No model training, no targeted advertising on content | Done — no code path can read content |

## §7 Backup and recovery

| Item | State |
| --- | --- |
| Two independent encrypted copies | Done |
| Separate credentials per provider | Done, and identical keys are refused in production |
| Ciphertext-only replication | Done |
| Durable idempotent worker with retries and a dead-letter state | Done |
| Verify source checksums, remote checksums, counts | Done |
| Encrypted metadata backups; media alone is not a restore plan | Partly — enforced in the verification rule; Postgres backups are an operator task, documented |
| Retention/versioning against accidental deletion | Done in policy (trash window, no mirrored deletes); bucket versioning is an operator task |
| Consistent deletion policy reconciled with backups | Done |
| Automated restore exercises and sampling | Done — `drill:restore`, plus scheduled reconciliation in the worker |
| Never mirror deletions immediately | Done |
| Object retention/immutability controls | Operator task, documented |
| Service targets table | Implemented as behaviour: verified only after two verified copies and a recoverable index; RPO bounded by replication, which runs every minute. **No recovery time objective is promised**, as the plan asks. |
| Never encourage deleting an original until verified | Done — the interface says the opposite throughout |

## §8 Import and deduplication

Every input variation in the plan's test matrix has a test: iOS zip, Android txt
and zip with and without media, locales and date formats, 12- and 24-hour time,
DST boundaries, differing display names, multiline, emoji, Unicode, right-to-left
Hebrew and Arabic, system messages, edited and deleted notices, media markers,
voice notes, image and video formats, documents, duplicate filenames, huge groups,
years-long timelines, malformed paths, compression bombs and corrupt members.

Integrity: a versioned canonical format with explicit parser confidence, stable
provenance fingerprints rather than assumed message ids, context-based ambiguity
flagging that never merges silently, encrypted import manifests with the source
checksum and parser version, append/merge preview, reversible import history (the
previous manifest version and its objects stay in the trash), and gap detection.

Deferred: retaining the original export (see `DECISIONS.md` §3).

## §9 Pricing and unit economics

Agreed price implemented exactly, with the plan's own illustrative table as a
test. Billed once per logical byte; GB is 1,000,000,000 bytes and the interface
says so; usage integrated over time with proration to the hour; trash excluded
from billing; current usage, projection and the arithmetic all visible.
Minimum charge and free allowance exist as flags and default to off. Cost-control
measures from the plan are in place: chunked pages rather than an object per
message, a ciphertext cache, caps on import size and rate, quota checks before
upload, no per-customer database, and no server-side search index.

Raw cost figures from the plan are recorded in `protocol/constants.ts` for margin
reporting, with the plan's own warning that the free tiers are per account.

## §10 API

Every operation in the plan's table exists, plus authentication, verification,
MFA, restore, billing status and operations routes. Idempotency keys, validated
bodies, rate limits, scoped upload credentials and cross-tenant tests are all in
place. A test fails the build if a route file exists that the in-process router
does not know about.

## §11 Roadmap

| Milestone | State |
| --- | --- |
| 0 — research and architecture | Done: synthetic fixtures, local parsing and playback, written threat model and crypto spec, two-provider design, cost model, interface built |
| 1 — secure single-user prototype | Done, and its "done when" is the restore drill |
| 2 — robustness and polished viewer | Done, except full virtualisation (see `ARCHITECTURE.md` for why) and cross-reload resume |
| 3 — independent backup and verification | Done: replication, failover reads, retention, reconciliation, dead-letter |
| 4 — billing and multi-tenancy | Done: RLS, usage ledger, quotas, Stripe, cross-tenant tests. Load testing and a margin review are outstanding |
| 5 — private beta and launch | **Not started.** Needs the audit, legal review, real-provider drills and accessibility pass in `SECURITY.md` |

## §12 Success metrics

Measurable from what exists: import success, data-integrity incidents (the
verification and reconciliation paths), backup coverage in bytes on both
providers, recoverability (the drill), search latency, plaintext-free telemetry
and passed cross-tenant tests, invoice-to-usage reconciliation from the ledger,
and economics from the ledger plus provider bills. Retention needs real users.

## §13 Risks

Every mitigation in the plan's table is implemented. The two that remain open are
the ones the plan itself flags as decisions rather than code: whether $0.05/GB is
viable for very small accounts, and the residual risk of a compromised web
frontend, which no amount of this code can close.

## §15 Immediate next engineering tasks

1. **Export parser spike** — done and exceeded: synthetic fixtures for both
   platforms, robust parsing, 1:1 and group chats displayed locally, fixture
   tests.
2. **Client encryption protocol, written and reviewable** — `CRYPTO-SPEC.md`
   covers key derivation and wrapping, the AES-GCM chunk format, per-object keys
   and nonces, the manifest schema, the recovery-key workflow and streaming
   memory limits. Written; **not yet reviewed by anyone independent**.
3. **Dual-provider restore pipeline** — `npm run drill:restore` does exactly what
   the plan describes: upload to the primary, replicate to the secondary,
   simulate losing the primary, restore on another session with only the recovery
   key.

The plan's closing instruction stands: no public beta, and no inviting anyone to
delete irreplaceable originals, until all three pass **and** the security and
restore gates in `SECURITY.md` are cleared.
