'use client';

/**
 * Light, dark, or whatever the system says.
 *
 * The saved choice is applied before the first paint by the inline bootstrap in
 * the root layout, so this component only has to read it and change it.
 *
 * It reads through `useSyncExternalStore` rather than copying the value into
 * state in an effect. That is what the hook is for — a value that lives outside
 * React, cannot be read while rendering on the server, and can change behind
 * React's back. It also means a change in one tab shows up in the others,
 * through the `storage` event, with no extra work.
 */
import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from '@/themeBootstrap';
import { cx } from '@/components/ui';

type Theme = 'system' | 'light' | 'dark';

const OPTIONS: Array<{ value: Theme; label: string; glyph: string }> = [
  { value: 'system', label: 'Match the system', glyph: '◐' },
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
];

const CHANGE_EVENT = 'chatvault:theme';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* A browser that refuses storage simply follows the system. */
  }
  return 'system';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** What the server renders: no stored preference is visible there. */
function serverSnapshot(): Theme {
  return 'system';
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, serverSnapshot);

  const apply = (next: Theme) => {
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* Still applies for this visit, just not the next one. */
    }
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    // `storage` does not fire in the tab that made the change.
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  return (
    <div
      className="sunken flex rounded-lg border hairline p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => apply(option.value)}
          aria-pressed={theme === option.value}
          title={option.label}
          className={cx(
            'rounded-md px-2 py-1 text-xs',
            theme === option.value
              ? 'surface font-medium shadow-sm'
              : 'muted hover:bg-ink-100 dark:hover:bg-ink-800',
          )}
        >
          <span aria-hidden="true">{option.glyph}</span>
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
