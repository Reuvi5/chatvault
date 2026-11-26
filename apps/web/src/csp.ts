import { THEME_BOOTSTRAP_SHA256 } from '@/themeBootstrap';

/**
 * The Content-Security-Policy.
 *
 * This is the main mitigation for the risk the plan is explicit about: a hosted
 * web app cannot protect a person from a compromised frontend deployment, but a
 * tight policy makes injected third-party script much harder to run, and there
 * is no third-party script in this app at all.
 *
 * `script-src` allows exactly three things: our own bundles, by per-request
 * nonce; whatever those bundles load themselves, via `strict-dynamic`; and the
 * one inline theme bootstrap, by hash. `blob:` is allowed for images and media
 * because decrypted attachments are rendered from in-memory blobs; it is not a
 * network origin.
 *
 * ## The three things that have to line up
 *
 * This was broken in a way that no test caught and that only showed up in a
 * browser, so it is worth writing down. A policy this strict needs all three:
 *
 *  1. The nonce goes on the *request* headers under `content-security-policy`.
 *     That is the only place the framework looks when it decides whether to
 *     stamp `nonce=` onto the script tags it emits. Setting the policy on the
 *     response alone leaves every script un-nonced.
 *  2. Pages have to be rendered per request. A prerendered page's HTML is
 *     written once at build time and cannot carry a nonce minted later, so the
 *     root layout opts out of prerendering. This costs little here: every page
 *     is a client component behind a passphrase, with nothing to cache.
 *  3. `strict-dynamic` makes the browser *disregard* `'self'`. So if either of
 *     the above is missing, the failure is not a warning — every script is
 *     refused and the app degrades to dead HTML.
 */
export function contentSecurityPolicy({
  nonce,
  isDevelopment,
}: {
  nonce: string;
  isDevelopment: boolean;
}): string {
  return [
    "default-src 'self'",
    /*
     * `wasm-unsafe-eval` is not optional: Argon2id runs in WebAssembly, and
     * compiling a module counts as evaluation. Without it the browser refuses
     * to instantiate the hash, which means no key derivation, which means the
     * product does not work at all. It permits WebAssembly compilation and
     * nothing else — in particular it does not re-admit `eval()` on JavaScript.
     *
     * Turbopack's hot reloader additionally compiles JavaScript in the browser
     * during development, which is what the broader `unsafe-eval` is for.
     */
    `script-src 'self' 'nonce-${nonce}' '${THEME_BOOTSTRAP_SHA256}' 'strict-dynamic' 'wasm-unsafe-eval'${
      isDevelopment ? " 'unsafe-eval'" : ''
    }`,
    // Tailwind emits inline style attributes, and components set CSS variables
    // inline. Style injection cannot execute script.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    // Development needs the websocket the reloader talks over.
    `connect-src 'self'${isDevelopment ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** The directives of a policy string, keyed by name. */
export function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/u);
    if (name) directives.set(name, values);
  }
  return directives;
}
