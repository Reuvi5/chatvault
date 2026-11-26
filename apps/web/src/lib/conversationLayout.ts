/**
 * How a conversation is laid out: who each message belongs to, and which
 * messages belong together.
 *
 * Pure functions, so the rules that decide what the reader sees — when a name
 * is repeated, when an avatar appears, which colour a participant gets — are
 * testable without rendering anything.
 */
import type { CanonicalMessage } from '@chatvault/parser';

/* ------------------------------------------------------------ sender colour */

/**
 * Twelve hues that stay legible on both the light and the dark surface.
 * Picked by hand rather than generated, so no two neighbours collide.
 */
const SENDER_HUES = [210, 262, 340, 16, 35, 86, 160, 190, 240, 300, 0, 130] as const;

export interface SenderStyle {
  /** 0-360, used for the name and the avatar. */
  hue: number;
  /** One or two letters, from the first and last word of the name. */
  initials: string;
}

/**
 * Deterministic: the same participant keeps the same colour across sessions,
 * across devices, and in every conversation they appear in — which is what
 * makes a group chat scannable.
 */
export function senderStyle(name: string): SenderStyle {
  const trimmed = name.trim();
  let hash = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
  }
  const hue = SENDER_HUES[hash % SENDER_HUES.length] as number;
  return { hue, initials: initialsOf(trimmed) };
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...(words[0] as string)][0] ?? '?';
  if (words.length === 1) return first.toUpperCase();
  const last = [...(words[words.length - 1] as string)][0] ?? '';
  return `${first}${last}`.toUpperCase();
}

/* ---------------------------------------------------------------- grouping */

export interface PositionedMessage {
  message: CanonicalMessage;
  /** Index into the full message list; used for deep links. */
  index: number;
}

export interface MessageRun {
  /** Sender name, or null for a run of system notices. */
  sender: string | null;
  /** True when this run belongs to the person reading. */
  mine: boolean;
  messages: PositionedMessage[];
}

export interface ConversationDay {
  date: string;
  /**
   * Position of this day's first message, and a unique React key. A date is
   * not unique on its own: messages are kept in archive order, and a message
   * stamped out of order (a phone clock change, a merged import) starts a
   * second group for a date that already appeared.
   */
  firstIndex: number;
  key: string;
  runs: MessageRun[];
  messageCount: number;
}

export interface GroupingOptions {
  /** Who the reader is, so their own messages sit on the other side. */
  selfName?: string | null;
  /**
   * A pause longer than this starts a new run even from the same person, so a
   * reply hours later is not glued to the message above it.
   */
  gapMinutes?: number;
}

function minutesBetween(a: string, b: string): number {
  const left = Date.parse(`${a}Z`);
  const right = Date.parse(`${b}Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(right - left) / 60_000;
}

/**
 * Group messages into days, and each day into runs by the same sender.
 *
 * System notices always stand alone: they are not from anybody, and sweeping
 * them into a neighbour's run would attribute them to that person.
 */
export function groupConversation(
  messages: readonly CanonicalMessage[],
  options: GroupingOptions = {},
): ConversationDay[] {
  const gapMinutes = options.gapMinutes ?? 15;
  const selfName = options.selfName ?? null;
  const days: ConversationDay[] = [];

  let day: ConversationDay | null = null;
  let run: MessageRun | null = null;
  let previous: CanonicalMessage | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as CanonicalMessage;
    const date = message.localTs.slice(0, 10);

    if (!day || day.date !== date) {
      day = { date, firstIndex: index, key: `${date}:${String(index)}`, runs: [], messageCount: 0 };
      days.push(day);
      run = null;
      previous = null;
    }

    const isSystem = message.kind === 'system';
    const mine = !isSystem && selfName !== null && message.sender === selfName;

    const continues =
      run !== null &&
      !isSystem &&
      run.sender !== null &&
      run.sender === message.sender &&
      run.mine === mine &&
      previous !== null &&
      minutesBetween(previous.localTs, message.localTs) <= gapMinutes;

    if (!continues) {
      run = { sender: isSystem ? null : message.sender, mine, messages: [] };
      day.runs.push(run);
    }

    (run as MessageRun).messages.push({ message, index });
    day.messageCount += 1;
    previous = message;
  }

  return days;
}

/** Day boundaries, for "jump to date" and for the window that gets mounted. */
export function dayIndex(days: readonly ConversationDay[]): string[] {
  return days.map((day) => day.date);
}

/* ------------------------------------------------------------- formatting */

export function formatDayHeading(date: string, today = new Date()): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;

  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((startOfToday - parsed.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';

  return parsed.toLocaleDateString(undefined, {
    weekday: days < 7 ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: parsed.getUTCFullYear() === today.getUTCFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

export function formatClock(localTs: string, precision: 'minute' | 'second'): string {
  return precision === 'second' ? localTs.slice(11, 19) : localTs.slice(11, 16);
}

/** "Daddy, Mommy, You" — the line under a group's name. */
export function participantLine(
  participants: readonly string[],
  selfName: string | null,
  limit = 4,
): string {
  const others = participants.filter((name) => name !== selfName);
  const shown = others.slice(0, limit);
  const extra = others.length - shown.length;
  const parts = [...shown];
  if (extra > 0) parts.push(`+${String(extra)}`);
  if (selfName !== null) parts.push('You');
  return parts.join(', ');
}
