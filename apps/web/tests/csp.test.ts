/**
 * The theme bootstrap is the only inline script in the app, and the
 * Content-Security-Policy allows it by hash. If the script changes and the hash
 * does not, the browser silently refuses to run it and the theme flashes on
 * every reload — a failure nobody would notice for weeks. So: recompute.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { THEME_BOOTSTRAP, THEME_BOOTSTRAP_SHA256, THEME_STORAGE_KEY } from '@/themeBootstrap';

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
