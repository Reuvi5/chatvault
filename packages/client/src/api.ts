/**
 * Typed client for the ChatVault API (plan §10).
 *
 * Everything that crosses this boundary is either an opaque identifier or
 * ciphertext. If you are adding a method here and it carries message text, a
 * contact name or a message timestamp, it belongs on the device instead.
 */
import type {
  CompleteImportRequest,
  CompleteObjectRequest,
  ConversationsResponse,
  CreateImportRequest,
  CreateImportResponse,
  DownloadAuthorizeResponse,
  ImportStatusResponse,
  UploadAuthorizeRequest,
  UploadAuthorizeResponse,
  UsageResponse,
  VaultBundleWire,
  ApiErrorCode,
} from '@chatvault/protocol';

/** Seconds from a response's Retry-After header, when it carries one. */
function retryAfterFrom(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network' | 'unknown',
    message: string,
    readonly details?: unknown,
    /** Seconds the server asked us to wait, from a 429's Retry-After. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get isAuthProblem(): boolean {
    return this.code === 'unauthorized' || this.code === 'forbidden';
  }
}

export interface SessionInfo {
  accountId: string;
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  vault: {
    id: string;
    bundle: VaultBundleWire;
    assumedTimeZone: string;
  } | null;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown> | unknown[];

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/u, '');
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Json,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        ...init,
        method,
        credentials: 'include',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiRequestError(
        0,
        'network',
        'ChatVault could not reach the server. Check your connection and try again.',
        error,
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed: unknown = text === '' ? null : safeJsonParse(text);

    if (!response.ok) {
      const envelope = parsed as {
        error?: { code?: ApiErrorCode; message?: string; details?: unknown };
      } | null;
      throw new ApiRequestError(
        response.status,
        envelope?.error?.code ?? 'unknown',
        envelope?.error?.message ?? `Request failed with status ${String(response.status)}`,
        envelope?.error?.details,
        retryAfterFrom(response),
      );
    }
    return parsed as T;
  }

  /* ------------------------------------------------------------- accounts */

  async signup(
    email: string,
    password: string,
  ): Promise<{ accountId: string; verificationUrl?: string }> {
    return this.request('POST', '/api/auth/signup', { email, password });
  }

  async login(email: string, password: string, totp?: string): Promise<SessionInfo> {
    return this.request(
      'POST',
      '/api/auth/login',
      totp ? { email, password, totp } : { email, password },
    );
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/auth/logout');
  }

  async session(): Promise<SessionInfo | null> {
    try {
      return await this.request<SessionInfo>('GET', '/api/auth/session');
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'unauthorized') return null;
      throw error;
    }
  }

  async verifyEmail(token: string): Promise<void> {
    await this.request('POST', '/api/auth/verify-email', { token });
  }

  async resendVerification(): Promise<{ sent: boolean; verificationUrl?: string }> {
    return this.request('POST', '/api/auth/resend-verification');
  }

  async beginTotpEnrollment(): Promise<{ secret: string; otpauthUrl: string }> {
    return this.request('POST', '/api/auth/mfa/begin');
  }

  async confirmTotpEnrollment(code: string): Promise<{ recoveryCodes: string[] }> {
    return this.request('POST', '/api/auth/mfa/confirm', { code });
  }

  /* --------------------------------------------------------------- vaults */

  async createVault(
    bundle: VaultBundleWire,
    assumedTimeZone: string,
  ): Promise<{ vaultId: string }> {
    return this.request('POST', '/api/vaults', { bundle, assumedTimeZone });
  }

  async updateVaultBundle(bundle: VaultBundleWire, expectedKeyId: string): Promise<void> {
    await this.request('PUT', '/api/vaults/current/bundle', { bundle, expectedKeyId });
  }

  async usage(): Promise<UsageResponse> {
    return this.request('GET', '/api/vaults/current/usage');
  }

  /* -------------------------------------------------------------- imports */

  async createImport(request: CreateImportRequest): Promise<CreateImportResponse> {
    return this.request('POST', '/api/imports', request);
  }

  async authorizeUpload(request: UploadAuthorizeRequest): Promise<UploadAuthorizeResponse> {
    return this.request('POST', '/api/objects/upload-authorize', request);
  }

  /** Uploads one part of an object's ciphertext. Safe to retry. */
  async uploadPart(
    template: string,
    partNumber: number,
    ticket: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const url = template.replace('{part}', String(partNumber));
    const response = await this.fetchImpl(this.url(url), {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chatvault-ticket': ticket,
      },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiRequestError(
        response.status,
        'unknown',
        `Uploading part ${String(partNumber)} failed: ${text.slice(0, 200)}`,
        undefined,
        retryAfterFrom(response),
      );
    }
  }

  async completeObject(request: CompleteObjectRequest): Promise<{ objectId: string }> {
    return this.request('POST', '/api/objects/complete', request);
  }

  async completeImport(
    importId: string,
    request: CompleteImportRequest,
  ): Promise<ImportStatusResponse> {
    return this.request('POST', `/api/imports/${encodeURIComponent(importId)}/complete`, request);
  }

  async importStatus(importId: string): Promise<ImportStatusResponse> {
    return this.request('GET', `/api/imports/${encodeURIComponent(importId)}/status`);
  }

  /* -------------------------------------------------------- conversations */

  async conversations(): Promise<ConversationsResponse> {
    return this.request('GET', '/api/conversations');
  }

  async authorizeDownload(objectId: string): Promise<DownloadAuthorizeResponse> {
    return this.request('GET', `/api/objects/${encodeURIComponent(objectId)}/download-authorize`);
  }

  /** Fetches object ciphertext. The body is opaque to the server. */
  async downloadObject(objectId: string): Promise<{ bytes: Uint8Array; expectedSha256: string }> {
    const auth = await this.authorizeDownload(objectId);
    const response = await this.fetchImpl(this.url(auth.downloadUrl), {
      method: 'GET',
      credentials: 'include',
      headers: { 'x-chatvault-ticket': auth.ticket },
    });
    if (!response.ok) {
      throw new ApiRequestError(response.status, 'unknown', `Could not download ${objectId}`);
    }
    const buffer = await response.arrayBuffer();
    return { bytes: new Uint8Array(buffer), expectedSha256: auth.ciphertextSha256 };
  }

  async deleteConversation(conversationId: string, mode: 'trash' | 'purge', confirm?: string) {
    await this.request('POST', `/api/conversations/${encodeURIComponent(conversationId)}/delete`, {
      mode,
      ...(confirm === undefined ? {} : { confirm }),
    });
  }

  async restoreConversation(conversationId: string): Promise<void> {
    await this.request('POST', `/api/conversations/${encodeURIComponent(conversationId)}/restore`);
  }

  async deleteAccount(confirmEmail: string, purgeImmediately: boolean): Promise<void> {
    await this.request('POST', '/api/account/delete', { confirmEmail, purgeImmediately });
  }

  /* -------------------------------------------------------------- billing */

  async startCheckout(returnPath = '/app/usage'): Promise<{ url: string }> {
    return this.request('POST', '/api/billing/checkout', { returnPath });
  }

  /* ----------------------------------------------------------- operations */

  async runReplication(
    limit = 50,
  ): Promise<{ processed: number; verified: number; failed: number }> {
    return this.request('POST', '/api/ops/replicate', { limit });
  }

  async operationsStatus(): Promise<{
    objects: Record<string, number>;
    bytes: Record<string, number>;
    deadLettered: number;
    lastRunMs: number | null;
  }> {
    return this.request('GET', '/api/ops/status');
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'internal', message: text.slice(0, 300) } };
  }
}
