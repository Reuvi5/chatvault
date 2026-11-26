/**
 * How the client behaves when the server pushes back.
 *
 * These exist because of a real failure: a long import died with "too many
 * requests" even though nothing was wrong with it. The server refused a burst,
 * the client treated the refusal as a flaky network, retried four times inside
 * three seconds against a window that had another fifty-seven to run, and gave
 * up. The import was never too large — the client was simply unwilling to wait.
 */
import { describe, expect, it, vi } from 'vitest';
import { isRateLimit, withRetry } from './bytes';

class FakeError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`status ${String(status)}`);
  }
}

/** Fails the first `failures` calls, then succeeds. */
function flaky(failures: number, error: () => Error) {
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls <= failures) throw error();
    return 'done';
  };
  return { operation, calls: () => calls };
}

describe('waiting as long as the server asked', () => {
  it('waits at least the time a 429 named, not its own guess', async () => {
    const { operation } = flaky(1, () => new FakeError(429, 0.2));
    const started = Date.now();
    await expect(withRetry(operation, { baseDelayMs: 1 })).resolves.toBe('done');
    // The client's own guess would have been ~1ms. The server said 200ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('keeps going for as many windows as it takes', async () => {
    const { operation, calls } = flaky(4, () => new FakeError(429, 0.01));
    await expect(withRetry(operation, { attempts: 6, baseDelayMs: 1 })).resolves.toBe('done');
    expect(calls()).toBe(5);
  });

  it('falls back to exponential backoff when the server says nothing', async () => {
    const { operation, calls } = flaky(2, () => new FakeError(429));
    await expect(withRetry(operation, { baseDelayMs: 1 })).resolves.toBe('done');
    expect(calls()).toBe(3);
  });
});

describe('not retrying what waiting cannot fix', () => {
  it('gives up at once on a refusal that will never change', async () => {
    for (const status of [400, 401, 403, 404, 409, 413]) {
      const { operation, calls } = flaky(10, () => new FakeError(status));
      await expect(withRetry(operation, { baseDelayMs: 1 })).rejects.toThrow();
      expect(calls(), `status ${String(status)} should not be retried`).toBe(1);
    }
  });

  it('does retry a timeout and a rate limit', async () => {
    for (const status of [408, 429]) {
      const { operation, calls } = flaky(1, () => new FakeError(status, 0.001));
      await expect(withRetry(operation, { baseDelayMs: 1 })).resolves.toBe('done');
      expect(calls(), `status ${String(status)} should be retried`).toBe(2);
    }
  });

  it('still retries a network failure, which carries no status', async () => {
    const { operation, calls } = flaky(1, () => new Error('network down'));
    await expect(withRetry(operation, { baseDelayMs: 1 })).resolves.toBe('done');
    expect(calls()).toBe(2);
  });
});

describe('operations that are not safe to repeat blindly', () => {
  it('can be told to retry only a rate limit', async () => {
    // Authorising an upload reserves quota, so it may only be repeated when
    // the server refused it before doing any work.
    const { operation: refused, calls: refusedCalls } = flaky(1, () => new FakeError(429, 0.001));
    await expect(withRetry(refused, { baseDelayMs: 1, retryWhen: isRateLimit })).resolves.toBe(
      'done',
    );
    expect(refusedCalls()).toBe(2);

    const { operation: broke, calls: brokeCalls } = flaky(1, () => new Error('socket hang up'));
    await expect(withRetry(broke, { baseDelayMs: 1, retryWhen: isRateLimit })).rejects.toThrow(
      'socket hang up',
    );
    expect(brokeCalls()).toBe(1);
  });

  it('recognises a rate limit by status alone', () => {
    expect(isRateLimit(new FakeError(429))).toBe(true);
    expect(isRateLimit(new FakeError(500))).toBe(false);
    expect(isRateLimit(new Error('nope'))).toBe(false);
    expect(isRateLimit(null)).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
  });
});

describe('cancelling', () => {
  it('stops between attempts when the import is cancelled', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new FakeError(429, 0.001);
    });
    await expect(
      withRetry(operation, { baseDelayMs: 1, signal: controller.signal }),
    ).rejects.toThrow('Cancelled');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
