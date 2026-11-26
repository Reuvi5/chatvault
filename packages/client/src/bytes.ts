/** Small byte-stream helpers shared by the importer and the reader. */

export function concatBytes(parts: readonly Uint8Array[], total?: number): Uint8Array {
  const size = total ?? parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A queue that hands out exactly-sized blocks, for fixed-size upload parts. */
export class PartBuffer {
  private chunks: Uint8Array[] = [];
  private total = 0;

  get size(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.byteLength;
  }

  take(n: number): Uint8Array {
    const want = Math.min(n, this.total);
    const out = new Uint8Array(want);
    let filled = 0;
    while (filled < want) {
      const head = this.chunks[0];
      if (!head) break;
      const need = want - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled = want;
      }
    }
    this.total -= want;
    return out;
  }
}

export async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function collectStream(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  return concatBytes(parts, total);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown) => void;
  /**
   * Which failures are worth retrying. Defaults to anything not permanent.
   * Operations that are not safe to repeat blindly — ones that reserve quota
   * or create a record — pass `isRateLimit`, because a rejected request is one
   * the server refused before it did anything.
   */
  retryWhen?: (error: unknown) => boolean;
}

/** A rejection the server asked us to wait out, and nothing else. */
export function isRateLimit(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 429;
}

/**
 * How long to wait before trying again.
 *
 * When the server tells us (a 429 carries Retry-After), believe it. Guessing
 * short here is not a harmless optimisation: a rate-limit window runs for a
 * fixed time, so a client that retries four times in three seconds exhausts
 * its attempts inside a window it had no chance of outlasting, and an import
 * that merely needed to slow down fails outright instead.
 */
function delayBeforeRetry(error: unknown, attempt: number, baseMs: number): number {
  const asked = (error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
  if (typeof asked === 'number' && Number.isFinite(asked)) {
    // A little past the window, with jitter, so a burst of parallel uploads
    // does not all return at the same instant and trip it again.
    return asked * 1000 + 250 + Math.random() * 750;
  }
  return baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
}

/** True for failures that waiting cannot fix, so there is no point retrying. */
function isPermanent(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status !== 'number') return false;
  // 408 and 429 are worth waiting out; the rest of 4xx will not change.
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Retry with backoff. Every retried operation here is idempotent. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 400;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Retrying a rejected passphrase or a missing object just wastes time.
      const worthRetrying = options.retryWhen ?? ((candidate: unknown) => !isPermanent(candidate));
      if (attempt === attempts || !worthRetrying(error)) break;
      options.onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, delayBeforeRetry(error, attempt, base)));
    }
  }
  throw lastError;
}
