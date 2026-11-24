/**
 * A bounded concurrency pool.
 *
 * Imports used to upload one object at a time, which is the wrong shape for the
 * common case: a conversation with hundreds of photos and voice notes spends
 * almost all of its time waiting on round trips rather than on encryption. A
 * handful of uploads in flight turns that wait into one wait.
 *
 * The bound matters as much as the concurrency. Each slot holds one object's
 * bytes in memory, so `size` multiplied by the caller's own size threshold is
 * the memory this costs — which is why the importer only pools objects it has
 * already decided are small, and streams the large ones one at a time.
 */

export class TaskPool {
  private active = 0;
  private waiting: Array<() => void> = [];
  private running = new Set<Promise<void>>();
  private failure: unknown = null;

  constructor(
    private readonly size: number,
    private readonly signal?: AbortSignal,
  ) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error('Pool size must be a positive integer');
  }

  /** True once a task has failed; callers should stop submitting. */
  get failed(): boolean {
    return this.failure !== null;
  }

  /** Re-raise the first failure, keeping the original error where there is one. */
  private raise(): never {
    throw this.failure instanceof Error
      ? this.failure
      : new Error(`A pooled task failed: ${String(this.failure)}`);
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  /**
   * Start `task`, waiting first if every slot is busy.
   *
   * Resolves when the task has *started*, not when it finishes — that is what
   * makes the caller's loop keep feeding the pool. Use `drain` to wait for
   * completion and to see any error.
   */
  async submit(task: () => Promise<void>): Promise<void> {
    if (this.failure !== null) this.raise();
    if (this.signal?.aborted) throw new Error('Cancelled');

    if (this.active >= this.size) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      if (this.failure !== null) this.raise();
      if (this.signal?.aborted) throw new Error('Cancelled');
    }

    this.active += 1;
    const promise = (async () => {
      try {
        await task();
      } catch (error) {
        this.failure ??= error;
      } finally {
        this.release();
      }
    })();
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise));
  }

  /** Wait for everything in flight and rethrow the first failure. */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
    // Wake anything still queued so it can observe the failure and stop.
    for (const resume of this.waiting.splice(0)) resume();
    if (this.failure !== null) this.raise();
  }
}

/**
 * Run tasks over a list with a bounded number in flight, preserving the order
 * of results. Rejects with the first error, after letting in-flight work settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const pool = new TaskPool(concurrency);
  for (const [index, item] of items.entries()) {
    if (pool.failed) break;
    await pool.submit(async () => {
      results[index] = await task(item, index);
    });
  }
  await pool.drain();
  return results;
}
