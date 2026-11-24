/**
 * Account routes: sign up, sign in, sign out, session, email confirmation and
 * TOTP enrolment.
 *
 * Sign-in credentials are deliberately separate from the vault passphrase. A
 * successful sign-in gets you a list of opaque object identifiers and nothing
 * readable; the archive still has to be unlocked on the device.
 */
import { randomBytes } from 'node:crypto';
import {
  enrollTotpRequest,
  loginRequest,
  newId,
  signupRequest,
  verifyEmailRequest,
} from '@chatvault/protocol';
import { getEnv } from '../env';
import { getStore } from '../db/index';
import {
  badRequest,
  clientHash,
  conflict,
  emptyResponse,
  jsonResponse,
  parseBody,
  sha256Hex,
  unauthorized,
} from '../http';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password';
import {
  clearedCookieHeader,
  createSession,
  destroySession,
  requireSession,
  resolveSession,
  sessionCookieHeader,
} from '../auth/session';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from '../auth/totp';
import { enforceRateLimit, recordAudit } from '../security';
import { log } from '../log';

const DEFAULT_QUOTA_MULTIPLIER = 1;

function verificationUrl(token: string): string {
  return `${getEnv().appUrl}/verify-email?token=${encodeURIComponent(token)}`;
}

function sendVerificationEmail(email: string, url: string): void {
  const env = getEnv();
  if (env.emailDriver === 'none') return;
  // No email provider is wired up; the console driver is honest about that.
  log.info('Email verification link generated', { email, url });
}

