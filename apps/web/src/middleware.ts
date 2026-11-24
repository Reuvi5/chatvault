import { NextResponse, type NextRequest } from 'next/server';
import { THEME_BOOTSTRAP_SHA256 } from '@/themeBootstrap';

/**
 * Content-Security-Policy with a per-request nonce.
 *
 * This is the main mitigation for the risk the plan is explicit about: a hosted
 * web app cannot protect a person from a compromised frontend deployment, but a
 * tight policy makes injected third-party script much harder to run, and there
 * is no third-party script in this app at all.
 *
 * `script-src` allows exactly three things: our own scripts via the nonce and
 * `strict-dynamic`, and the one inline theme bootstrap, by hash. `blob:` is
 * allowed for images and media because decrypted attachments are rendered from
 * in-memory blobs; it is not a network origin.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDevelopment = process.env.NODE_ENV !== 'production';

  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' '${THEME_BOOTSTRAP_SHA256}' 'strict-dynamic'${
      isDevelopment ? " 'unsafe-eval'" : ''
    }`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, which need no policy of their own.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
