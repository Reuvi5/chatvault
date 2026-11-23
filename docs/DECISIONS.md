# The decisions the plan left open

Plan §14 lists ten open questions, and §1 separates "decisions established" from
"recommendations, not yet final decisions". The code honours that separation: a
recommendation is a flag, and every flag defaults to the state that has **not**
been approved. Nothing here is a decision made on your behalf.

## 1. Minimum charge — not enforced

`BILLING_MINIMUM_CENTS=0` by default. The $2.99 floor is implemented and tested
(`packages/protocol/src/pricing.test.ts`), so turning it on is one variable, but
the plan records it as a recommendation, so it is off.

What the numbers say: at $0.05/GB-month, a 10 GB archive pays $0.50 a month. A
fixed card fee of roughly 30¢ plus a percentage eats most of that, and Stripe's
recurring billing adds its own cost, which is exactly why the plan raised a floor.
The alternative the plan also mentions is batching small invoices rather than
charging a minimum; neither is built, because both are commercial decisions.

The usage page states which is in force, and never shows a minimum that is not
being charged.

## 2. Free tier — none

`FREE_ALLOWANCE_GB=0`. The allowance is implemented and tested, so a trial
allowance is a variable change. Worth remembering from plan §9: Cloudflare R2's
10 GB free tier is **per account, not per customer**, so a per-customer free 10 GB
would be a real cost, not a pass-through.

## 3. Retaining the original export — not stored

Only the parsed, encrypted archive is uploaded. The crypto layer already has a
`source` subkey purpose reserved for this, and the manifest records the original
file's SHA-256, its name and its size, so a later opt-in can be verified against
the file the person still holds.

Why it is off: storing the original doubles the bill for the same conversation,
and the plan requires that to be disclosed. It should be a per-import choice with
the cost shown, which is a product decision.

Files in an archive that no message refers to are also not uploaded; the import
preview says how many there were.

## 4. Recovery — passphrase plus an offline recovery key

Both are built. Device-to-device key transfer is not.

The recovery key is 32 random bytes in Crockford base32 with a checksum, shown
once, confirmed with a typed acknowledgement that says plainly that losing both
means nobody can open the archive. Rotation is self-service and invalidates the
previous key immediately.

## 5. Deletion — 30-day recoverable trash

`TRASH_RETENTION_DAYS=30`, the plan's initial proposal. Deleting moves a
conversation to the trash; nothing is removed from either provider during the
window; a scheduled job purges afterwards. A purge is also available immediately,
and requires typing a confirmation.

The cost of the window is real: trashed bytes still occupy both providers and are
**not billed to the customer** (the ledger records the drop when it is trashed),
so a long window is an operator cost. That trade-off is the reason the number is
a variable.

## 6. Import coverage — iOS and Android together

Both from day one. The parser handles both layouts, several locales, 12- and
24-hour clocks, optional seconds, multi-line bodies, system notices, edit and
delete markers, omitted-media placeholders and right-to-left text; it infers the
date order and reports its confidence instead of guessing. `npm run fixtures`
generates the matrix, and the parser tests cover it.

Writing one platform first would not have been less work: the same parser reads
both, and the risk is in the locale and ambiguity handling, which is shared.

## 7. Media — everything the export contains

Every attachment the archive actually holds is imported, byte for byte, with no
transcoding and no thumbnail generation. The viewer plays whatever the browser
can play and offers a download for the rest. Attachments the transcript refers to
but the export omitted are recorded as **missing**, shown as missing, and never
counted as archived.

## 8. Distribution — the web app

A responsive web app, usable on a phone. No native wrapper and no share-sheet
integration. Worth noting that a share extension is not only convenience: a
reviewable native client is the honest answer to the frontend-compromise risk in
`SECURITY.md`, which makes this more than a packaging decision.

## 9. Compliance and market — undecided, and not decidable in code

No jurisdiction is assumed. What the code does provide is the machinery those
obligations need: data export per conversation, account deletion as an auditable
job with a retention window, a documented retention policy, minimal metadata, no
third-party analytics, and no model training on customer content (there is no
code path that could — the server cannot read it).

What is missing is a privacy policy, retention terms, a data-processing position
on the fact that an archive contains other people's messages, and a lawyer.
`SECURITY.md` lists it as a launch gate.

## 10. Name — still ChatVault, still a placeholder

Used throughout as a working name. Trademark and domain availability are
unchecked, as the plan notes. Changing it touches the interface strings, the
`otpauth://` issuer, the recovery-key `CV1-` prefix and the object magic
`CVOBJ01` — the last two are **format identifiers written into stored archives**,
so change them before anyone imports anything real, or not at all.

---

## Decisions the plan had already made, and where they live

| Decision | Where |
| --- | --- |
| $0.05 per logical GB-month | `packages/protocol/src/pricing.ts`, tested against the plan's own table |
| Encrypt on the device before upload | `packages/crypto`, `packages/client/src/importer.ts` |
| Zero-knowledge: no plaintext or keys for the operator | enforced by the API schemas; checked by the drill's plaintext grep |
| Two independent encrypted copies | `services/replication.ts`, `objects/*` |
| A familiar chat browsing experience | `components/MessageTimeline.tsx` |
| Manual exports only; no account sync | there is no code that touches a messaging account |
| Primary R2, secondary B2 | the S3 driver, configured per provider |
| Next.js + TypeScript + React, Supabase-style Postgres | `apps/web`, `db/postgresStore.ts` |
| Single-user private archive, multi-tenant underneath | one vault per account; no sharing anywhere |