export async function handleSignup(request: Request): Promise<Response> {
  const env = getEnv();
  enforceRateLimit(`signup:${clientHash(request)}`, env.rateLimits.auth);
  const input = await parseBody(request, signupRequest);
  const store = await getStore();

  const existing = await store.findOne('accounts', { equals: { email: input.email } });
  if (existing) {
    // Do not reveal whether an address is registered.
    throw conflict('That email address cannot be used to sign up. Try signing in instead.');
  }

  const password = await hashPassword(input.password);
  const token = randomBytes(32).toString('base64url');
  const accountId = newId('acc');
  const now = Date.now();

  try {
    await store.insert('accounts', {
      id: accountId,
      email: input.email,
      password_hash: password.hash,
      password_params: password.params,
      email_verified: false,
      verification_token_hash: sha256Hex(token),
      mfa_secret_enc: null,
      mfa_enabled: false,
      mfa_recovery_hashes: null,
      stripe_customer_id: null,
      billing_status: 'none',
      state: 'active',
      quota_bytes: env.billing.quotaBytes * DEFAULT_QUOTA_MULTIPLIER,
      created_at_ms: now,
      updated_at_ms: now,
      deleted_at_ms: null,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'unique_violation') {
      throw conflict('That email address cannot be used to sign up. Try signing in instead.');
    }
    throw error;
  }

  const url = verificationUrl(token);
  sendVerificationEmail(input.email, url);
  await recordAudit(store, {
    accountId,
    kind: 'account.created',
    detail: 'account created',
    clientHash: clientHash(request),
  });

  const session = await createSession(store, accountId, request);
  return jsonResponse(
    {
      accountId,
      // Shown in the interface only outside production, where no mail is sent.
      ...(env.isProduction ? {} : { verificationUrl: url }),
    },
    {
      status: 201,
      headers: { 'set-cookie': sessionCookieHeader(session.token, session.expiresAtMs) },
    },
  );
}

export async function handleLogin(request: Request): Promise<Response> {
  const env = getEnv();
  const client = clientHash(request);
  enforceRateLimit(`login:${client}`, env.rateLimits.auth);
  const input = await parseBody(request, loginRequest);
  const store = await getStore();

  const account = await store.findOne('accounts', { equals: { email: input.email } });
  const generic = unauthorized('That email address and password do not match.');

  if (!account || account.state !== 'active') {
    // Spend comparable time either way.
    await hashPassword(input.password).catch(() => undefined);
    throw generic;
  }

  const ok = await verifyPassword(input.password, {
    hash: account.password_hash,
    params: account.password_params,
  });
  if (!ok) {
    await recordAudit(store, {
      accountId: account.id,
      kind: 'account.login_failed',
      detail: 'wrong password',
      clientHash: client,
    });
    throw generic;
  }

  if (account.mfa_enabled) {
    if (!input.totp) {
      return jsonResponse(
        {
          error: {
            code: 'unauthorized',
            message: 'Enter the six-digit code from your authenticator app.',
            details: { mfaRequired: true },
          },
        },
        { status: 401 },
      );
    }
    const secret = account.mfa_secret_enc ? decryptSecret(account.mfa_secret_enc) : null;
    const codeOk = secret ? verifyTotp(secret, input.totp) : false;
    if (!codeOk) {
      await recordAudit(store, {
        accountId: account.id,
        kind: 'account.login_failed',
        detail: 'wrong second factor',
        clientHash: client,
      });
      throw unauthorized('That code is not right, or it has expired.');
    }
  }

  if (needsRehash({ hash: account.password_hash, params: account.password_params })) {
    const upgraded = await hashPassword(input.password);
    await store.update('accounts', account.id, {
      password_hash: upgraded.hash,
      password_params: upgraded.params,
      updated_at_ms: Date.now(),
    });
  }

  const session = await createSession(store, account.id, request);
  await recordAudit(store, {
    accountId: account.id,
    kind: 'account.login',
    detail: 'signed in',
    clientHash: client,
  });

  return jsonResponse(await sessionPayload(account.id), {
    headers: { 'set-cookie': sessionCookieHeader(session.token, session.expiresAtMs) },
  });
}

async function sessionPayload(accountId: string) {
  const store = await getStore();
  const account = await store.get('accounts', accountId);
  if (!account) throw unauthorized();
  const vault = await store.findOne('vaults', { equals: { account_id: accountId } });
  return {
    accountId: account.id,
    email: account.email,
    emailVerified: account.email_verified,
    mfaEnabled: account.mfa_enabled,
    vault: vault
      ? {
          id: vault.id,
          bundle: JSON.parse(vault.bundle_json) as unknown,
          assumedTimeZone: vault.assumed_time_zone,
        }
      : null,
  };
}

export async function handleSession(request: Request): Promise<Response> {
  const authenticated = await resolveSession(request);
  if (!authenticated) throw unauthorized();
  return jsonResponse(await sessionPayload(authenticated.accountId));
}

export async function handleLogout(request: Request): Promise<Response> {
  const authenticated = await resolveSession(request);
  if (authenticated) {
    const store = await getStore();
    await destroySession(store, authenticated.session.id);
    await recordAudit(store, {
      accountId: authenticated.accountId,
      kind: 'account.logout',
      detail: 'signed out',
      clientHash: clientHash(request),
    });
  }
  return emptyResponse({ headers: { 'set-cookie': clearedCookieHeader() } });
}

export async function handleVerifyEmail(request: Request): Promise<Response> {
  enforceRateLimit(`verify:${clientHash(request)}`, getEnv().rateLimits.auth);
  const input = await parseBody(request, verifyEmailRequest);
  const store = await getStore();
  const account = await store.findOne('accounts', {
    equals: { verification_token_hash: sha256Hex(input.token) },
  });
  if (!account) throw badRequest('That confirmation link is not valid. Ask for a new one.');
  await store.update('accounts', account.id, {
    email_verified: true,
    verification_token_hash: null,
    updated_at_ms: Date.now(),
  });
  return jsonResponse({ email: account.email, emailVerified: true });
}

export async function handleResendVerification(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const store = await getStore();
  if (account.email_verified) return jsonResponse({ emailVerified: true });
  const token = randomBytes(32).toString('base64url');
  await store.update('accounts', account.id, {
    verification_token_hash: sha256Hex(token),
    updated_at_ms: Date.now(),
  });
  const url = verificationUrl(token);
  sendVerificationEmail(account.email, url);
  return jsonResponse(
    getEnv().isProduction ? { sent: true } : { sent: true, verificationUrl: url },
  );
}

/* ---------------------------------------------------------------- TOTP ---- */

export async function handleMfaBegin(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const store = await getStore();
  if (account.mfa_enabled) throw conflict('Two-factor authentication is already on.');
  const secret = generateTotpSecret();
  await store.update('accounts', account.id, {
    mfa_secret_enc: encryptSecret(secret.secret),
    updated_at_ms: Date.now(),
  });
  return jsonResponse({
    secret: secret.base32,
    otpauthUrl: otpauthUrl(account.email, secret.base32),
  });
}

export async function handleMfaConfirm(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const input = await parseBody(request, enrollTotpRequest);
  const store = await getStore();
  if (!account.mfa_secret_enc)
    throw badRequest('Start setting up two-factor authentication first.');
  const secret = decryptSecret(account.mfa_secret_enc);
  if (!verifyTotp(secret, input.code)) {
    throw badRequest('That code is not right. Check your authenticator app and try again.');
  }
  const recoveryCodes = generateRecoveryCodes();
  await store.update('accounts', account.id, {
    mfa_enabled: true,
    mfa_recovery_hashes: JSON.stringify(recoveryCodes.map((code) => sha256Hex(code))),
    updated_at_ms: Date.now(),
  });
  await recordAudit(store, {
    accountId: account.id,
    kind: 'account.mfa_enabled',
    detail: 'TOTP enabled',
    clientHash: clientHash(request),
  });
  return jsonResponse({ recoveryCodes });
}
