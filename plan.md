# ChatVault — Product & Engineering Plan

**Status:** Planning draft  
**Updated:** November 17, 2026  
**Working name:** ChatVault (placeholder; confirm trademark/domain availability)  
**Product type:** Private, cloud-hosted archive for exported WhatsApp conversations  
**Primary platform:** Mobile-friendly web app / PWA, with native integrations later

## 1. Executive summary

Build a consumer app that lets people export old WhatsApp conversations, upload them securely, and view them in a familiar chat-style interface from any device. The goal is to **preserve conversations, photos, voice notes, videos, and documents in the cloud**, potentially freeing phone storage, **without operating a replacement messaging service**.

The central product promise:

> Your chat history, preserved. Private, searchable, and accessible when you need it.

**Decisions established in discussion**

- Charge customers **$0.05 per logical GB stored per month**.
- Encrypt exported chats **on the user's device before cloud upload**.
- Aim for a **zero-knowledge architecture**: the operator and storage vendors do not hold users' plaintext chat content or decryption keys.
- Keep **two independent encrypted copies** of stored data.
- Prioritize a **WhatsApp-inspired browsing experience** with messages and media in chronological order.
- Start with **manual WhatsApp chat exports**; do not promise automatic sync of personal WhatsApp accounts.

**Recommendations, not yet final decisions**

- Primary encrypted object store: **Cloudflare R2**.
- Secondary independent encrypted backup: **Backblaze B2**.
- App stack: **Next.js + TypeScript + React**, hosted on Vercel; **Supabase Auth + PostgreSQL** for account and storage metadata.
- Billing: Stripe; consider a **$2.99 monthly minimum**, but **do not enforce it until approved**.
- Focus the first launch on a **single-user private archive** with multi-tenant architecture; no sharing or collaborative accounts in the MVP.

## 2. User problem and goals

### Problem

- WhatsApp chats and attachments can occupy substantial device storage.
- Users want to preserve meaningful old conversations without keeping all old media locally.
- WhatsApp's native backup/transfer tools are designed primarily for restoring WhatsApp, not for browsing old conversations in a separate archive.
- Exported chats are inconvenient to read and organize as text/ZIP files.

### Product goals

1. Make importing a WhatsApp export straightforward and trustworthy.
2. Display messages in a modern, familiar chat UI (bubble layout, sender identities, dates, attachments).
3. Enable reading, browsing, and searching archives on desktop and mobile.
4. Prevent the application backend and cloud providers from reading private chat content.
5. Provide independent backup, integrity checks, and verifiable restoration.
6. Offer transparent, low-cost, usage-based pricing.

### Non-goals for MVP

- Sending or receiving live WhatsApp messages.
- Automatically syncing a personal WhatsApp account via unsupported automation.
- Reimporting exported conversations back into WhatsApp.
- Circumventing WhatsApp export restrictions, including controls set by chat participants.
- Recreating WhatsApp's trademarks or presenting the service as affiliated with WhatsApp.
- Sharing an archive among multiple accounts or enabling public links.
- Server-side AI over plaintext chat history.

## 3. Product experience

### Core journeys

**First-time setup**

1. Create account; verify email; enable passkey or MFA where supported.
2. Create or unlock a user-controlled encryption key.
3. Display and require confirmation of an **offline recovery key**.
4. Explain plainly: losing the unlock secret and recovery key may permanently prevent restoration.

**Import a chat**

1. In WhatsApp, choose a 1:1 or group chat and use **Export Chat**.
2. Choose to include media when desired; save/export the file.
3. In ChatVault, select the `.zip` or `.txt` export.
4. Parse the file **locally** in the browser/app.
5. Preview chat name, participant count, message count, date range, included media, and warnings.
6. Encrypt messages and media on-device; upload ciphertext in resumable chunks.
7. Confirm the primary copy and backup copy have been stored and verified.
8. Mark the import **Archive Verified** only when integrity and recovery criteria are met.
9. Remind users not to delete the original until they have independently verified the archive. Never delete the original WhatsApp chat automatically.

**Browse archived content**

- Chat list with names or group titles, last message preview, dates, and search.
- Chat view with left/right message bubbles, sender labels, timestamps, date separators, and media previews.
- Tap images to enlarge, play voice notes and videos, download documents.
- Jump to date; search words within a conversation or the whole unlocked archive.
- Responsive layouts for phone and desktop; dark/light mode and accessibility.

