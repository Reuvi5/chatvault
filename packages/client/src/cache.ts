/**
 * Ciphertext cache.
 *
 * Only *encrypted* object bytes are cached, never plaintext, so a cache that
 * outlives the session leaks nothing. Clearing it is part of locking the vault.
 */

export interface CiphertextCache {
  get(objectId: string): Promise<Uint8Array | null>;
  put(objectId: string, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
  readonly kind: 'memory' | 'indexeddb' | 'none';
}

export function createNullCache(): CiphertextCache {
  return {
    kind: 'none',
    async get() {
      return null;
    },
    async put() {},
    async clear() {},
  };
}

/** Least-recently-used, bounded by total bytes. */
export function createMemoryCache(limitBytes = 128 * 1024 * 1024): CiphertextCache {
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  return {
    kind: 'memory',
    async get(objectId) {
      const found = entries.get(objectId);
      if (!found) return null;
      entries.delete(objectId);
      entries.set(objectId, found);
      return found;
    },
    async put(objectId, bytes) {
      if (bytes.byteLength > limitBytes) return;
      const existing = entries.get(objectId);
      if (existing) total -= existing.byteLength;
      entries.set(objectId, bytes);
      total += bytes.byteLength;
      while (total > limitBytes) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        const victim = entries.get(oldest.value);
        entries.delete(oldest.value);
        total -= victim?.byteLength ?? 0;
      }
    },
    async clear() {
      entries.clear();
      total = 0;
    },
  };
}

const DB_NAME = 'chatvault-ciphertext';
const STORE = 'objects';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

/**
 * Browser cache. Falls back to memory when storage is unavailable or denied,
 * which happens in private windows and when a quota is exhausted.
 */
export function createBrowserCache(limitBytes = 512 * 1024 * 1024): CiphertextCache {
  if (typeof indexedDB === 'undefined') return createMemoryCache(limitBytes);
  const fallback = createMemoryCache(limitBytes);
  let dbPromise: Promise<IDBDatabase> | null = null;
  let broken = false;

  const db = async () => {
    if (broken) return null;
    dbPromise ??= openDatabase();
    try {
      return await dbPromise;
    } catch {
      broken = true;
      return null;
    }
  };

  return {
    kind: 'indexeddb',
    async get(objectId) {
      const database = await db();
      if (!database) return fallback.get(objectId);
      return new Promise((resolve) => {
        const tx = database.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(objectId);
        request.onsuccess = () => {
          const value = request.result as ArrayBuffer | undefined;
          resolve(value ? new Uint8Array(value) : null);
        };
        request.onerror = () => resolve(null);
      });
    },
    async put(objectId, bytes) {
      const database = await db();
      if (!database) return fallback.put(objectId, bytes);
      await new Promise<void>((resolve) => {
        try {
          const tx = database.transaction(STORE, 'readwrite');
          const copy = bytes.slice().buffer;
          tx.objectStore(STORE).put(copy, objectId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },
    async clear() {
      await fallback.clear();
      const database = await db();
      if (!database) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = database.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}

export function createDefaultCache(): CiphertextCache {
  return typeof indexedDB === 'undefined' ? createMemoryCache() : createBrowserCache();
}
