import type { Metadata, Viewport } from 'next';
import { THEME_BOOTSTRAP } from '@/themeBootstrap';
import './globals.css';

/*
 * Rendered per request, not prerendered.
 *
 * The Content-Security-Policy gives each response a fresh nonce, and a page
 * baked at build time cannot carry it — see src/csp.ts. Nothing is lost: every
 * page here is a client component behind a passphrase, so there is no server
 * HTML worth caching.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ChatVault — your chat history, preserved',
  description:
    'A private, end-to-end encrypted archive for chat conversations you have exported yourself.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1220' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies a saved theme before the first paint. Allowed by hash in the
            Content-Security-Policy; see src/themeBootstrap.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
