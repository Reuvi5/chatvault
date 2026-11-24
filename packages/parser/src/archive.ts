/**
 * Reading an export archive safely.
 *
 * The archive is untrusted input, so this module assumes it is hostile
 * (plan §8 "ZIP archives with malformed paths, compression bombs, or corrupt
 * members", §13 "Untrusted ZIP causes resource abuse"):
 *
 *  - The archive is consumed as a stream, so a multi-gigabyte file is never
 *    held in memory.
 *  - Each member is handed to the caller as an async stream of chunks, and the
 *    caller is throttled to one source chunk at a time, so expansion is bounded.
 *  - Entry count, per-entry size, total size and the overall compression ratio
 *    are all capped; exceeding a cap aborts the whole import.
 *  - Only the base name of a member is ever used, and anything with a traversal
 *    segment, an absolute path or a control character is refused and reported.
 *  - Nothing is ever written to disk here and nothing is executed.
 */
import { Unzip, UnzipInflate } from 'fflate';
import { IMPORT_LIMITS } from '@chatvault/protocol';

export interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: IMPORT_LIMITS.maxEntries,
  maxEntryBytes: IMPORT_LIMITS.maxEntryBytes,
  maxTotalBytes: IMPORT_LIMITS.maxArchiveBytes,
  maxCompressionRatio: IMPORT_LIMITS.maxCompressionRatio,
};

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'too_many_entries'
      | 'entry_too_large'
      | 'archive_too_large'
      | 'compression_ratio'
      | 'corrupt'
      | 'aborted',
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface SkippedEntry {
  path: string;
  reason: 'directory' | 'unsafe_path' | 'metadata';
}

export interface ArchiveEntry {
  /** Base name, the only form used anywhere downstream. */
  name: string;
  /** The path exactly as stored, for diagnostics. */
  path: string;
  /** Declared uncompressed size, when the archive bothered to record one. */
  declaredSize: number | null;
  chunks: AsyncIterable<Uint8Array>;
}

export interface ArchiveReadResult {
  entryCount: number;
  totalBytes: number;
  skipped: SkippedEntry[];
}

const UNSAFE_PATH = /(?:^|[/\\])\.\.(?:[/\\]|$)|^[/\\]|^[A-Za-z]:|[\u0000-\u001f]/u;

/**
 * Everything this module rejects comes back as an `ArchiveError` with a code, so
 * a caller can tell "this archive is too big" from "this archive is corrupt"
 * without matching on message text.
 */
function toArchiveError(error: unknown): ArchiveError {
  if (error instanceof ArchiveError) return error;
  return new ArchiveError(error instanceof Error ? error.message : String(error), 'corrupt');
}

function classify(path: string): { accept: boolean; reason?: SkippedEntry['reason'] } {
  if (path.endsWith('/') || path.endsWith('\\')) return { accept: false, reason: 'directory' };
  if (UNSAFE_PATH.test(path)) return { accept: false, reason: 'unsafe_path' };
  const base = baseName(path);
  if (base === '' || base === '.DS_Store' || base.startsWith('._')) {
    return { accept: false, reason: 'metadata' };
  }
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) {
    return { accept: false, reason: 'metadata' };
  }
  return { accept: true };
}

export function baseName(path: string): string {
  const parts = path.split(/[/\\]/u);
  return parts[parts.length - 1] ?? '';
}

