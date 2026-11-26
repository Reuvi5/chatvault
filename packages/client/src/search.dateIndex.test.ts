import { describe, expect, it } from 'vitest';
import type { CanonicalMessage } from '@chatvault/parser';
import { dateIndex } from './search';

function at(localTs: string, seq: number): CanonicalMessage {
  return {
    seq,
    kind: 'message',
    localTs,
    tsPrecision: 'minute',
    sender: 'Dana',
    body: 'hi',
    attachmentFileName: null,
    flags: {},
  };
}

describe('dateIndex', () => {
  it('lists each date once, at its first message, even when out of order', () => {
    const index = dateIndex([
      at('2026-06-06T09:00:00', 0),
      at('2026-06-07T09:00:00', 1),
      at('2026-06-06T23:00:00', 2),
      at('2026-06-08T09:00:00', 3),
    ]);
    expect(index).toEqual([
      { date: '2026-06-06', index: 0 },
      { date: '2026-06-07', index: 1 },
      { date: '2026-06-08', index: 3 },
    ]);
  });
});
