/**
 * An in-process router over the real route handlers.
 *
 * The handlers are plain functions of `Request`, so the same code that serves
 * the web app can be driven directly, with a cookie jar, by:
 *
 *   - the integration tests, which check authorisation, metering and
 *     replication against the real request path rather than a mock, and
 *   - `npm run drill:restore`, which performs the full disaster-recovery
 *     rehearsal the plan asks for (§15.3) without needing a browser.
 *
 * This is not a route registry for production: Next owns the real routes under
 * `src/app/api`. It is kept in step with them by `tests/routes.test.ts`, which
 * fails if a route file exists with no entry here.
 */
import {
  handleLogin,
  handleLogout,
  handleMfaBegin,
  handleMfaConfirm,
  handleResendVerification,
  handleSession,
  handleSignup,
  handleVerifyEmail,
} from './handlers/auth';
import { handleCreateVault, handleUpdateVaultBundle, handleUsage } from './handlers/vaults';
import { handleCompleteImport, handleCreateImport, handleImportStatus } from './handlers/imports';
import {
  handleAuthorizeDownload,
  handleAuthorizeUpload,
  handleCompleteObject,
  handleHeadObject,
  handleObjectContent,
  handleUploadPart,
} from './handlers/objects';
import {
  handleDeleteAccount,
  handleDeleteConversation,
  handleListConversations,
  handleRestoreConversation,
} from './handlers/conversations';
import {
  handleBillingStatus,
  handleBillingWebhook,
  handleCheckout,
  handlePortal,
} from './handlers/billing';
import { handleHealth, handleOpsStatus, handleRunReplication } from './handlers/ops';
import { errorResponse, jsonResponse } from './http';

type Handler = (request: Request, params: string[]) => Promise<Response>;

interface Entry {
  method: string;
  /** Matches the pathname; capture groups become `params`. */
  pattern: RegExp;
  handler: Handler;
}

const plain =
  (handler: (request: Request) => Promise<Response>): Handler =>
  (request) =>
    handler(request);

export const ROUTE_TABLE: Entry[] = [
  { method: 'POST', pattern: /^\/api\/auth\/signup$/u, handler: plain(handleSignup) },
  { method: 'POST', pattern: /^\/api\/auth\/login$/u, handler: plain(handleLogin) },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/u, handler: plain(handleLogout) },
  { method: 'GET', pattern: /^\/api\/auth\/session$/u, handler: plain(handleSession) },
  { method: 'POST', pattern: /^\/api\/auth\/verify-email$/u, handler: plain(handleVerifyEmail) },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/resend-verification$/u,
    handler: plain(handleResendVerification),
  },
  { method: 'POST', pattern: /^\/api\/auth\/mfa\/begin$/u, handler: plain(handleMfaBegin) },
  { method: 'POST', pattern: /^\/api\/auth\/mfa\/confirm$/u, handler: plain(handleMfaConfirm) },

  { method: 'POST', pattern: /^\/api\/vaults$/u, handler: plain(handleCreateVault) },
  {
    method: 'PUT',
    pattern: /^\/api\/vaults\/current\/bundle$/u,
    handler: plain(handleUpdateVaultBundle),
  },
  { method: 'GET', pattern: /^\/api\/vaults\/current\/usage$/u, handler: plain(handleUsage) },

  { method: 'POST', pattern: /^\/api\/imports$/u, handler: plain(handleCreateImport) },
  {
    method: 'POST',
    pattern: /^\/api\/imports\/([^/]+)\/complete$/u,
    handler: (request, params) => handleCompleteImport(request, params[0] as string),
  },
  {
    method: 'GET',
    pattern: /^\/api\/imports\/([^/]+)\/status$/u,
    handler: (request, params) => handleImportStatus(request, params[0] as string),
  },

  {
    method: 'POST',
    pattern: /^\/api\/objects\/upload-authorize$/u,
    handler: plain(handleAuthorizeUpload),
  },
  { method: 'POST', pattern: /^\/api\/objects\/complete$/u, handler: plain(handleCompleteObject) },
  {
    method: 'PUT',
    pattern: /^\/api\/objects\/([^/]+)\/parts\/([^/]+)$/u,
    handler: (request, params) =>
      handleUploadPart(request, params[0] as string, params[1] as string),
  },
  {
    method: 'GET',
    pattern: /^\/api\/objects\/([^/]+)\/download-authorize$/u,
    handler: (request, params) => handleAuthorizeDownload(request, params[0] as string),
  },
  {
    method: 'GET',
    pattern: /^\/api\/objects\/([^/]+)\/content$/u,
    handler: (request, params) => handleObjectContent(request, params[0] as string),
  },
  {
    method: 'HEAD',
    pattern: /^\/api\/objects\/([^/]+)\/content$/u,
    handler: (request, params) => handleHeadObject(request, params[0] as string),
  },

  { method: 'GET', pattern: /^\/api\/conversations$/u, handler: plain(handleListConversations) },
  {
    method: 'POST',
    pattern: /^\/api\/conversations\/([^/]+)\/delete$/u,
    handler: (request, params) => handleDeleteConversation(request, params[0] as string),
  },
  {
    method: 'POST',
    pattern: /^\/api\/conversations\/([^/]+)\/restore$/u,
    handler: (request, params) => handleRestoreConversation(request, params[0] as string),
  },
  { method: 'POST', pattern: /^\/api\/account\/delete$/u, handler: plain(handleDeleteAccount) },

  { method: 'POST', pattern: /^\/api\/billing\/checkout$/u, handler: plain(handleCheckout) },
  { method: 'POST', pattern: /^\/api\/billing\/portal$/u, handler: plain(handlePortal) },
  { method: 'POST', pattern: /^\/api\/billing\/webhook$/u, handler: plain(handleBillingWebhook) },
  { method: 'GET', pattern: /^\/api\/billing\/status$/u, handler: plain(handleBillingStatus) },

  { method: 'POST', pattern: /^\/api\/ops\/replicate$/u, handler: plain(handleRunReplication) },
  { method: 'GET', pattern: /^\/api\/ops\/status$/u, handler: plain(handleOpsStatus) },
  { method: 'GET', pattern: /^\/api\/health$/u, handler: plain(handleHealth) },
];

