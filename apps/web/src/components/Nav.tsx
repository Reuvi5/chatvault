'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Button, cx } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

const LINKS = [
  { href: '/app', label: 'Archive' },
  { href: '/app/import', label: 'Import' },
  { href: '/app/usage', label: 'Usage' },
  { href: '/app/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname();
  const { lock, session } = useVault();
  const [open, setOpen] = useState(false);

  return (
    <header className="surface sticky top-0 z-20 border-b hairline">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
        <Link href="/app" className="flex items-center gap-2 font-semibold">
          <span
            aria-hidden="true"
            className="inline-block size-5 rounded-md bg-accent-500"
            style={{ clipPath: 'polygon(0 0, 100% 0, 100% 72%, 50% 100%, 0 72%)' }}
          />
          ChatVault
        </Link>

        <nav className="ml-2 hidden gap-1 sm:flex">
          {LINKS.map((link) => {
            const active = link.href === '/app' ? pathname === '/app' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-sm',
                  active ? 'bg-accent-100 font-medium text-accent-700 dark:bg-accent-700/30 dark:text-accent-100' : 'muted hover:bg-ink-100 dark:hover:bg-ink-800',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span className="muted hidden text-xs sm:inline">{session?.email}</span>
          <Button onClick={() => void lock()} title="Clear the key from memory and the local cache">
            Lock
          </Button>
          <button
            type="button"
            className="sm:hidden rounded-lg px-2 py-1.5 text-sm"
            aria-expanded={open}
            aria-label="Menu"
            onClick={() => setOpen(!open)}
          >
            ☰
          </button>
        </div>
      </div>

      {open ? (
        <nav className="flex flex-col gap-1 border-t hairline px-4 py-2 sm:hidden">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm"
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
