# Threat model and launch gates

This is the plan's §6 threat model, stated as what the code does and does not do.
Read the second table before claiming anything to a customer.

## Protected against

| Threat | How |
| --- | --- |
| A storage vendor reading content | Only ciphertext is uploaded; keys never leave the device. |
| Stolen provider credentials | Same. Credentials reach ciphertext, and the two providers use separate credentials, so one leaked key reaches one copy. |
| An accidentally public bucket | Every object is a ciphertext blob under a random key; a listing shows opaque identifiers and sizes. |
| A metadata database leak | No plaintext, no names, no message timestamps. Session tokens are stored as hashes; login passwords as Argon2id hashes; TOTP secrets encrypted with the server key. |
| An operator reading content | There is no code path that can: the server has no key material capable of decrypting an object. |
| Transit interception | HTTPS in deployment, and the payload is already ciphertext. |
| Cross-account access | Every query is scoped to the session's account, every row's owner is re-checked, and Postgres row-level security enforces it again. `tests/authz.test.ts` drives the real handlers to prove it. |
| A misconfigured metadata API | The store's only interface is a column-whitelisted query builder; there is no generic data API, and no table is reachable without an owner scope. |
| Tampering with stored objects | AES-GCM tags per frame, binding object identity, frame order and the final-frame marker. |
| Rolling an archive back to an older version | Plaintext digests in the encrypted manifest, and a monotonic manifest version the server enforces. |
| A hostile export file | Streamed archive reading with caps on entries, entry size, total size and compression ratio; path traversal refused; nothing written to disk by a name from the archive; nothing executed. |
| Accidental or malicious deletion propagating to the backup | Deletes are never mirrored. Trash has a retention window; purging is a separate, deliberate job. |
| Replay of a write | Idempotency keys on write operations. |
| A stolen upload or download authorization | Tickets are signed, short-lived and scoped to one account, one object and one operation. A ticket is useless on another object, another account or another operation. |
| Credential stuffing | Rate limits per client, identical responses for unknown and wrong-password accounts, optional TOTP. |

## Not protected against

| Threat | Why not, and what reduces it |
| --- | --- |
| **A compromised or malicious frontend deployment** | A hosted web app's code is fetched fresh. Script that runs while a vault is unlocked can read the key and the plaintext. Reduced by: a strict CSP with a per-request nonce and `strict-dynamic`, no third-party script of any kind, no analytics, pinned dependencies, security headers, and a tiny dependency surface. Not eliminated. A reviewable native or desktop client would be the real answer, and the plan lists it as a later step. **Do not market this as impossible to compromise.** |
| A compromised device | Keys live in that device's memory while unlocked. |
| A malicious browser extension | Extensions can read page content. |
| The person revealing their passphrase or recovery key | Nothing can help. |
| A weak passphrase | Argon2id raises the cost; a 12-character minimum, a strength estimate and suggestions nudge. A determined attacker with the stored bundle can still grind a bad passphrase. |
| Copies other participants keep | Archiving your side changes nothing about theirs. |
| Metadata the operator sees | Account identity, object counts, ciphertext sizes, access times and billing data are visible by construction. |
| Traffic analysis | Object sizes and timing leak a shape. Objects are padded only by the frame format. |
| An operator who serves different code to one user | Indistinguishable from the inside. Same answer as the first row. |

## Operational rules the code enforces

- The server refuses to start in production without a server secret, Postgres,
  an S3 primary, a second provider, and distinct credentials for the two
  providers. It also refuses the outage-simulation switch in production.
- It refuses a Postgres role that is a superuser or has `BYPASSRLS`, because the
  policies would be ignored.
- Logging drops fields whose names look like secrets, truncates long strings and
  reduces byte arrays to their length. Plaintext is never logged. Audit rows hold
  a kind, a short non-content detail, the account and a hashed client handle.
- Configuration failures answer 503 with a fixed public message; the specifics go
  to the server log.
- `Archive Verified` is a claim about two verified copies and a recoverable
  index. Nothing else sets it.
- The interface never tells anyone to delete an original. It says the opposite,
  on the import screen and on every conversation.

## Gates before real customer data

From plan §6.10, §7, §11.5 and §15. None of these is code, and none is done.

1. **An independent review of the cryptographic design and implementation.**
   `CRYPTO-SPEC.md` is written to be reviewable. Treat its gaps section as the
   reviewer's starting point.
2. **A review of the frontend supply chain and build integrity** — who can
   deploy, what is pinned, how a bad deployment would be noticed.
3. **Legal review** of archiving conversations that contain other people's
   messages, in the launch jurisdictions, plus a plain-language privacy policy
   and retention and deletion terms.
4. **Real provider accounts, load tested**, with the restore drill run against
   them rather than against local directories, and a measured recovery time
   objective — the plan deliberately does not promise one up front.
5. **A margin review** against real bills: object operations, egress, payment
   fees and support, not just the raw per-GB rates.
6. **An accessibility pass** and a check of upload-abuse behaviour.

Until all of them pass: no public beta, and nobody should be invited to delete an
irreplaceable export on the strength of what this shows them.

## Reporting a problem

Add a real contact route here before anyone outside the team uses this. A product
that holds people's conversations needs a published way to report a flaw and a
stated response time.