/** Minimal cookie jar, so sessions behave the way a browser makes them behave. */
export class CookieJar {
  private cookies = new Map<string, string>();

  header(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorb(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? [];
    const single = response.headers.get('set-cookie');
    const all = values.length > 0 ? values : single ? [single] : [];
    for (const raw of all) {
      const [pair, ...attributes] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (!name) continue;
      const value = rest.join('=');
      const expired = attributes.some((attribute) => /max-age=0/iu.test(attribute.trim()));
      if (expired || value === '') this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
  }

  clear(): void {
    this.cookies.clear();
  }
}

export interface LocalFetchOptions {
  jar?: CookieJar;
  /** Forwarded as x-forwarded-for, which the rate limiter and audit rows hash. */
  clientIp?: string;
}

/**
 * A `fetch` implementation that dispatches straight into the route handlers.
 * Pass it to `new ApiClient({ fetchImpl })`.
 */
export function createLocalFetch(options: LocalFetchOptions = {}): typeof fetch {
  const jar = options.jar ?? new CookieJar();

  const localFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'http://localhost:3000');
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const cookie = jar.header();
    if (cookie) headers.set('cookie', cookie);
    headers.set('x-forwarded-for', options.clientIp ?? '127.0.0.1');
    headers.set('user-agent', 'chatvault-local-router');

    const request = new Request(url.toString(), {
      method,
      headers,
      ...(init?.body === undefined || method === 'GET' || method === 'HEAD'
        ? {}
        : { body: init.body }),
    });

    const match = ROUTE_TABLE.find(
      (entry) => entry.method === method && entry.pattern.test(url.pathname),
    );
    if (!match) {
      return jsonResponse(
        { error: { code: 'not_found', message: `No route for ${method} ${url.pathname}` } },
        { status: 404 },
      );
    }
    const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map(decodeURIComponent);

    let response: Response;
    try {
      response = await match.handler(request, params);
    } catch (error) {
      response = errorResponse(error);
    }
    jar.absorb(response);
    return response;
  };

  return localFetch;
}