/** A one-producer, one-consumer queue with a "consumer has caught up" signal. */
class ChunkQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private drained: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength > 0) this.chunks.push(chunk);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
    if (this.chunks.length === 0) {
      this.drained?.();
      this.drained = null;
    }
  }

  fail(error: Error): void {
    this.failure = error;
    this.closed = true;
    this.wake?.();
    this.wake = null;
    this.drained?.();
    this.drained = null;
  }

  /** Resolves once the consumer has taken everything queued so far. */
  async waitUntilDrained(): Promise<void> {
    if (this.failure) return;
    if (this.chunks.length === 0) return;
    await new Promise<void>((resolve) => {
      this.drained = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.failure) throw this.failure;
      const next = this.chunks.shift();
      if (next) {
        if (this.chunks.length === 0) {
          this.drained?.();
          this.drained = null;
        }
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export interface ReadArchiveOptions {
  source: AsyncIterable<Uint8Array>;
  limits?: Partial<ArchiveLimits>;
  /** Called once per accepted member, sequentially, in archive order. */
  onEntry: (entry: ArchiveEntry) => Promise<void>;
  signal?: AbortSignal;
}

export async function readArchiveStream(options: ReadArchiveOptions): Promise<ArchiveReadResult> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  const skipped: SkippedEntry[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  let compressedBytes = 0;
  let fatal: Error | null = null;
  let chain: Promise<void> = Promise.resolve();
  const live: { queue: ChunkQueue | null } = { queue: null };

  const fail = (error: Error) => {
    fatal ??= error;
    live.queue?.fail(error);
  };

  unzip.onfile = (file) => {
    if (fatal) return;
    const verdict = classify(file.name);
    if (!verdict.accept) {
      if (verdict.reason && skipped.length < 200) {
        skipped.push({ path: file.name, reason: verdict.reason });
      }
      return;
    }
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      fail(
        new ArchiveError(
          `This archive has more than ${String(limits.maxEntries)} files, which is more than ChatVault will import at once.`,
          'too_many_entries',
        ),
      );
      return;
    }

    const queue = new ChunkQueue();
    live.queue = queue;
    let entryBytes = 0;

    file.ondata = (error, chunk, final) => {
      if (fatal) return;
      if (error) {
        fail(new ArchiveError(`A file inside the archive is corrupt: ${file.name}`, 'corrupt'));
        return;
      }
      if (chunk.byteLength > 0) {
        entryBytes += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (entryBytes > limits.maxEntryBytes) {
          fail(
            new ArchiveError(`${baseName(file.name)} is too large to import.`, 'entry_too_large'),
          );
          return;
        }
        if (totalBytes > limits.maxTotalBytes) {
          fail(
            new ArchiveError(
              'This archive expands to more data than ChatVault will import.',
              'archive_too_large',
            ),
          );
          return;
        }
        if (
          compressedBytes > 4096 &&
          totalBytes / Math.max(1, compressedBytes) > limits.maxCompressionRatio
        ) {
          fail(
            new ArchiveError(
              'This archive expands far more than its size suggests, so ChatVault stopped reading it.',
              'compression_ratio',
            ),
          );
          return;
        }
        // Copy: the decompressor may reuse its output buffer.
        queue.push(chunk.slice());
      }
      if (final) queue.close();
    };

    const declaredSize = typeof file.originalSize === 'number' ? file.originalSize : null;
    chain = chain.then(async () => {
      if (fatal) return;
      try {
        await options.onEntry({
          name: baseName(file.name),
          path: file.name,
          declaredSize,
          chunks: queue,
        });
        // Drain anything the consumer chose not to read, so the queue finishes.
        for await (const _ of queue) void _;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    file.start();
  };

  try {
    for await (const chunk of options.source) {
      if (options.signal?.aborted) throw new ArchiveError('Import cancelled.', 'aborted');
      if (fatal) break;
      compressedBytes += chunk.byteLength;
      unzip.push(chunk, false);
      if (live.queue) await live.queue.waitUntilDrained();
    }
    if (!fatal) unzip.push(new Uint8Array(0), true);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }

  await chain;
  if (fatal) throw toArchiveError(fatal);
  return { entryCount, totalBytes, skipped };
}

/** Collect an entry into memory, refusing anything over `maxBytes`. */
export async function collectEntry(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label = 'file',
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ArchiveError(
        `${label} is larger than ${String(maxBytes)} bytes.`,
        'entry_too_large',
      );
    }
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Turn a byte array into the single-chunk async source `readArchiveStream` wants. */
export async function* bytesSource(
  bytes: Uint8Array,
  chunkSize = 1 << 20,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

/** Convenience for small archives and tests: read every member into memory. */
export async function readArchiveEntries(
  bytes: Uint8Array,
  limits?: Partial<ArchiveLimits>,
): Promise<{ files: Map<string, Uint8Array>; skipped: SkippedEntry[] }> {
  const files = new Map<string, Uint8Array>();
  const result = await readArchiveStream({
    source: bytesSource(bytes),
    limits,
    onEntry: async (entry) => {
      files.set(
        entry.name,
        await collectEntry(
          entry.chunks,
          limits?.maxEntryBytes ?? DEFAULT_ARCHIVE_LIMITS.maxEntryBytes,
          entry.name,
        ),
      );
    },
  });
  return { files, skipped: result.skipped };
}
