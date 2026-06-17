// Shared Chromium launcher for Realm (PropTx) automation.
//
// Centralises the one thing that is fiddly in the Claude Code on the web
// remote environment: outbound traffic goes through a TLS-intercepting proxy,
// so Chromium must be (a) pointed at that proxy and (b) told to accept the
// proxy's CA. curl/Node pick the proxy up from env automatically; Chromium
// does not, which is why a naive `chromium.launch()` fails with
// ERR_TOO_MANY_RETRIES / ERR_CERT_AUTHORITY_INVALID against app.realmmlp.ca.
//
// Everything here is environment-driven so nothing secret or host-specific is
// committed. See docs/integrations.md for the current connectivity status.

// Playwright is installed globally in this image, not in the project, so a bare
// `import 'playwright'` may not resolve. Try the bare specifier first, then fall
// back to the known global install path. Keeps the scripts install-free.
async function loadChromium() {
  const pick = (m) => m.chromium || (m.default && m.default.chromium);
  try {
    const c = pick(await import('playwright'));
    if (c) return c;
  } catch {
    // fall through to the global install
  }
  const globalPath = process.env.REALM_PLAYWRIGHT_PATH ||
    '/opt/node22/lib/node_modules/playwright/index.js';
  return pick(await import(globalPath));
}
const chromium = await loadChromium();

// Resolve the proxy the same way the rest of the environment does.
export const PROXY_SERVER =
  process.env.HTTPS_PROXY || process.env.https_proxy || null;

// Playwright is installed globally in this image; the browser binary lives
// under PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers) rather than the per-project
// cache. Allow an override but fall back to the known-good path.
const CHROME_PATH =
  process.env.REALM_CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Launch Chromium wired up for the proxied environment and return
 * { browser, context, page }. Caller is responsible for browser.close().
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless=true]
 */
export async function launchRealmBrowser({ headless = true } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless,
    args: ['--no-sandbox'],
    ...(PROXY_SERVER ? { proxy: { server: PROXY_SERVER } } : {}),
  });

  // ignoreHTTPSErrors is required because the proxy re-signs TLS with a CA
  // Chromium does not trust. NODE_EXTRA_CA_CERTS covers Node but not Chromium.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  return { browser, context, page };
}

export const SIGNIN_URL = process.env.REALM_SIGNIN_URL || 'https://app.realmmlp.ca/signin';