**Re-import an updated chat**

- Preview newly detected messages and overlap with existing archive.
- Merge without duplicates where reliably possible.
- Clearly identify ambiguities, missing media, and possible gaps.
- Never silently delete earlier messages because a newer export omits them.

### Important export constraints

WhatsApp's export feature is typically **per conversation**, not a bulk full-account export. Available messages and media can be incomplete; media may be limited to more recent attachments. Exported text is **not a WhatsApp restorable backup**. The product must indicate coverage and missing assets instead of asserting completeness. See [WhatsApp's export help](https://faq.whatsapp.com/1180414079177245/).

## 4. Initial feature scope

### MVP — required

- [ ] Email-based signup/login and MFA/passkey path.
- [ ] Recovery-key generation and confirmation.
- [ ] Local `.txt` and `.zip` import with WhatsApp iOS/Android format detection.
- [ ] Local parser for dates, sender names, group messages, multiline messages, and system events.
- [ ] Media attachment matching and integrity validation.
- [ ] Client-side encryption **before** upload.
- [ ] Resumable upload of encrypted chat data and media.
- [ ] Primary R2 object storage and B2 secondary replication.
- [ ] Import-status screen: imported, backed up, and verified.
- [ ] Chat list; chat timeline; images, video, audio, documents.
- [ ] Local, decrypted full-text search after unlocking archive.
- [ ] Re-import deduplication and preview.
- [ ] Per-user storage usage and projected monthly charges.
- [ ] Stripe subscription / usage billing.
- [ ] Downloadable encrypted archive and tested restore workflow.
- [ ] Account deletion and explicit archive deletion flow.
- [ ] Responsive mobile web experience.

### Later versions

- [ ] iOS/Android share-sheet integration via native wrapper or extension.
- [ ] More sophisticated encrypted local search indexes.
- [ ] Export/import batches and multi-file drag/drop.
- [ ] Client-side optional summaries or semantic search, subject to an explicit privacy design.
- [ ] Media gallery and advanced filters.
- [ ] Offline encrypted cache and improved PWA support.
- [ ] Encrypted device-to-device key recovery.
- [ ] Family/shared archives with carefully designed key sharing.
- [ ] Downloadable proofs of integrity for archival/evidentiary use.

## 5. Proposed technical architecture

```text
WhatsApp export (.zip/.txt)
          |
          v
Browser / future native client
  - parse and preview locally
  - normalize and deduplicate locally
  - generate/encrypt archive manifest
  - chunk and encrypt attachments
  - maintain decrypted search index locally
          |
    ciphertext only
          |
          +------> Cloudflare R2: primary objects
          |                  |
          |          verified replication job
          |                  v
          |          Backblaze B2: secondary copy
          |
          +------> API / Supabase PostgreSQL
                     - account IDs
                     - encrypted object pointers
                     - upload/replication statuses
                     - byte usage and billing ledger
                     - minimal operational metadata
                     - **no plaintext messages**
```

### Technology choices

| Layer | Initial choice | Notes |
| --- | --- | --- |
| Web UI | Next.js, React, TypeScript | Responsive PWA; virtualized chat list/timeline |
| UI design | Tailwind CSS + accessible components | Distinct branding; familiar UX without copying protected assets |
| Hosting | Vercel | Keep server logs free of plaintext content |
| Authentication | Supabase Auth | MFA, device/session management |
| Metadata DB | Supabase PostgreSQL | RLS on user-owned rows; no plaintext messages |
| Primary object store | Cloudflare R2 (Standard) | Private encrypted object blobs; read-heavy access |
| Backup object store | Backblaze B2 | Separate account/provider and credentials |
| Background jobs | Durable worker/queue | Retry-safe replication, verification, billing aggregation |
| Billing | Stripe | Per-GB-month meter; invoices and failed-payment state |
| Client crypto | Web Crypto + audited crypto/KDF library | Use a reviewed design; never custom cryptographic primitives |
| Local search | IndexedDB + client-side index | Search only after unlock; no server-readable tokens |

**Database design note:** If message bodies must remain unreadable to the server, do not store plaintext message rows in PostgreSQL. Store versioned **encrypted chat chunks/manifests** in object storage, with only opaque IDs and non-sensitive operational metadata in Postgres. The client decrypts enough chunks to render/search. This changes how the viewer is paginated and indexed; design the encrypted chunk format early.

### Suggested metadata tables

- `accounts` — user ID, account state, signup and billing identifiers.
- `vaults` — owner ID, encrypted vault metadata pointer, crypto format version.
- `conversations` — opaque conversation ID, vault ID, encrypted manifest pointer, state.
- `imports` — import ID, source format, processing status, encrypted checksum/manifest references.
- `objects` — opaque ID, owner ID, ciphertext length, storage key, verification state.
- `replicas` — object ID, provider, location, replica version, checksum, last verified.
- `usage_ledger` — daily logical encrypted bytes by account and reconciled usage.
- `billing_periods` — period, accrued GB-months, invoice/meter state.
- `deletion_jobs` — deletion requests, retention-window status, deletion verification.
- `security_audit_events` — minimal non-content security and account events.

Use strict owner-based row-level security on every exposed table; authorization must never rely merely on being logged in. Keep provider secret keys off the browser.

## 6. End-to-end encryption and privacy specification

### Threat model

Protect against: storage-vendor access, stolen provider credentials, accidental public buckets, database leaks, server operators reading content, transit interception, cross-account access, and misconfigured metadata APIs.

Cannot fully protect against: compromised user devices, malicious browser extensions, a malicious client update, a user revealing keys, screenshots or copies retained by other participants, and a weak recovery secret.

### Cryptographic design to implement and review

1. Generate a cryptographically random **vault master key** locally.
2. Derive a wrapping key from a strong user passphrase using **Argon2id**, with per-user salt and calibrated parameters; consider memory constraints on older phones.
3. Wrap the master key; store only the wrapped form and non-secret KDF metadata in the backend.
4. Generate independent data-encryption keys (or derive compartmentalized subkeys with a vetted KDF) for chunks/assets.
5. Encrypt with an audited authenticated-encryption construction such as **AES-256-GCM**, with guaranteed nonce uniqueness for each key.
6. Encrypt message bodies, attachment contents, contact/group names, and sensitive manifests before network transfer.
7. Authenticate file/chunk identifiers, format versions, and important metadata as associated data where appropriate.
8. Validate authentication tags and checksums during read/restore.
9. Provide an offline recovery key; explicitly document loss-of-key consequences.
10. Perform a cryptographic architecture review before handling real customer data.

**Do not** implement one giant in-memory encrypt-and-upload operation for large media ZIPs. Use a streaming parser/encryptor, bounded memory, authenticated chunks, content-size and ZIP-bomb limits, and resumable uploads. Do not reuse an AES-GCM nonce with the same key.

### Metadata minimization

- Use random opaque IDs for users' objects and conversations; avoid names in object keys/URLs.
- Avoid sending plaintext contact names, phone numbers, group names, message contents, searchable terms, or message timestamps to the backend if not essential.
- The backend necessarily learns some metadata (account identity, encrypted byte counts, access timing, object counts, billing information).
- Avoid global cross-user content deduplication, which can create privacy and inference risks.
- Use per-user authenticated access and short-lived, narrowly scoped upload/download authorizations.
- No plaintext exports, decrypted thumbnails, or decryption keys in server logs, error reports, analytics, email, support tickets, or crash telemetry.

### Important caveat about web-based encryption

A hosted web app is **not immune to a malicious or compromised frontend deployment**. A compromised script could read decrypted chats or keys when a user unlocks. Mitigate with a tight Content Security Policy, pinned dependencies, build/integrity controls, minimal third-party JavaScript, security reviews, and eventually a reproducible/reviewable native or desktop client if the threat model warrants it. Do not market the service as absolutely impossible to compromise.

### Privacy and compliance work

- Publish plain-language privacy policy and retention/deletion terms.
- Implement data export, account deletion, and documented recovery of backups.
- Clarify rights and obligations around archiving conversations containing other people's data.
- Before a wider launch, evaluate applicable privacy laws and jurisdiction requirements with legal counsel.
- Do not train models on users' content or use it for targeted advertising.

## 7. Backup and disaster recovery

**Default strategy:** two independent encrypted cloud copies.

- **Primary:** Cloudflare R2.
- **Secondary:** Backblaze B2 under separate credentials/account.
- The encrypted payload is replicated as ciphertext; the backup provider must never need the user's key.
- Replication is performed by a durable, idempotent worker with retries and a dead-letter queue.
- Verify source checksums, remote checksums, replica manifests, and object counts.
- Store encrypted DB/manifest backups and sufficient metadata to reconstruct the vault; **media alone is not a restore plan**.
- Retain historical versions / protect a recovery window against accidental or malicious deletion.
- Define a consistent deletion policy and reconcile it with backup retention; communicate any delay before permanent erasure.
- Run automated restore exercises and periodic sampling; test an actual full user-vault recovery on a scheduled basis.
- Avoid using replication that blindly mirrors deletions immediately.
- Where appropriate, use object retention/immutability controls with a carefully defined emergency-deletion policy.

### Suggested service targets (proposals)

| Metric | Proposed target |
| --- | --- |
| New upload primary commit | Immediately after primary upload + checksum verification |
| Secondary backup creation | Within 24 hours, preferably faster |
| Customer sees **Verified** | Only after two verified copies + usable metadata/manifest recovery path |
| Backup verification | Continuous spot checks + scheduled full reconciliation |
| Recovery point objective | At most 24 hours for confirmed backed-up archives |
| Recovery time objective | Define after real restore/load testing; do not promise initially |
| Historical deletion recovery window | 30 days as an initial proposal; reassess cost/privacy implications |

**Critical rule:** Never encourage users to delete their original chat until the system has verified the archive and the user has checked that it can be reopened.

## 8. Import and deduplication details

### Input variations to test

- iOS `.zip` with transcript and attachments.
- Android `.txt` or `.zip` with and without media.
- Different locales/date formats, 12- and 24-hour time, DST boundaries.
- Different sender display names for the same person.
- Multiline content, emoji, Unicode, right-to-left Hebrew/Arabic.
- System messages, edited/deleted notices, forwarded messages, replies and media markers.
- Voice notes, image/video formats, documents, duplicate filenames, unsupported attachments.
- Huge groups and years-long timelines.
- ZIP archives with malformed paths, compression bombs, or corrupt members.

### Data integrity / idempotency

- Parse into a versioned canonical format with explicit parser confidence.
- Prefer stable provenance plus canonical message fields when deduplicating; recognize that exports generally **lack globally reliable message IDs**.
- Use context windows (timestamp, sender, body, attachment metadata, neighbors) to flag likely duplicates; never silently merge ambiguous distinct messages.
- Store encrypted import manifests with original source-file checksum and parser version.
- Support append/merge preview and a reversible import history.
- Preserve the original export encrypted as an **optional** setting; disclose its additional storage/billing implications.
- Offer gap detection and warnings when an export contains only a subset of history.

## 9. Storage measurement, pricing, and unit economics

### Customer price — agreed

**$0.05 per GB-month of logical customer archive data.**

- Bill **once per logical stored byte**, not once per physical replica.
- Define a GB as **1,000,000,000 bytes** for pricing and show this in the UI.
- Usage accrues over time (byte-hours or daily GB-month averages), with clear prorating.
- Explain whether optional original-file retention, historical versions, and trash count toward usage. Proposed approach: bill customer for **current logical archive data**, while short-lived system recovery copies are included.
- Show current usage, estimated end-of-month bill, and invoice history.
- Decide whether accounts need a minimum charge or a free allowance before launch.

### Illustrative customer bills (one logical copy)

| Logical archive size | Monthly customer bill |
| ---: | ---: |
| 10 GB | $0.50 |
| 50 GB | $2.50 |
| 100 GB | $5.00 |
| 250 GB | $12.50 |
| 500 GB | $25.00 |
| 1,000 GB | $50.00 |

### Approximate raw storage cost model

Verified public list rates as of Nov. 17, 2026:

- Cloudflare R2 Standard: **$0.015/GB-month** (account-level 10 GB free); reads/writes can incur request charges; no egress charges.
- Backblaze B2: **$6.95/TB-month**, i.e. approximately **$0.00695/GB-month** at decimal units (10 GB free).
- Combined marginal raw-copy cost: about **$0.02195/GB-month** before free tiers, retention overhead, object operations, bandwidth limits, databases, support, payment fees, and taxes.
- Marginal storage-only gross contribution: **$0.02805/GB-month** (~56.1% of revenue) *before other costs*.

At 100 GB, that is roughly **$5.00 revenue** minus **$2.20 raw two-copy storage**, or **$2.80 before all other expenses**. Real gross margin will be lower. Cloudflare's free allowance is *per account*, not per customer. Avoid claiming every customer gets an individual 10 GB free tier.

**Pricing question to resolve:** A suggested **$2.99/month minimum** would help with payments and support economics, but this was a recommendation, **not an approved requirement**.

**Payment processing note:** Stripe has payment fees and can have additional recurring billing fees; model these separately in the unit economics. Batch tiny invoices or adopt a minimum to avoid the fixed per-transaction fee overwhelming small charges.

### Cost-control measures

- Store chat content in reasonably sized encrypted segments rather than one object per message.
- Virtualize rendering and cache encrypted chunks to avoid excessive GET requests.
- Limit unbounded import sizes and request rates; enforce user quotas before upload.
- Use lifecycle policies only when compatible with backups and privacy commitments.
- Alert on unexpected per-user egress, object operations, failed replication, and billing drift.
- Do **not** place a separate paid PostgreSQL instance behind each customer.
- Keep plaintext client-side search indexes off the backend; optimize encrypted chunk fetches and local indexing.

## 10. API / service boundaries

Indicative routes / operations; exact shape may change.

| API operation | Responsibility |
| --- | --- |
| `POST /vaults` | Create vault metadata / upload policy |
| `POST /imports` | Initialize encrypted import session |
| `POST /objects/upload-authorize` | Issue short-lived scoped upload permission |
| `POST /imports/{id}/complete` | Verify uploaded object manifests and schedule replication |
| `GET /conversations` | Return opaque IDs and authorized encrypted-manifest pointers |
| `GET /objects/{id}/download-authorize` | Authorize ciphertext retrieval |
| `GET /vaults/{id}/usage` | Reconciled logical bytes and estimated bill |
| `GET /imports/{id}/status` | Primary, backup, verified, failed state |
| `POST /billing/checkout` | Begin Stripe subscription |
| `POST /billing/webhook` | Verify Stripe signature and update billing state |
| `POST /account/delete` | Start clear, auditable deletion process |

Use idempotency keys for write operations, signed/authenticated requests, rate limits, bounded upload credentials, and cross-tenant access tests.

## 11. Delivery roadmap

### Milestone 0 — Research and architecture

- [ ] Collect **consented/synthetic** sample exports from iOS and Android; document limitations.
- [ ] Prove local parsing and playback of representative media.
- [ ] Create an explicit threat model, encrypted object format, and key-recovery design.
- [ ] Design the two-provider replication and restore lifecycle.
- [ ] Validate storage/operations/Stripe costs with realistic workloads.
- [ ] Wireframe the mobile and desktop browsing experiences.

**Done when:** a written security design exists; parsers handle representative exports; a realistic 100 GB cost model is approved.

### Milestone 1 — Secure single-user prototype

- [ ] Create the app scaffold and private test environment.
- [ ] Implement user login and vault setup.
- [ ] Encrypt/decrypt local test messages and attachments.
- [ ] Upload ciphertext to R2 with resumable uploads.
- [ ] Render decrypted messages/media in chat-style UI.
- [ ] Build reliable import progress/errors and restore from R2.

**Done when:** one real-size test export can be imported, closed, reopened on another authorized device, searched, and restored with no server plaintext.

### Milestone 2 — Robustness and polished viewer

- [ ] Implement full parser test matrix, import preview, missing-media warning, and deduplication.
- [ ] Add virtual scrolling, lazy media loading, mobile responsiveness, and local search.
- [ ] Support attachment downloads and large files.
- [ ] Add encrypted manifest versioning and error recovery.

**Done when:** normal, repeated, corrupted, and large imports work predictably and cannot silently lose messages.

### Milestone 3 — Independent backup and verification

- [ ] Add B2 replication worker and statuses.
- [ ] Verify checksums and restore from B2 with R2 unavailable.
- [ ] Add retention/versioning, deletion protections, and a defined recovery policy.
- [ ] Add periodic reconciliation/restore tests and alerts.

**Done when:** the product only shows **Verified** after both copies and manifests pass checks; full recovery succeeds in a disaster test.

### Milestone 4 — Billing and multi-tenancy

- [ ] Strict RLS and per-user object authorization.
- [ ] Usage ledger, GB-month calculation, quota enforcement, and billing UI.
- [ ] Stripe checkout, usage reporting, webhooks, retry/dunning, and reconciliation.
- [ ] Privacy policy, terms, support processes, deletion/retention disclosures.
- [ ] Load test mixed customer archives; review gross margin.

**Done when:** two test users cannot read each other's encrypted objects or metadata; invoices match measured logical GB-months; operational alerts work.

### Milestone 5 — Private beta and launch

- [ ] Invite a small consenting beta group.
- [ ] Audit the cryptographic implementation and frontend dependencies.
- [ ] Run accessibility, security, upload-abuse, and disaster-recovery checks.
- [ ] Collect actual import failures, search latency, retention, and support burden.
- [ ] Finalize product name, branding, pricing minimum, and storage policy.
- [ ] Launch publicly only after the privacy and restore gates pass.

**Done when:** users can import, browse, search, recover, pay, and delete their archives with reliable support and no known critical security issues.

## 12. Success metrics

| Area | Measure |
| --- | --- |
| Import quality | Successful completed imports / attempted valid imports |
| Data integrity | 0 known silent data-loss incidents; corruption caught and reported |
| Backup coverage | % of logical bytes verified on **both** independent providers |
| Recoverability | Routine full restoration succeeds using recovery key |
| Experience | Time to first readable chat; time to open long chats; search latency |
| Privacy | No plaintext content in backend telemetry; passed cross-tenant tests |
| Billing | Invoice-to-usage reconciliation within a documented tolerance |
| Economics | Revenue, storage cost, operation fees, payment fees, contribution per account |
| Retention | Repeat usage and archive retrieval after initial import |

## 13. Key risks and mitigations

| Risk | Mitigation |
| --- | --- |
| WhatsApp exports omit old data/media | Display gaps; never promise a complete account backup |
| New export differs from old formatting | Versioned parsers and fixture regression tests |
| Two messages look identical | Conservative deduplication and review UI |
| User loses encryption key | Offline recovery key, confirmation flow, restore rehearsal |
| Compromised web frontend | CSP, security controls, minimal JS, client integrity strategy |
| Accidental deletion propagates to backup | Versioning, delayed deletion, independent retention |
| Database lost while media survives | Backup manifests and recoverable metadata |
| Cloud provider/account fails | Separate provider/accounts and tested B2 restore |
| $0.05/GB is unprofitable for tiny accounts | Evaluate minimum monthly charge before launch |
| Heavy object reads / large numbers of small blobs | Chunking, caching, virtualized UI, budget alerts |
| Untrusted ZIP causes resource abuse | Stream processing, limits, sanitize paths, never execute contents |
| Billing discrepancy | Immutable usage ledger, reconciliations and customer-visible calculation |

## 14. Open decisions

1. **Minimum charge:** $0.05/GB only, or $0.05/GB with a suggested $2.99 monthly floor?
2. **Free tier:** no free plan, a small trial allowance, or limited-duration trial?
3. **Encrypted source retention:** store original uploaded ZIP (billed) or store only parsed encrypted archive?
4. **Recovery:** passphrase + offline recovery key initially; add device-to-device transfer later?
5. **Deletion:** 30-day recoverable trash or immediate purge request with separate backup-retention schedule?
6. **Import coverage:** target iPhone first or parity with Android on day one?
7. **Media:** include all available export attachments in MVP; defer unsupported codecs/transcoding.
8. **Distribution:** launch as PWA first, then add optional native share extension.
9. **Compliance/market:** initial launch geography and applicable regulatory/privacy policies.
10. **Name:** choose final brand before public launch.

## 15. Immediate next engineering tasks

1. **Build an export parser spike.** Collect anonymized/synthetic fixture files for iOS and Android, implement robust parsing and display 1:1 and group chats locally, with fixture-based tests.
2. **Write and review the client encryption protocol.** Specify key derivation/wrapping, AES-GCM chunk format, per-object nonces/keys, manifest schema, recovery-key workflow, and streaming memory limits.
3. **Prototype the dual-provider restore pipeline.** Upload an encrypted test archive to R2, replicate it to B2, simulate losing R2, and restore on another device from B2 using only a recovery key.

Do not begin a public beta or invite users to delete irreplaceable originals until all three tasks pass their security and restore tests.

---

## References / live documentation

Pricing and API limits must be rechecked before commercial launch.

- [WhatsApp Help Center — Export chat history](https://faq.whatsapp.com/1180414079177245/)
- [Cloudflare R2 — Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Backblaze B2 — Pricing](https://www.backblaze.com/cloud-storage/pricing)
- [Supabase — Pricing](https://supabase.com/pricing)
- [Supabase — Data API security](https://supabase.com/docs/guides/api/securing-your-api)
- [Stripe Billing — Pricing](https://stripe.com/billing/pricing)
- [Web Cryptography API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
