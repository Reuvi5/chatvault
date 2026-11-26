'use client';

/**
 * The conversation view.
 *
 * The familiar chat shape — bubbles, runs of consecutive messages, avatars,
 * date separators, a tail on the first bubble of each run — built from scratch.
 * None of WhatsApp's artwork, palette or wordmarks appear here; what is borrowed
 * is the layout grammar that every chat app shares, because that grammar is what
 * makes a transcript readable.
 *
 * How this stays usable at a hundred thousand messages:
 *
 *  - Messages are grouped by day, and each day is a section with
 *    `content-visibility: auto`, so the browser skips layout and paint for the
 *    days that are off screen while the scrollbar stays honest.
 *  - Only a window of recent days is mounted. The window grows when a sentinel
 *    above the oldest mounted day comes into view, so scrolling back through a
 *    long archive is continuous rather than a button press, and the DOM never
 *    holds the whole conversation at once.
 *  - Which days are mounted is *derived*, not stored in an effect: a deep link
 *    into an old day widens the window during render, so there is no second
 *    render pass and no flash of the wrong content.
 *
 * Two conventions from the screenshot are deliberately absent. There are no
 * delivery or read ticks: this is an archive, it has no delivery state, and a
 * tick would assert something the export does not know. And there are no quoted
 * replies: WhatsApp's text export drops reply metadata, so a quote block here
 * could only be guesswork.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationManifest, ManifestAttachmentRef } from '@chatvault/protocol';
import type { CanonicalMessage } from '@chatvault/parser';
import { Badge, Button, cx } from '@/components/ui';
import { Attachment } from '@/components/Attachment';
import { Avatar, SenderName } from '@/components/Avatar';
import {
  formatClock,
  formatDayHeading,
  groupConversation,
  type MessageRun,
} from '@/lib/conversationLayout';

/** Days added each time the reader reaches the top of what is mounted. */
const DAYS_PER_STEP = 14;

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
  const days = useMemo(() => groupConversation(messages, { selfName }), [messages, selfName]);
  const attachmentsByName = useMemo(() => {
    const map = new Map<string, ManifestAttachmentRef>();
    for (const item of manifest.attachments) map.set(item.fileName, item);
    return map;
  }, [manifest]);

  const [requestedDays, setRequestedDays] = useState(DAYS_PER_STEP);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /* A deep link may point at a day older than the window. Widen it here, while
     rendering, rather than correcting it afterwards in an effect. */
  const highlightDay = useMemo(() => {
    if (highlightIndex === null || highlightIndex === undefined) return -1;
    return days.findIndex((day) =>
      day.runs.some((run) => run.messages.some((entry) => entry.index === highlightIndex)),
    );
  }, [days, highlightIndex]);

  const daysNeededForHighlight = highlightDay >= 0 ? days.length - highlightDay : 0;
  const mountedDays = Math.min(days.length, Math.max(requestedDays, daysNeededForHighlight));
  const firstDay = days.length - mountedDays;
  const visibleDays = days.slice(firstDay);
  const hiddenMessages = days
    .slice(0, firstDay)
    .reduce((total, day) => total + day.messageCount, 0);

  /* Grow the window as the reader scrolls back past the oldest mounted day. */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || firstDay === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRequestedDays((previous) => previous + DAYS_PER_STEP);
        }
      },
      { rootMargin: '600px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [firstDay]);

  /* Bring a deep-linked message into view once its day is mounted. */
  useEffect(() => {
    if (highlightRef.current) highlightRef.current.scrollIntoView({ block: 'center' });
  }, [highlightIndex, firstDay]);

  return (
    <div className="chat-surface space-y-3 rounded-xl py-3">
      {firstDay > 0 ? (
        <div
          ref={sentinelRef}
          className="flex flex-col items-center gap-2 py-3"
          data-testid="older-messages-sentinel"
        >
          <p className="muted text-xs" aria-live="polite">
            {hiddenMessages.toLocaleString('en-US')} earlier messages, across {firstDay} day
            {firstDay === 1 ? '' : 's'}
          </p>
          <Button onClick={() => setRequestedDays((previous) => previous + DAYS_PER_STEP)}>
            Load earlier
          </Button>
          <p className="muted text-[11px]">Or keep scrolling — more loads as you go.</p>
        </div>
      ) : null}

      {visibleDays.map((day) => (
        <section
          key={day.key}
          className="day-section space-y-2"
          aria-label={formatDayHeading(day.date)}
        >
          <div className="sticky top-14 z-10 flex justify-center py-1">
            <h3 className="day-chip rounded-lg px-2.5 py-1 text-[11px] font-medium tracking-wide uppercase">
              {formatDayHeading(day.date)}
            </h3>
          </div>

          {day.runs.map((run, runIndex) => (
            <Run
              key={`${day.key}:${String(runIndex)}`}
              run={run}
              isGroup={manifest.isGroup}
              attachmentsByName={attachmentsByName}
              highlightIndex={highlightIndex ?? null}
              highlightRef={highlightRef}
            />
          ))}
        </section>
      ))}

      {messages.length === 0 ? (
        <p className="muted py-10 text-center text-sm">This conversation has no messages.</p>
      ) : (
        <p className="muted flex flex-wrap items-center justify-center gap-2 py-6 text-xs">
          <Badge>{messages.length.toLocaleString('en-US')} messages</Badge>
          <span>
            Times are shown exactly as the export wrote them ({manifest.assumedTimeZone} assumed).
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * One run: consecutive messages from the same person, close together in time.
 * The name and the avatar appear once, on the first bubble, and the tail is
 * drawn there too — so a burst of five messages reads as one turn in the
 * conversation rather than five separate events.
 */
function Run({
  run,
  isGroup,
  attachmentsByName,
  highlightIndex,
  highlightRef,
}: {
  run: MessageRun;
  isGroup: boolean;
  attachmentsByName: Map<string, ManifestAttachmentRef>;
  highlightIndex: number | null;
  highlightRef: React.RefObject<HTMLDivElement | null>;
}) {
  /* System notices are not from anybody: centred, no bubble, no attribution. */
  if (run.sender === null) {
    return (
      <>
        {run.messages.map(({ message, index }) => (
          <p
            key={index}
            id={`m${String(index)}`}
            className="system-notice mx-auto max-w-xl px-3 py-1 text-center text-[11px] leading-relaxed"
          >
            {message.body}
          </p>
        ))}
      </>
    );
  }

  const { mine, sender } = run;
  const showAvatar = !mine && isGroup;

  return (
    <div className={cx('flex items-start gap-1.5 px-1.5', mine ? 'justify-end' : 'justify-start')}>
      {showAvatar ? <Avatar name={sender} size={28} className="mt-0.5" /> : null}

      <div
        className={cx(
          'flex min-w-0 max-w-[min(42rem,85%)] flex-col gap-[3px]',
          mine ? 'items-end' : 'items-start',
        )}
      >
        {run.messages.map(({ message, index }, position) => {
          const attachment = message.attachmentFileName
            ? attachmentsByName.get(message.attachmentFileName)
            : undefined;
          const isHighlighted = highlightIndex === index;
          const first = position === 0;
          const hasBody = Boolean(message.body) && !message.flags.deleted;

          return (
            <div
              key={index}
              id={`m${String(index)}`}
              ref={isHighlighted ? highlightRef : undefined}
              className={cx(
                'relative max-w-full px-2.5 py-1.5 text-sm',
                mine ? 'bubble-me' : 'bubble-them',
                first && (mine ? 'bubble-tail-me' : 'bubble-tail-them'),
                isHighlighted && 'ring-2 ring-accent-400',
              )}
            >
              {first && showAvatar ? <SenderName name={sender} className="mb-0.5 block" /> : null}

              {message.flags.deleted ? (
                <p className="muted italic">This message was deleted</p>
              ) : message.flags.mediaOmitted ? (
                <p className="muted italic">
                  Media was not included in this export
                  <span className="not-italic"> — </span>
                  <span className="not-italic text-xs">{message.body}</span>
                </p>
              ) : null}

              {attachment ? (
                <div className={cx(hasBody && 'mb-1')}>
                  <Attachment attachment={attachment} />
                </div>
              ) : null}

              {/* The clock sits on the last line, and floats right of the text
                  the way every chat app does it, so a one-word message stays
                  one line instead of growing a second. */}
              {hasBody && !message.flags.mediaOmitted ? (
                <p className="wrap-anywhere whitespace-pre-wrap leading-relaxed">
                  {message.body}
                  <span className="bubble-clock" aria-hidden="true">
                    {message.flags.edited ? 'edited · ' : ''}
                    {formatClock(message.localTs, message.tsPrecision)}
                  </span>
                </p>
              ) : null}

              <p
                className={cx(
                  'bubble-meta muted text-[11px] tabular-nums',
                  hasBody && !message.flags.mediaOmitted ? 'sr-only' : 'text-right',
                )}
              >
                {message.flags.edited ? <span>edited · </span> : null}
                <time dateTime={message.localTs}>
                  {formatClock(message.localTs, message.tsPrecision)}
                </time>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
