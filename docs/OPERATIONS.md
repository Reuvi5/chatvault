# Operations

## Deploying

The app is a Next.js server plus a worker process. Both read the same
configuration and need the same network access.

```bash
npm install
npm run build
npm start          # the web app
npm run worker     # a second process, long-running
```

The server validates its configuration on first use and refuses to run on
development defaults in production. What it requires:

```
SERVER_SECRET=<32+ random characters>          # openssl rand -base64 32
DATABASE_URL=postgres://chatvault_app:…@host/chatvault
PRIMARY_DRIVER=s3
PRIMARY_BUCKET=…  PRIMARY_ENDPOINT=…  PRIMARY_ACCESS_KEY_ID=…  PRIMARY_SECRET_ACCESS_KEY=…
SECONDARY_DRIVER=s3
SECONDARY_BUCKET=…  SECONDARY_ENDPOINT=…  SECONDARY_ACCESS_KEY_ID=…  SECONDARY_SECRET_ACCESS_KEY=…
APP_URL=https://your-domain
```

The two providers must use **different credentials**; the server checks and
refuses identical access keys. Rotating `SERVER_SECRET` invalidates every session
and every outstanding upload or download ticket, and makes stored TOTP secrets
unreadable — so re-enrolment is required. It has no effect on archives.

### Postgres, and making row-level security real

```bash
# As a role that may create tables and policies:
DATABASE_ADMIN_URL=postgres://postgres:…@host/chatvault npm run db:migrate

# Review the SQL first if you prefer:
npm run db:sql | less
```

The migration creates the tables, the indexes, the `chatvault_app` role, and a
policy per table comparing the owner column with `chatvault.account_id`, which
each request sets with `SET LOCAL` inside its transaction.

**The application must connect as an unprivileged role.** Policies do not apply
to a superuser or to a role with `BYPASSRLS`. The server checks its own role at
startup and refuses to run if it is privileged, and checks that every owned table
has RLS enabled.

Background work genuinely spans accounts, so the worker paths set
`chatvault.account_id` to `__service__`, which the policies accept. Nothing that
serves a user request uses it. What RLS buys you here is protection against the
failure the plan names — a query that forgets its owner filter — not protection
from the application, which holds the credentials either way.

### Object stores

Create one bucket per provider, both private, and for each one:

- **Versioning on.** It is the recovery window for an accidental or malicious
  delete, and the reason deletes are never mirrored.
- **A lifecycle rule to abort incomplete multipart uploads** after a day or two.
  An interrupted import leaves parts behind; the worker abandons the import rows,
  and this rule cleans up the provider side.
- **No public access, no CORS for the browser.** All traffic goes through the
  API, which is what keeps credentials server-side and lets the server verify a
  ciphertext digest before accepting an object.
- Object-lock or retention, if your providers support it, with a documented
  emergency-deletion procedure. Plan §7 asks for both.

### Body size

Upload parts are 8 MiB by default on S3. If a proxy sits in front of the app,
raise its body limit above that (`client_max_body_size 12m` in nginx), or lower
`PRIMARY_PART_SIZE_BYTES` — but S3 multipart requires at least 5 MiB per part
except the last, so the floor is 5 MiB.

## The worker

One pass a minute, each pass idempotent and safe to run while the app serves:

1. replicate and verify objects on the second provider,
2. spot check a sample of already-verified objects on both providers,
3. execute deletion jobs whose retention window has passed,
4. purge objects whose window has passed,
5. abandon imports that were never completed,
6. clear expired sessions and idempotency keys,
7. accrue usage per account and report it to Stripe when configured.

Run exactly one worker, or expect duplicated work (harmless, since every step is
idempotent, but wasteful). `npm run worker -- --once` suits a cron schedule.

### Alerts worth having

From plan §9, and all visible in what the worker logs:

- `deadLettered` above zero — objects that could not be copied to the backup.
  Those conversations never become verified; the person can see it, so you should
  see it first.
- `spotCheckMismatches` above zero — a copy has gone missing or changed size
  since it was verified. Treat as an incident.
- Deletion jobs with `state = failed`.
- Replication queue depth growing over hours.
- Unexpected egress or object-operation spend per account.
- `usageReported` falling to zero while accounts are active, once billing is on.

## Drills

```bash
npm run drill:restore
```

Thirteen checks, in about ten seconds: import, verify both copies, make the
primary unreachable, restore from the backup copy using only the recovery key,
compare every message and attachment with what went in, and grep everything
stored for plaintext.

Run it in CI, and run it against **real provider accounts** before launch (set
the `PRIMARY_*` and `SECONDARY_*` S3 variables and leave `CHATVAULT_DATA_DIR`
pointing at a scratch directory). Plan §7 asks for a scheduled full-vault
recovery test; this is the mechanism, and the schedule is yours to set.

The same code path is available per conversation in the interface — "Check this
archive" downloads every object, decrypts it and compares it with the index — so
support can verify a customer's archive without any access to its contents.

## Day-to-day questions

**"My archive says Backing up and never becomes Verified."** An object is in
`replication_failed`. Check the worker log for the object id. The data is on the
primary; the backup copy could not be made or did not match.

**"A customer disputes their bill."** `usage_ledger` is append-only and holds the
measurements each invoice is derived from. `GET /api/vaults/current/usage` shows
the same numbers the customer sees, including the GB-month arithmetic. Billing
periods keep what was reported to Stripe, so a double-report cannot inflate a
bill.

**"A customer deleted a conversation by accident."** It is in the trash until
`purge_after_ms`. Restoring is self-service. After a purge, both copies are gone
and the versioning on your buckets is the only remaining path — treat that as an
incident, not a feature.

**"A customer forgot their passphrase."** They need their recovery key. If both
are gone, the archive cannot be opened, by them or by you. Say so plainly; it is
the point of the design, and the setup flow made them confirm it.

**"We need to raise the Argon2id parameters."** They are stored per vault, and a
re-wrap on the next passphrase change picks up the new ones. Old vaults keep
working on their recorded parameters.

## Backups of the metadata, not just the objects

Media alone is not a restore plan (plan §7). Back up Postgres on its own
schedule, keep those dumps encrypted, and include a metadata restore in the
drill: without `objects` and `conversations` rows, the blobs are unreachable even
though they are intact. An archive is the manifest plus the objects, and the
manifest pointer lives in Postgres.
