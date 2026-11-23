'use client';

/** Small, shared interface pieces. No third-party UI dependencies. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  busy = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55';
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-accent-500 text-white hover:bg-accent-600',
    secondary: 'surface border hairline hover:bg-ink-100 dark:hover:bg-ink-800',
    ghost: 'hover:bg-ink-100 dark:hover:bg-ink-800',
    danger: 'bg-danger-500 text-white hover:bg-danger-700',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(base, variants[variant], className)}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag className={cx('surface rounded-card border hairline', className)}>{children}</Tag>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger-500" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="muted text-xs leading-relaxed">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        'sunken w-full rounded-lg border hairline px-3 py-2 text-sm outline-none placeholder:text-ink-400',
        className,
      )}
    />
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'danger' | 'accent';

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  const tones: Record<Tone, string> = {
    neutral: 'sunken muted',
    good: 'bg-good-100 text-good-700 dark:bg-good-700/25 dark:text-good-100',
    warn: 'bg-warn-100 text-warn-700 dark:bg-warn-700/25 dark:text-warn-100',
    danger: 'bg-danger-100 text-danger-700 dark:bg-danger-700/30 dark:text-danger-100',
    accent: 'bg-accent-100 text-accent-700 dark:bg-accent-700/30 dark:text-accent-100',
  };
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const tones: Record<Tone, string> = {
    neutral: 'sunken',
    good: 'bg-good-100 text-good-700 dark:bg-good-700/20 dark:text-good-100',
    warn: 'bg-warn-100 text-warn-700 dark:bg-warn-700/20 dark:text-warn-100',
    danger: 'bg-danger-100 text-danger-700 dark:bg-danger-700/25 dark:text-danger-100',
    accent: 'bg-accent-100 text-accent-700 dark:bg-accent-700/25 dark:text-accent-100',
  };
  return (
    <div className={cx('rounded-card border hairline p-3 text-sm leading-relaxed', tones[tone])}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export function ProgressBar({ value, max = 1 }: { value: number; max?: number }) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div
      className="sunken h-2 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div
        className="h-full rounded-full bg-accent-500 transition-[width] duration-300"
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="muted text-xs uppercase tracking-wide">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint ? <p className="muted text-xs">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children ? <div className="muted max-w-md text-sm leading-relaxed">{children}</div> : null}
      {action}
    </div>
  );
}

/** Monospace block for things that must be copied exactly. */
export function CopyBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="space-y-2">
      <pre className="sunken wrap-anywhere overflow-x-auto rounded-lg border hairline p-3 font-mono text-[13px] leading-6 whitespace-pre-wrap select-all">
        {value}
      </pre>
      <Button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
        }}
      >
        Copy {label}
      </Button>
    </div>
  );
}
