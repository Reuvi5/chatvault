import { describe, expect, it } from 'vitest';
import { TaskPool, mapWithConcurrency } from './pool';

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TaskPool', () => {
  it('never exceeds its size, and does run concurrently', async () => {
    const pool = new TaskPool(3);
    let active = 0;
    let peak = 0;

    for (let i = 0; i < 20; i += 1) {
      await pool.submit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(5);
        active -= 1;
      });
    }
    await pool.drain();

    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it('is faster than running the same work in sequence', async () => {
    const work = Array.from({ length: 12 }, (_, i) => i);

    const startSequential = Date.now();
    for (const _ of work) await tick(10);
    const sequential = Date.now() - startSequential;

    const startPooled = Date.now();
    await mapWithConcurrency(work, 4, async () => {
      await tick(10);
    });
    const pooled = Date.now() - startPooled;

    expect(pooled).toBeLessThan(sequential);
  });

  it('surfaces the first failure from drain and stops accepting work', async () => {
    const pool = new TaskPool(2);
    let completed = 0;

    await pool.submit(async () => {
      await tick(2);
      throw new Error('upload part 3 failed');
    });
    await pool.submit(async () => {
      await tick(10);
      completed += 1;
    });

    await expect(pool.drain()).rejects.toThrow(/upload part 3 failed/);
    // Work already in flight is allowed to settle rather than being orphaned.
    expect(completed).toBe(1);
    expect(pool.failed).toBe(true);
    await expect(pool.submit(async () => {})).rejects.toThrow(/upload part 3 failed/);
  });

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController();
    const pool = new TaskPool(1, controller.signal);
    await pool.submit(async () => {
      await tick(5);
    });
    controller.abort();
    await expect(pool.submit(async () => {})).rejects.toThrow(/cancelled/i);
  });

  it('refuses a nonsensical size', () => {
    expect(() => new TaskPool(0)).toThrow();
    expect(() => new TaskPool(1.5)).toThrow();
  });
});

describe('mapWithConcurrency', () => {
  it('keeps results in input order however they finish', async () => {
    const delays = [30, 1, 20, 2, 10];
    const result = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await tick(ms);
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('rejects with the first error', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('nope');
        await tick(1);
        return value;
      }),
    ).rejects.toThrow(/nope/);
  });
});
