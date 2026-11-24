/**
 * Conversation insights.
 *
 * A few light statistics about a conversation — who talks most, when the chat
 * is busiest, the longest run of consecutive days with messages, the favourite
 * emoji. Everything is computed here, on the device, from already-decrypted
 * messages: nothing about the content or its shape is sent anywhere.
 *
 * Times are the export's wall-clock times (`localTs`), so "busiest hour" means
 * the hour as the phone displayed it, which is what a reader expects.
 */
import type { CanonicalMessage } from '@chatvault/parser';

export interface ParticipantShare {
  name: string;
  messages: number;
  /** Fraction of all non-system messages, 0..1. */
  share: number;
  /** Characters written in text bodies (deleted and media placeholders excluded). */
  characters: number;
  attachments: number;
}

export interface ConversationInsights {
  /** Non-system messages counted. */
  totalMessages: number;
  /** Distinct calendar days with at least one message. */
  activeDays: number;
  participants: ParticipantShare[];
  /** Message counts per hour of day, index 0..23. */
  byHour: number[];
  /** Message counts per weekday, index 0 = Monday .. 6 = Sunday. */
  byWeekday: number[];
  busiestHour: number | null;
  busiestWeekday: number | null;
  busiestDay: { date: string; messages: number } | null;
  longestStreak: { days: number; start: string; end: string } | null;
  topEmoji: Array<{ emoji: string; count: number }>;
}

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/* Pictographic emoji, optionally joined with ZWJ / modifiers / variation selectors.
   Keycaps and bare digits are deliberately not counted. */
const EMOJI_PATTERN =
  /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*/gu;

function weekdayOf(date: string): number | null {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  return (parsed.getUTCDay() + 6) % 7;
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function indexOfMax(values: readonly number[]): number | null {
  let best = -1;
  let bestValue = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    if (value > bestValue) {
      best = index;
      bestValue = value;
    }
  }
  return best === -1 ? null : best;
}

export function computeInsights(
  messages: readonly CanonicalMessage[],
  options: { topEmoji?: number } = {},
): ConversationInsights {
  const byHour = Array.from({ length: 24 }, () => 0);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  const perSender = new Map<string, Omit<ParticipantShare, 'share'>>();
  const perDay = new Map<string, number>();
  const emoji = new Map<string, number>();
  let total = 0;

  for (const message of messages) {
    if (message.kind === 'system' || message.sender === null) continue;
    total += 1;

    const date = message.localTs.slice(0, 10);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);

    const hour = Number(message.localTs.slice(11, 13));
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
      byHour[hour] = (byHour[hour] as number) + 1;
    }
    const weekday = weekdayOf(date);
    if (weekday !== null) byWeekday[weekday] = (byWeekday[weekday] as number) + 1;

    let sender = perSender.get(message.sender);
    if (!sender) {
      sender = { name: message.sender, messages: 0, characters: 0, attachments: 0 };
      perSender.set(message.sender, sender);
    }
    sender.messages += 1;
    if (message.attachmentFileName) sender.attachments += 1;

    const hasText = message.body && !message.flags.deleted && !message.flags.mediaOmitted;
    if (hasText) {
      sender.characters += message.body.length;
      for (const match of message.body.matchAll(EMOJI_PATTERN)) {
        emoji.set(match[0], (emoji.get(match[0]) ?? 0) + 1);
      }
    }
  }

  const participants = [...perSender.values()]
    .map((entry) => ({ ...entry, share: total === 0 ? 0 : entry.messages / total }))
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));

  let busiestDay: ConversationInsights['busiestDay'] = null;
  for (const [date, count] of perDay) {
    if (!busiestDay || count > busiestDay.messages) busiestDay = { date, messages: count };
  }

  let longestStreak: ConversationInsights['longestStreak'] = null;
  const dates = [...perDay.keys()].sort();
  let runStart = dates[0];
  let previous = dates[0];
  for (let index = 1; index <= dates.length; index += 1) {
    const date = dates[index];
    if (date !== undefined && previous !== undefined && date === nextDate(previous)) {
      previous = date;
      continue;
    }
    if (runStart !== undefined && previous !== undefined) {
      const days =
        Math.round(
          (Date.parse(`${previous}T00:00:00Z`) - Date.parse(`${runStart}T00:00:00Z`)) / 86_400_000,
        ) + 1;
      if (!longestStreak || days > longestStreak.days) {
        longestStreak = { days, start: runStart, end: previous };
      }
    }
    runStart = date;
    previous = date;
  }

  const topEmoji = [...emoji.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, options.topEmoji ?? 5)
    .map(([value, count]) => ({ emoji: value, count }));

  return {
    totalMessages: total,
    activeDays: perDay.size,
    participants,
    byHour,
    byWeekday,
    busiestHour: indexOfMax(byHour),
    busiestWeekday: indexOfMax(byWeekday),
    busiestDay,
    longestStreak,
    topEmoji,
  };
}
