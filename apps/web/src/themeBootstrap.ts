/**
 * The one inline script in the app.
 *
 * It applies a saved light/dark choice before the first paint, so reloading does
 * not flash the wrong theme. Everything else about the interface is rendered or
 * hydrated normally.
 *
 * It is allowed through the Content-Security-Policy by **hash**, not by a
 * nonce. A nonce would mean reading a per-request header in the root layout,
 * which would make every page in the app dynamically rendered for the sake of
 * one line of script. A hash is a constant, so the pages that can be static stay
 * static — and `tests/csp.test.ts` recomputes the digest and fails if the script
 * and the policy ever drift apart.
 */
export const THEME_STORAGE_KEY = 'chatvault-theme';

export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

/**
 * Base64 SHA-256 of `THEME_BOOTSTRAP`, as the CSP `script-src` needs it.
 * Keep in step with the script above; the test will tell you if it is not.
 */
export const THEME_BOOTSTRAP_SHA256 = 'sha256-0qcXDgBAkk3Zocd2z/PpRjbB0NlEVhbXUWo1LMHR3Ps=';
