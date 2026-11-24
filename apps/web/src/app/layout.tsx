import type { Metadata, Viewport } from 'next';
import { THEME_BOOTSTRAP } from '@/themeBootstrap';
import './globals.css';

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
