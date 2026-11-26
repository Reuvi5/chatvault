import { describe, expect, it } from 'vitest';
import type { CanonicalMessage } from '@chatvault/parser';
import {
  formatDayHeading,
  groupConversation,
  initialsOf,
  participantLine,
  senderStyle,
} from './conversationLayout';

let sequence = 0;
function message(
  localTs: string,
  sender: string | null,
  body = 'hello',
  kind: CanonicalMessage['kind'] = sender === null ? 'system' : 'message',
): CanonicalMessage {
  return {
    seq: sequence++,
    kind,
    localTs,
    tsPrecision: 'second',
    sender,
    body,
    attachmentFileName: null,
    flags: {},
  };
}

describe('sender colours', () => {
  it('are stable for the same name', () => {
    expect(senderStyle('Dana Okonkwo')).toEqual(senderStyle('Dana Okonkwo'));
    expect(senderStyle(' Dana Okonkwo ').hue).toBe(senderStyle('Dana Okonkwo').hue);
  });

  it('differ between people, across a realistic group', () => {
    const names = ['Dana Okonkwo', 'Sam Reyes', 'Priya Raman', 'Tomás Oliveira', 'Mommy', 'Daddy'];
    const hues = names.map((name) => senderStyle(name).hue);
    // Not a guarantee of uniqueness, but a collision across six names would
    // mean the spread is bad.
    expect(new Set(hues).size).toBeGreaterThanOrEqual(5);
  });

  it('builds initials from the first and last word', () => {
    expect(initialsOf('Dana Okonkwo')).toBe('DO');
    expect(initialsOf('Mommy')).toBe('M');
    expect(initialsOf('Tomás Oliveira')).toBe('TO');
    expect(initialsOf('דנה כהן')).toBe('דכ');
    expect(initialsOf('  ')).toBe('?');
    expect(initialsOf('+1 555 0100')).toBe('10');
  });
});

describe('grouping messages into runs', () => {
  it('keeps consecutive messages from one person together', () => {
    const days = groupConversation([
      message('2026-03-07T09:00:00', 'Dana'),
      message('2026-03-07T09:01:00', 'Dana'),
      message('2026-03-07T09:02:00', 'Sam'),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]?.runs.map((run) => run.sender)).toEqual(['Dana', 'Sam']);
    expect(days[0]?.runs[0]?.messages).toHaveLength(2);
  });

  it('starts a new run after a long pause, even from the same person', () => {
    const days = groupConversation(
      [message('2026-03-07T09:00:00', 'Dana'), message('2026-03-07T11:30:00', 'Dana')],
      { gapMinutes: 15 },
    );
    expect(days[0]?.runs).toHaveLength(2);
  });

  it('splits on the date, not only on the sender', () => {
    const days = groupConversation([
      message('2026-03-07T23:59:00', 'Dana'),
      message('2026-03-08T00:01:00', 'Dana'),
    ]);
    expect(days.map((day) => day.date)).toEqual(['2026-03-07', '2026-03-08']);
    expect(days[0]?.runs).toHaveLength(1);
    expect(days[1]?.runs).toHaveLength(1);
  });

  it('gives every day a unique key when a date recurs out of order', () => {
    const days = groupConversation([
      message('2026-06-06T09:00:00', 'Dana'),
      message('2026-06-07T09:00:00', 'Dana'),
      message('2026-06-06T23:00:00', 'Sam'),
    ]);
    expect(days.map((day) => day.date)).toEqual(['2026-06-06', '2026-06-07', '2026-06-06']);
    expect(new Set(days.map((day) => day.key)).size).toBe(days.length);
    expect(days.map((day) => day.firstIndex)).toEqual([0, 1, 2]);
  });

  it('never folds a system notice into somebody else run', () => {
    const days = groupConversation([
      message('2026-03-07T09:00:00', 'Dana'),
      message('2026-03-07T09:00:30', null, 'Dana added Sam'),
      message('2026-03-07T09:01:00', 'Dana'),
    ]);
    const runs = days[0]?.runs ?? [];
    expect(runs).toHaveLength(3);
    expect(runs[1]?.sender).toBeNull();
    expect(runs[1]?.messages[0]?.message.kind).toBe('system');
  });

  it('puts the reader own messages on the other side', () => {
    const days = groupConversation(
      [message('2026-03-07T09:00:00', 'Dana'), message('2026-03-07T09:00:30', 'Sam')],
      { selfName: 'Sam' },
    );
    expect(days[0]?.runs.map((run) => run.mine)).toEqual([false, true]);
  });

  it('does not merge two people even when they share a minute', () => {
    const days = groupConversation(
      [message('2026-03-07T09:00:00', 'Dana'), message('2026-03-07T09:00:00', 'Sam')],
      { selfName: null },
    );
    expect(days[0]?.runs).toHaveLength(2);
  });

  it('keeps every message, and keeps their indexes', () => {
    const input = Array.from({ length: 40 }, (_, index) =>
      message(
        `2026-03-0${String((index % 3) + 1)}T09:${String(index % 60).padStart(2, '0')}:00`,
        index % 2 ? 'Dana' : 'Sam',
      ),
    );
    const days = groupConversation(input);
    const flattened = days.flatMap((day) => day.runs.flatMap((run) => run.messages));
    expect(flattened).toHaveLength(input.length);
    expect(flattened.map((item) => item.index)).toEqual(input.map((_, index) => index));
    expect(days.reduce((sum, day) => sum + day.messageCount, 0)).toBe(input.length);
  });

  it('handles an empty conversation', () => {
    expect(groupConversation([])).toEqual([]);
  });
});

describe('day headings', () => {
  const today = new Date('2026-03-10T12:00:00Z');

  it('says today and yesterday', () => {
    expect(formatDayHeading('2026-03-10', today)).toBe('Today');
    expect(formatDayHeading('2026-03-09', today)).toBe('Yesterday');
  });

  it('names the weekday within the last week, and the date beyond it', () => {
    expect(formatDayHeading('2026-03-06', today)).toMatch(/day/i);
    expect(formatDayHeading('2025-11-17', today)).toMatch(/2025/);
  });

  it('passes through something unparseable rather than inventing a date', () => {
    expect(formatDayHeading('not-a-date', today)).toBe('not-a-date');
  });
});

describe('the participant line', () => {
  it('lists the others and puts the reader last', () => {
    expect(participantLine(['Daddy', 'Mommy', 'Reuvi'], 'Reuvi')).toBe('Daddy, Mommy, You');
  });

  it('truncates a large group', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    expect(participantLine(names, 'A', 3)).toBe('B, C, D, +3, You');
  });

  it('omits the reader when nobody has been marked as them', () => {
    expect(participantLine(['Daddy', 'Mommy'], null)).toBe('Daddy, Mommy');
  });
});
