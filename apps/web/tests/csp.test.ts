/**
 * The theme bootstrap is the only inline script in the app, and the
 * Content-Security-Policy allows it by hash. If the script changes and the hash
 * does not, the browser silently refuses to run it and the theme flashes on
 * every reload — a failure nobody would notice for weeks. So: recompute.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { THEME_BOOTSTRAP, THEME_BOOTSTRAP_SHA256, THEME_STORAGE_KEY } from '@/themeBootstrap';
import { contentSecurityPolicy, parsePolicy } from '@/csp';

function digestOf(script: string): string {
  return `sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}`;
}

describe('the inline theme script', () => {
  it('matches the hash the policy allows', () => {
    expect(THEME_BOOTSTRAP_SHA256).toBe(digestOf(THEME_BOOTSTRAP));
  });

  it('does only what it claims to', () => {
    // No network, no eval, no document.write: it reads one key and sets one
    // attribute. Worth asserting, because this script is exempt from the nonce.
    expect(THEME_BOOTSTRAP).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOTSTRAP).toContain('setAttribute');
    for (const forbidden of ['fetch(', 'eval(', 'XMLHttpRequest', 'document.write', 'import(']) {
      expect(THEME_BOOTSTRAP).not.toContain(forbidden);
    }
    // It must not throw in a browser that refuses storage (private windows).
    expect(THEME_BOOTSTRAP).toContain('catch');
  });

  it('only ever applies a known theme value', () => {
    expect(THEME_BOOTSTRAP).toContain("t==='light'");
    expect(THEME_BOOTSTRAP).toContain("t==='dark'");
  });
});

describe('the policy itself', () => {
  const production = parsePolicy(contentSecurityPolicy({ nonce: 'NONCE', isDevelopment: false }));
  const development = parsePolicy(contentSecurityPolicy({ nonce: 'NONCE', isDevelopment: true }));

  it('admits our own scripts by nonce', () => {
    // The regression this guards against: a policy with 'strict-dynamic' tells
    // the browser to disregard 'self', so if the nonce never reaches the script
    // tags, every script is refused and the app becomes dead HTML. Two other
    // things have to hold for that not to happen, and they are asserted below
    // and in layout.test.ts.
    expect(production.get('script-src')).toContain("'nonce-NONCE'");
    expect(production.get('script-src')).toContain("'strict-dynamic'");
    expect(development.get('script-src')).toContain("'nonce-NONCE'");
  });

  it('lets WebAssembly compile, without re-admitting eval', () => {
    // Argon2id is WebAssembly. Without this the key derivation that the whole
    // product rests on cannot even be instantiated — which is how it shipped
    // until someone opened it in a browser.
    expect(production.get('script-src')).toContain("'wasm-unsafe-eval'");
    expect(development.get('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it('never allows arbitrary inline script, in either mode', () => {
    for (const directives of [production, development]) {
      expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    }
    expect(production.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('allows the theme bootstrap by hash, and nothing else inline', () => {
    const scriptSrc = production.get('script-src') ?? [];
    const hashes = scriptSrc.filter((value) => value.startsWith("'sha"));
    expect(hashes).toEqual([`'${THEME_BOOTSTRAP_SHA256}'`]);
  });

  it('keeps the rest of the surface closed', () => {
    expect(production.get('object-src')).toEqual(["'none'"]);
    expect(production.get('base-uri')).toEqual(["'none'"]);
    expect(production.get('frame-ancestors')).toEqual(["'none'"]);
    expect(production.get('default-src')).toEqual(["'self'"]);
    // Decrypted attachments are rendered from in-memory blobs, never fetched.
    expect(production.get('img-src')).toContain('blob:');
    expect(production.get('media-src')).toContain('blob:');
    expect(production.get('connect-src')).toEqual(["'self'"]);
  });

  it('upgrades insecure requests in production only', () => {
    expect(production.has('upgrade-insecure-requests')).toBe(true);
    expect(development.has('upgrade-insecure-requests')).toBe(false);
  });

  it('mints a different nonce per request', () => {
    const first = contentSecurityPolicy({ nonce: 'a', isDevelopment: false });
    const second = contentSecurityPolicy({ nonce: 'b', isDevelopment: false });
    expect(first).not.toBe(second);
  });
});

describe('the root layout', () => {
  it('opts out of prerendering, so the nonce can reach the HTML', async () => {
    // A prerendered page is written once at build time and cannot carry a
    // per-request nonce. This is the second of the three conditions in csp.ts.
    const source = await readFile(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
    expect(source).toContain("export const dynamic = 'force-dynamic'");
  });
});
