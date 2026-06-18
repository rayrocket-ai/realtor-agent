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
 * @param {string}  [opts.storageState]  path to a Playwright storageState JSON
 *   (cookies + localStorage) to restore an authenticated session.
 */
export async function launchRealmBrowser({ headless = true, storageState = null } = {}) {
  // REALM_HEADED=1 forces a headed browser (run under xvfb-run on a headless
  // host). Headed Chromium can clear automation/reCAPTCHA checks that headless
  // trips, including BrokerBay's submit-time "logged out" rejection.
  const runHeadless = process.env.REALM_HEADED === '1' ? false : headless;
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: runHeadless,
    // --disable-blink-features=AutomationControlled reduces automation
    // fingerprinting (hides navigator.webdriver). NOTE: this alone did NOT clear
    // BrokerBay's submit-time "You have been logged out" rejection in the remote
    // headless environment — see submitBooking() in book.mjs.
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    ...(PROXY_SERVER ? { proxy: { server: PROXY_SERVER } } : {}),
  });

  // ignoreHTTPSErrors is required because the proxy re-signs TLS with a CA
  // Chromium does not trust. NODE_EXTRA_CA_CERTS covers Node but not Chromium.
  // A tall viewport keeps the whole BrokerBay booking form — including the sticky
  // "Book Showing" submit button in the header — on-screen at once, so the submit
  // can be clicked with a real (trusted) click without scrolling the slot list
  // (which would re-render and de-select the chosen time).
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1400 },
    ...(storageState ? { storageState } : {}),
  });
  // Playwright still sets navigator.webdriver=true; null it out before any page
  // script runs to reduce automation fingerprinting. (Hardening only — it did not
  // by itself clear BrokerBay's submit-time "logged out" rejection.)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  return { browser, context, page };
}

export const SIGNIN_URL = process.env.REALM_SIGNIN_URL || 'https://app.realmmlp.ca/signin';

// The "Member" button on the sign-in page redirects to TRREB's Keycloak SSO
// (sso.ampre.ca) via this OpenID Connect auth URL. The login form lives there —
// it is server-rendered Keycloak HTML, NOT the React SPA, so it renders without
// collab-static.stratuscollab.com. On success Keycloak redirects back to the
// redirect_uri with a code and app.realmmlp.ca establishes the session.
export const AUTH_URL = process.env.REALM_AUTH_URL ||
  'https://sso.ampre.ca/realms/trreb/protocol/openid-connect/auth' +
  '?client_id=app.realmmlp.ca&scope=openid%20profile%20email&response_type=code' +
  '&redirect_uri=https%3A%2F%2Fapp.realmmlp.ca%2Fauth%2Famp%2Fcallback';
