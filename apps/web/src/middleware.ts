import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '@/csp';

/**
 * Security headers on every response that is not a static asset.
 *
 * The policy, and the three conditions it depends on, live in `csp.ts`.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV !== 'production',
  });

  /*
   * On the request, because that is where the framework reads the nonce from
   * when it stamps its own script tags. On the response, because that is what
   * the browser enforces. Both, or nothing runs.
   */
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, which need no policy of their own.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
