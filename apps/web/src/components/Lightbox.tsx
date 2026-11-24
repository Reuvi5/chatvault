'use client';

/**
 * Full-size view of an archived image.
 *
 * A real dialog rather than a styled div: Escape closes it, the backdrop closes
 * it, focus moves into it and returns to whatever opened it, and the rest of the
 * page is hidden from assistive technology while it is open.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function Lightbox({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-4"
    >
      {/* The backdrop is a button, not a clickable div, so clicking outside and
          pressing Enter on it do the same thing and it is reachable by keyboard. */}
      <button
        type="button"
        aria-label="Close this image"
        onClick={onClose}
        className="absolute inset-0 -z-10 cursor-default bg-ink-950/85 backdrop-blur-sm"
      />
      <div className="flex w-full max-w-5xl items-center gap-3">
        <p className="wrap-anywhere flex-1 truncate text-sm text-ink-100">{label}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-100 hover:bg-ink-800"
        >
          Close
        </button>
      </div>
      <div className="flex max-h-[85vh] max-w-5xl items-center justify-center overflow-auto">
        {children}
      </div>
      <p className="text-xs text-ink-400">Press Escape to close</p>
    </div>
  );
}
