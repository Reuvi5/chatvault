import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Security headers.
 *
 * The Content-Security-Policy itself is set per request in `src/middleware.ts`,
 * because it carries a one-time nonce. Everything that is the same on every
 * response lives here (plan §6 "Important caveat about web-based encryption").
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  ...(process.env.NODE_ENV === 'production'
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are TypeScript sources, compiled by Next itself.
  transpilePackages: [
    '@chatvault/protocol',
    '@chatvault/crypto',
    '@chatvault/parser',
    '@chatvault/client',
  ],
  outputFileTracingRoot: join(here, '../..'),
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Never let an intermediary cache ciphertext or API responses.
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

export default nextConfig;
