'use client';

/**
 * A small "chat insights" panel: who talks most, when, and how.
 * Computed in the browser from decrypted messages; nothing leaves the device.
 */
import { useMemo } from 'react';
import { computeInsights, WEEKDAY_NAMES } from '@chatvault/client';
import type { CanonicalMessage } from '@chatvault/parser';
import { Card, Stat } from '@/components/ui';

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatHour(hour: number): string {
  const start = String(hour).padStart(2, '0');
  const end = String((hour + 1) % 24).padStart(2, '0');
  return `${start}:00–${end}:00`;
}

export function ChatInsights({ messages }: { messages: readonly CanonicalMessage[] }) {
  const insights = useMemo(() => computeInsights(messages), [messages]);

  if (insights.totalMessages === 0) {
    return (
      <Card className="mb-4 p-4">
        <p className="muted text-sm">There are no messages to summarise yet.</p>
      </Card>
    );
  }

  const peakHour = Math.max(1, ...insights.byHour);

  return (
    <Card as="section" className="mb-4 space-y-5 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Chat insights</h2>
        <p className="muted text-xs">Worked out on this device. Nothing is sent anywhere.</p>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Busiest hour"
          value={insights.busiestHour === null ? '—' : formatHour(insights.busiestHour)}
        />
        <Stat
          label="Favourite day"
          value={insights.busiestWeekday === null ? '—' : WEEKDAY_NAMES[insights.busiestWeekday]}
        />
        <Stat
          label="Longest streak"
          value={
            insights.longestStreak
              ? `${String(insights.longestStreak.days)} day${insights.longestStreak.days === 1 ? '' : 's'}`
              : '—'
          }
          hint={
            insights.longestStreak && insights.longestStreak.days > 1
              ? `${formatDate(insights.longestStreak.start)} – ${formatDate(insights.longestStreak.end)}`
              : undefined
          }
        />
        <Stat
          label="Biggest day"
          value={
            insights.busiestDay
              ? `${insights.busiestDay.messages.toLocaleString('en-US')} msgs`
              : '—'
          }
          hint={insights.busiestDay ? formatDate(insights.busiestDay.date) : undefined}
        />
      </dl>

      <div className="space-y-2">
        <h3 className="muted text-xs uppercase tracking-wide">Who talks most</h3>
        <ul className="space-y-2">
          {insights.participants.slice(0, 8).map((person) => (
            <li key={person.name} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{person.name}</span>
                <span className="muted shrink-0 text-xs tabular-nums">
                  {person.messages.toLocaleString('en-US')} · {Math.round(person.share * 100)}%
                  {person.attachments > 0 ? ` · ${String(person.attachments)} media` : ''}
                </span>
              </div>
              <div className="sunken h-2 w-full overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full bg-accent-500"
                  style={{ width: `${String(Math.max(1, person.share * 100))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
        {insights.participants.length > 8 ? (
          <p className="muted text-xs">
            and {insights.participants.length - 8} more participant
            {insights.participants.length - 8 === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <h3 className="muted text-xs uppercase tracking-wide">Time of day</h3>
        <div
          className="flex h-16 items-end gap-0.5"
          role="img"
          aria-label={`Messages by hour of day; busiest ${insights.busiestHour === null ? 'unknown' : formatHour(insights.busiestHour)}`}
        >
          {insights.byHour.map((count, hour) => (
            <div
              key={hour}
              title={`${formatHour(hour)}: ${count.toLocaleString('en-US')} messages`}
              className={
                hour === insights.busiestHour
                  ? 'flex-1 rounded-t bg-accent-500'
                  : 'flex-1 rounded-t bg-accent-500/40'
              }
              style={{ height: `${String(Math.max(2, (count / peakHour) * 100))}%` }}
            />
          ))}
        </div>
        <div className="muted flex justify-between text-[11px] tabular-nums">
          <span>00</span>
          <span>06</span>
          <span>12</span>
          <span>18</span>
          <span>23</span>
        </div>
      </div>

      {insights.topEmoji.length > 0 ? (
        <div className="space-y-2">
          <h3 className="muted text-xs uppercase tracking-wide">Top emoji</h3>
          <ul className="flex flex-wrap gap-2">
            {insights.topEmoji.map((entry) => (
              <li
                key={entry.emoji}
                className="sunken flex items-center gap-1.5 rounded-full border hairline px-3 py-1"
              >
                <span className="text-lg leading-none">{entry.emoji}</span>
                <span className="muted text-xs tabular-nums">
                  {entry.count.toLocaleString('en-US')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="muted text-xs">
        {insights.totalMessages.toLocaleString('en-US')} messages over{' '}
        {insights.activeDays.toLocaleString('en-US')} active day
        {insights.activeDays === 1 ? '' : 's'}. Times are as the export wrote them.
      </p>
    </Card>
  );
}
