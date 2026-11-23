'use client';

/**
 * The conversation view.
 *
 * Familiar chat shape — bubbles, sender labels, date separators — built from
 * scratch rather than copied from any product, with no third-party assets.
 *
 * Long conversations: messages are grouped by day and each day is a section with
 * `content-visibility: auto`, so the browser skips layout and paint for days
 * that are off screen while keeping the scrollbar honest. Only a window of
 * recent days is mounted at first; earlier days load on demand. That keeps a
 * hundred-thousand-message conversation responsive without a virtual scroller
 * that would fight with variable-height media.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationManifest, ManifestAttachmentRef } from '@chatvault/protocol';
import type { CanonicalMessage } from '@chatvault/parser';
import { Badge, Button, cx } from '@/components/ui';
import { Attachment } from '@/components/Attachment';

const DAYS_PER_WINDOW = 14;

interface Day {
  date: string;
  messages: Array<{ message: CanonicalMessage; index: number }>;
}

function groupByDay(messages: readonly CanonicalMessage[]): Day[] {
  const days: Day[] = [];
  let current: Day | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as CanonicalMessage;
    const date = message.localTs.slice(0, 10);
    if (!current || current.date !== date) {
      current = { date, messages: [] };
      days.push(current);
    }
    current.messages.push({ message, index });
  }
  return days;
}

function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function timeOf(localTs: string, precision: 'minute' | 'second'): string {
  return precision === 'second' ? localTs.slice(11, 19) : localTs.slice(11, 16);
}

export function MessageTimeline({
  manifest,
  messages,
  selfName,
  highlightIndex,
}: {
  manifest: ConversationManifest;
  messages: readonly CanonicalMessage[];
  selfName: string | null;
  highlightIndex?: number | null;
}) {
  const days = useMemo(() => groupByDay(messages), [messages]);
  const attachmentsByName = useMemo(() => {
    const map = new Map<string, ManifestAttachmentRef>();
    for (const item of manifest.attachments) map.set(item.fileName, item);
    return map;
  }, [manifest]);

  const [firstDay, setFirstDay] = useState(() => Math.max(0, days.length - DAYS_PER_WINDOW));
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Make sure a deep link's target day is mounted, then scroll to it.
  useEffect(() => {
    if (highlightIndex === null || highlightIndex === undefined) return;
    const dayIndex = days.findIndex((day) =>
      day.messages.some((entry) => entry.index === highlightIndex),
    );
    if (dayIndex >= 0 && dayIndex < firstDay) setFirstDay(dayIndex);
  }, [highlightIndex, days, firstDay]);

  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center' });
    }
  }, [highlightIndex, firstDay]);

  const visibleDays = days.slice(firstDay);
  const hiddenCount = days
    .slice(0, firstDay)
    .reduce((total, day) => total + day.messages.length, 0);

  return (
    <div className="space-y-4">
      {firstDay > 0 ? (
        <div className="flex flex-col items-center gap-2 py-2">
          <p className="muted text-xs">
            {hiddenCount.toLocaleString('en-US')} earlier messages across {firstDay} day
            {firstDay === 1 ? '' : 's'}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => setFirstDay(Math.max(0, firstDay - DAYS_PER_WINDOW))}>
              Load earlier
            </Button>
            <Button onClick={() => setFirstDay(0)}>Load all</Button>
          </div>
        </div>
      ) : null}

      {visibleDays.map((day) => (
        <section key={day.date} className="day-section space-y-1.5">
          <div className="sticky top-14 z-10 flex justify-center py-1">
            <span className="sunken rounded-full border hairline px-3 py-1 text-xs font-medium">
              {formatDay(day.date)}
            </span>
          </div>

          {day.messages.map(({ message, index }) => {
            if (message.kind === 'system') {
              return (
                <p
                  key={index}
                  id={`m${String(index)}`}
                  className="muted mx-auto max-w-2xl px-3 py-1 text-center text-xs leading-relaxed"
                >
                  {message.body}
                </p>
              );
            }

            const mine = selfName !== null && message.sender === selfName;
            const attachment = message.attachmentFileName
              ? attachmentsByName.get(message.attachmentFileName)
              : undefined;
            const isHighlighted = highlightIndex === index;

            return (
              <div
                key={index}
                id={`m${String(index)}`}
                ref={isHighlighted ? highlightRef : undefined}
                className={cx('flex px-2', mine ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cx(
                    'max-w-[min(42rem,85%)] space-y-1.5 rounded-2xl border hairline px-3 py-2 text-sm shadow-sm',
                    mine ? 'bubble-me rounded-br-md' : 'bubble-them rounded-bl-md',
                    isHighlighted && 'ring-2 ring-accent-400',
                  )}
                >
                  {!mine && manifest.isGroup ? (
                    <p className="text-xs font-semibold text-accent-600 dark:text-accent-300">
                      {message.sender}
                    </p>
                  ) : null}

                  {message.flags.deleted ? (
                    <p className="muted italic">This message was deleted</p>
                  ) : message.flags.mediaOmitted ? (
                    <p className="muted italic">
                      Media was not included in this export
                      <span className="not-italic"> — </span>
                      <span className="not-italic text-xs">{message.body}</span>
                    </p>
                  ) : null}

                  {attachment ? <Attachment attachment={attachment} /> : null}

                  {message.body && !message.flags.deleted && !message.flags.mediaOmitted ? (
                    <p className="wrap-anywhere whitespace-pre-wrap leading-relaxed">
                      {message.body}
                    </p>
                  ) : null}

                  <p className="muted flex items-center justify-end gap-1.5 text-[11px]">
                    {message.flags.edited ? <span title="Edited after sending">edited</span> : null}
                    <time dateTime={message.localTs}>
                      {timeOf(message.localTs, message.tsPrecision)}
                    </time>
                  </p>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      {messages.length === 0 ? (
        <p className="muted py-10 text-center text-sm">This conversation has no messages.</p>
      ) : (
        <p className="muted flex items-center justify-center gap-2 py-6 text-xs">
          <Badge>{messages.length.toLocaleString('en-US')} messages</Badge>
          <span>
            Times are shown exactly as the export wrote them ({manifest.assumedTimeZone} assumed).
          </span>
        </p>
      )}
    </div>
  );
}
