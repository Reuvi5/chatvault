# Cryptographic design

Everything here is implemented in `packages/crypto` and exercised by
`packages/crypto/src/*.test.ts`. Formats are versioned so that an archive written
today stays readable.

**Primitives, all from reviewed implementations.** AES-256-GCM, HKDF-SHA-256 and
SHA-256 come from the platform Web Crypto API. Argon2id comes from `hash-wasm`.
Streaming SHA-256 comes from `hash-wasm`. Nothing in this project implements a
cipher, hash or KDF.

## Key hierarchy

```
vault master key  (32 random bytes, generated on the device, never transmitted)
│
├── wrapped with Argon2id(passphrase, salt, m=64 MiB, t=3, p=1)   → bundle.passphrase
├── wrapped with HKDF-SHA-256(recovery key, salt)                 → bundle.recovery
│
└── HKDF-SHA-256(master key, info = "chatvault/subkey/v1/<purpose>")
      ├── objects    pages and attachments
      ├── manifests  conversation indexes
      ├── index      reserved for a future persistent search index
      └── source     reserved for optional retention of the original export
```

The server stores the bundle — two AES-GCM ciphertexts, the KDF parameters, a
salt, and a 16-hex-character key fingerprint — and nothing else about keys.

Both wraps bind the bundle's own parameters as additional authenticated data
(`{v, keyId, purpose, kdf}`, canonically serialised), so editing the stored
parameters makes unwrapping fail rather than silently produce a different key.
After unwrapping, the key's fingerprint is recomputed and compared.

### Passphrase

Argon2id, 64 MiB, 3 passes, 1 lane, 16-byte salt, 32-byte output. 64 MiB is a
deliberate compromise: expensive to attack in bulk, affordable on an older phone.
The parameters are stored per vault, so they can be raised later without locking
anyone out. Minimum 12 characters, with an estimate and suggestions shown while
typing.

### Recovery key

32 random bytes, shown once, in Crockford base32 with a CRC-16 checksum:

```
CV1-7G8K2-QJ4MN-...   (11 groups of 5)
```

Crockford's alphabet omits I, L, O and U; on input, look-alikes are folded
(`O`→`0`, `I`/`L`→`1`), spacing and case are ignored, and the checksum catches a
mistyped character so the person is told "check that character", not "wrong key".
Wrapping uses HKDF rather than Argon2id because the key is already full entropy.

Rotating the recovery key re-wraps the same master key under a new one and
invalidates the old immediately. Changing the passphrase does the same for the
passphrase wrap. Neither re-encrypts a byte of the archive.

## Encrypted object container (`CVOBJ01`)

Every stored object — message page, attachment, manifest — uses this one format,
so there is a single code path to review and a single code path to restore.

```
magic        8 bytes   "CVOBJ01\n"
headerLen    2 bytes   big-endian
header       JSON, not secret:
             { v, cipher: "A256GCM", objectId, kind, keySaltB64, frameSize }
frame*       repeated, in order:
               4 bytes  big-endian ciphertext length
               1 byte   flags (bit 0 = final frame)
               n bytes  AES-256-GCM ciphertext, 16-byte tag included
```

**Per-object key.** `HKDF-SHA-256(ikm = subkey, salt = 16 random bytes,
info = "chatvault/object/v1/<objectId>")`. The salt is fresh for every object, so
even a reused identifier cannot produce a reused key.

**Nonce.** 12 bytes: four reserved zero bytes, then a 64-bit big-endian frame
counter. A counter is safe here precisely because the key is unique per object,
and objects are immutable — superseding writes a new object with a new identifier
and a new salt rather than rewriting one.

**Additional authenticated data, per frame.**

```
"cvobj" ‖ version(1) ‖ SHA-256(magic ‖ headerLen ‖ header) ‖ frameIndex(8, BE) ‖ flags(1)
```

That binds every frame to its object, its position, its header and whether it is
the last frame. The consequences, each covered by a test:

| Attack | Result |
| --- | --- |
| Flip any bit, anywhere | Authentication fails |
| Reorder two frames | Fails: the frame index is authenticated |
| Duplicate a frame | Fails |
| Drop the last frame | Fails: no frame marked final arrived |
| Append frames after the final one | Fails |
| Serve object B for object A | Fails: the key is derived from the identifier |
| Edit the header | Fails: the header digest is in every frame's AAD |
| Wrong key | Fails, with one undifferentiated error |

Decryption errors never say which check failed.

**Frames** default to 1 MiB of plaintext. Both directions stream a frame at a
time, so a multi-gigabyte attachment is never held in memory.

## Rollback detection

Frame authentication proves an object was not altered. It cannot prove the object
is the *current* one: a hostile server could serve an older, perfectly authentic
version. So the (encrypted) manifest records the SHA-256 of each page's and each
attachment's plaintext, and the reader checks it after decrypting. A stale object
decrypts and is then refused, naming the page.

The manifest itself is versioned, and the server rejects a completion whose
version is not exactly the next one, so two devices importing at once cannot
quietly overwrite each other.

## Checksums, and who they are for

- `plaintextSha256` lives in the encrypted manifest and is the client's integrity
  check, described above.
- `ciphertextSha256` is given to the server, which **reads the stored object back
  and recomputes it** before accepting the upload. A mismatch is refused, the
  blob removed, the row deleted and an audit event written. The replication
  worker checks the same digest against the second copy.
- The server's digest is not an integrity proof *to the client* — the server
  computed it. The AES-GCM tags are, and the client verifies the digest it
  receives only to catch a corrupted transfer early.

## What is sent to the server

Nothing in any request body carries message text, contact or group names, file
names or message timestamps. Requests carry opaque identifiers, ciphertext
lengths, ciphertext digests, object kinds and the wrapped key bundle. The schemas
in `packages/protocol/src/api.ts` are the enforced definition of that boundary.

## Limits

Enforced in `packages/protocol/src/constants.ts` and checked by tests:

| Limit | Value |
| --- | --- |
| Frames per object | 262,144 |
| Ciphertext per frame | 8 MiB hard ceiling |
| Object header | 1 KiB |
| Archive entries | 200,000 |
| Single entry | 2 GiB |
| Transcript | 256 MiB |
| Whole archive (uncompressed) | 8 GiB |
| Compression ratio | 200× before the import is refused |
| Messages per import | 2,000,000 |

## Known gaps

- **No independent review.** Plan §6.10 requires one before real customer data.
- **A compromised frontend deployment defeats all of this** while a vault is
  unlocked. Mitigations are listed in `SECURITY.md`; none of them is a proof.
- **Metadata is not hidden.** Object counts, sizes and access times are visible
  to the operator by construction.
- **No per-message forward secrecy or deniability.** This is an archive: the
  whole point is that the holder of one key can read everything, forever.
