import { describe, expect, it } from 'vitest';
import type { CanonicalMessage } from '@chatvault/parser';
import { buildSyntheticExport, parseTranscript } from '@chatvault/parser';
import { computeInsights } from './insights';

let seq = 0;
function msg(
  localTs: string,
  sender: string | null,
  body = 'hi',
  extra: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  seq += 1;
  return {
    seq,
    kind: sender === null ? 'system' : 'message',
    localTs,
    tsPrecision: 'minute',
    sender,
    body,
    attachmentFileName: null,
    flags: {},
    ...extra,
  };
}

describe('computeInsights', () => {
  it('handles an empty conversation', () => {
    const insights = computeInsights([]);
    expect(insights.totalMessages).toBe(0);
    expect(insights.participants).toEqual([]);
    expect(insights.busiestHour).toBeNull();
    expect(insights.busiestWeekday).toBeNull();
    expect(insights.busiestDay).toBeNull();
    expect(insights.longestStreak).toBeNull();
    expect(insights.topEmoji).toEqual([]);
  });

  it('counts per participant and ignores system notices', () => {
    const insights = computeInsights([
      msg('2024-03-04T09:00:00', null, 'Messages are end-to-end encrypted.'),
      msg('2024-03-04T09:01:00', 'Ana', 'hello'),
      msg('2024-03-04T09:02:00', 'Ben', 'hey there'),
      msg('2024-03-04T09:03:00', 'Ana', 'photo', { attachmentFileName: 'IMG-1.jpg' }),
      msg('2024-03-04T09:04:00', 'Ana', 'gone', { flags: { deleted: true } }),
    ]);
    expect(insights.totalMessages).toBe(4);
    expect(insights.participants.map((p) => [p.name, p.messages])).toEqual([
      ['Ana', 3],
      ['Ben', 1],
    ]);
    const ana = insights.participants[0];
    expect(ana?.share).toBeCloseTo(0.75);
    expect(ana?.attachments).toBe(1);
    expect(ana?.characters).toBe('hello'.length + 'photo'.length);
  });

  it('finds the busiest hour, weekday and day', () => {
    const insights = computeInsights([
      // 2024-03-04 is a Monday, 2024-03-06 a Wednesday.
      msg('2024-03-04T22:10:00', 'Ana'),
      msg('2024-03-06T22:15:00', 'Ben'),
      msg('2024-03-06T22:40:00', 'Ana'),
      msg('2024-03-06T08:00:00', 'Ben'),
    ]);
    expect(insights.busiestHour).toBe(22);
    expect(insights.busiestWeekday).toBe(2);
    expect(insights.busiestDay).toEqual({ date: '2024-03-06', messages: 3 });
    expect(insights.byWeekday[0]).toBe(1);
  });

  it('finds the longest run of consecutive days, across month ends', () => {
    const insights = computeInsights([
      msg('2024-01-10T10:00:00', 'Ana'),
      msg('2024-01-11T10:00:00', 'Ana'),
      msg('2024-01-30T10:00:00', 'Ben'),
      msg('2024-01-31T10:00:00', 'Ben'),
      msg('2024-02-01T10:00:00', 'Ana'),
      msg('2024-02-01T11:00:00', 'Ana'),
      msg('2024-02-05T10:00:00', 'Ana'),
    ]);
    expect(insights.activeDays).toBe(6);
    expect(insights.longestStreak).toEqual({ days: 3, start: '2024-01-30', end: '2024-02-01' });
  });

  it('ranks emoji, keeping joined sequences whole', () => {
    const insights = computeInsights([
      msg('2024-03-04T09:00:00', 'Ana', 'haha 😂😂 love it ❤️'),
      msg('2024-03-04T09:01:00', 'Ben', '😂 👍🏽 👨‍👩‍👧'),
      msg('2024-03-04T09:02:00', 'Ben', '😂', { flags: { deleted: true } }),
    ]);
    expect(insights.topEmoji[0]).toEqual({ emoji: '😂', count: 3 });
    const values = insights.topEmoji.map((entry) => entry.emoji);
    expect(values).toContain('👍🏽');
    expect(values).toContain('👨‍👩‍👧');
    expect(values).toContain('❤️');
  });

  it('agrees with the parser on a synthetic export', () => {
    const fixture = buildSyntheticExport({
      platform: 'android',
      withMedia: false,
      messageCount: 300,
      seed: 7,
    });
    const parsed = parseTranscript(fixture.transcript);
    const insights = computeInsights(parsed.messages);
    const nonSystem = parsed.messages.filter((m) => m.kind !== 'system').length;
    expect(insights.totalMessages).toBe(nonSystem);
    expect(insights.byHour.reduce((a, b) => a + b, 0)).toBe(nonSystem);
    expect(insights.participants.reduce((a, p) => a + p.messages, 0)).toBe(nonSystem);
  });
});
