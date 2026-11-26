'use client';

/**
 * A participant's initials in their own colour.
 *
 * Exports contain no photographs of the people in a conversation, so there is
 * nothing to show but a name. Initials in a stable colour do the same job a
 * picture would: they let you tell at a glance who is speaking, without
 * inventing an image of somebody.
 */
import { senderStyle } from '@/lib/conversationLayout';
import { cx } from '@/components/ui';

export function Avatar({
  name,
  size = 28,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const { hue, initials } = senderStyle(name);
  return (
    <span
      // The name is already announced by the message itself; this is decoration.
      aria-hidden="true"
      className={cx(
        'sender-avatar inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none',
        className,
      )}
      style={{
        width: `${String(size)}px`,
        height: `${String(size)}px`,
        fontSize: `${String(Math.round(size * 0.4))}px`,
        // Consumed by the .sender-avatar rules, which pick a lightness per theme.
        ['--sender-hue' as string]: String(hue),
      }}
    >
      {initials}
    </span>
  );
}

export function SenderName({ name, className }: { name: string; className?: string }) {
  const { hue } = senderStyle(name);
  return (
    <span
      className={cx('sender-name text-xs font-semibold', className)}
      style={{ ['--sender-hue' as string]: String(hue) }}
    >
      {name}
    </span>
  );
}
