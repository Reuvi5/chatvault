/**
 * A local cache of decrypted conversations, encrypted at rest.
 *
 * Opening a large conversation used to mean fetching and decrypting every page
 * again, every session: a hundred-thousand-message archive is two hundred round
 * trips before the first bubble appears. This caches the canonical message list
 * on the device instead, so a second visit is one local read and one decrypt.
 *
 * It is encrypted with the vault's `index` subkey — the purpose reserved for
 * exactly this in `CRYPTO-SPEC.md` — so the cache is no more readable at rest
 * than the archive itself. Three consequences follow:
 *
 *  - A cache entry written by another account simply fails to decrypt and is
 *    discarded, so nothing leaks between vaults sharing a browser.
 *  - The conversation identifier and manifest version are bound into the
 *    encryption, so a stale entry cannot be served for a newer conversation.
 *  - Locking the vault clears it, same as the ciphertext cache.
 */
import { decryptObject, encryptObject, fromUtf8, toUtf8 } from '@chatvault/crypto';
import type { CanonicalMessage } from '@chatvault/parser';

/** Bumped if the cached shape ever changes, so old entries are ignored. */
const CACHE_FORMAT = 1;

interface CachedPayload {
  f: typeof CACHE_FORMAT;
  conversationId: string;
  manifestVersion: number;
  writtenAtMs: number;
  messages: CanonicalMessage[];
}

function objectIdFor(conversationId: string, manifestVersion: number): string {
  return `cv-cache:${conversationId}:v${String(manifestVersion)}:f${String(CACHE_FORMAT)}`;
}

export async function serializeMessages(options: {
  material: Uint8Array;
  conversationId: string;
  manifestVersion: number;
  messages: readonly CanonicalMessage[];
  nowMs?: number;
}): Promise<Uint8Array> {
  const payload: CachedPayload = {
    f: CACHE_FORMAT,
    conversationId: options.conversationId,
    manifestVersion: options.manifestVersion,
    writtenAtMs: options.nowMs ?? Date.now(),
    messages: [...options.messages],
  };
  const { bytes } = await encryptObject({
    material: options.material,
    objectId: objectIdFor(options.conversationId, options.manifestVersion),
    kind: 'index',
    data: toUtf8(JSON.stringify(payload)),
  });
  return bytes;
}

/**
 * Read a cache entry back. Throws if it was written by a different key, for a
 * different conversation, or for a different manifest version — all of which
 * the caller should treat as a miss.
 */
export async function deserializeMessages(options: {
  material: Uint8Array;
  conversationId: string;
  manifestVersion: number;
  bytes: Uint8Array;
}): Promise<CanonicalMessage[]> {
  const plaintext = await decryptObject({
    material: options.material,
    bytes: options.bytes,
    expectedObjectId: objectIdFor(options.conversationId, options.manifestVersion),
  });
  const payload = JSON.parse(fromUtf8(plaintext)) as CachedPayload;
  if (
    payload.f !== CACHE_FORMAT ||
    payload.conversationId !== options.conversationId ||
    payload.manifestVersion !== options.manifestVersion ||
    !Array.isArray(payload.messages)
  ) {
    throw new Error('That cache entry is for something else.');
  }
  return payload.messages;
}

/* ----------------------------------------------------------------- storage */

export interface CacheStorage {
  readonly kind: 'indexeddb' | 'memory';
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryStorage(): CacheStorage {
  const entries = new Map<string, Uint8Array>();
  return {
    kind: 'memory',
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async remove(key) {
      entries.delete(key);
    },
    async clear() {
      entries.clear();
    },
  };
}

const DB_NAME = 'chatvault-conversations';
const STORE = 'messages';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

/** Falls back to memory where IndexedDB is unavailable or refused. */
export function createBrowserStorage(): CacheStorage {
  if (typeof indexedDB === 'undefined') return createMemoryStorage();
  const fallback = createMemoryStorage();
  let databasePromise: Promise<IDBDatabase> | null = null;
  let broken = false;

  const database = async (): Promise<IDBDatabase | null> => {
    if (broken) return null;
    databasePromise ??= openDatabase();
    try {
      return await databasePromise;
    } catch {
      broken = true;
      return null;
    }
  };

  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest,
    onResult: (value: unknown) => T,
    onUnavailable: () => Promise<T>,
  ): Promise<T> => {
    const db = await database();
    if (!db) return onUnavailable();
    return new Promise<T>((resolve) => {
      try {
        const transaction = db.transaction(STORE, mode);
        const request = action(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(onResult(request.result));
        request.onerror = () => void onUnavailable().then(resolve);
        transaction.onabort = () => void onUnavailable().then(resolve);
      } catch {
        void onUnavailable().then(resolve);
      }
    });
  };

  return {
    kind: 'indexeddb',
    async get(key) {
      return run(
        'readonly',
        (store) => store.get(key),
        (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : null),
        () => fallback.get(key),
      );
    },
    async put(key, value) {
      // Copy into a fresh buffer: structured clone needs a plain ArrayBuffer.
      const copy = value.slice().buffer;
      await run(
        'readwrite',
        (store) => store.put(copy, key),
        () => undefined,
        () => fallback.put(key, value),
      );
    },
    async remove(key) {
      await run(
        'readwrite',
        (store) => store.delete(key),
        () => undefined,
        () => fallback.remove(key),
      );
    },
    async clear() {
      await fallback.clear();
      await run(
        'readwrite',
        (store) => store.clear(),
        () => undefined,
        async () => undefined,
      );
    },
  };
}

export interface MessageCacheStats {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

export class MessageCache {
  private readonly stats: MessageCacheStats = { hits: 0, misses: 0, writes: 0, evictions: 0 };

  constructor(
    private readonly storage: CacheStorage,
    /** The vault's `index` subkey. */
    private readonly material: Uint8Array,
  ) {}

  get kind(): CacheStorage['kind'] {
    return this.storage.kind;
  }

  get counters(): Readonly<MessageCacheStats> {
    return { ...this.stats };
  }

  /** Null on any miss: absent, stale, or written under a different key. */
  async read(conversationId: string, manifestVersion: number): Promise<CanonicalMessage[] | null> {
    const bytes = await this.storage.get(conversationId);
    if (!bytes) {
      this.stats.misses += 1;
      return null;
    }
    try {
      const messages = await deserializeMessages({
        material: this.material,
        conversationId,
        manifestVersion,
        bytes,
      });
      this.stats.hits += 1;
      return messages;
    } catch {
      // Stale, or from another vault. Drop it rather than keep paying for it.
      await this.storage.remove(conversationId);
      this.stats.evictions += 1;
      this.stats.misses += 1;
      return null;
    }
  }

  async write(
    conversationId: string,
    manifestVersion: number,
    messages: readonly CanonicalMessage[],
  ): Promise<void> {
    const bytes = await serializeMessages({
      material: this.material,
      conversationId,
      manifestVersion,
      messages,
    });
    await this.storage.put(conversationId, bytes);
    this.stats.writes += 1;
  }

  async clear(): Promise<void> {
    await this.storage.clear();
  }
}

export function createMessageCache(material: Uint8Array): MessageCache {
  return new MessageCache(createBrowserStorage(), material);
}
