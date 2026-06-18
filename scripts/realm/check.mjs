// Realm connectivity diagnostic.
//
// Run this to find out whether the environment can actually reach everything
// the Realm SPA needs. It does two things:
//   1. Probes each known Realm-family / dependency host directly.
//   2. Loads the sign-in page in Chromium and reports whether the login form
//      actually renders (it won't until the app's JS host is allowlisted).
//
// Usage:  node scripts/realm/check.mjs
//
// Exit code 0 = login form rendered (automation is unblocked).
// Exit code 1 = something the SPA needs is still blocked.

import { launchRealmBrowser, AUTH_URL, PROXY_SERVER } from './browser.mjs';

// Hosts the login + booking flow touches. "required" = needed for the core
// flow; the rest are nice-to-have (live updates, analytics, 3rd-party widgets).
//   - Login happens on sso.ampre.ca (Keycloak, server-rendered HTML).
//   - The portal/booking UI on app.realmmlp.ca needs collab-static (React SPA).
const HOSTS = [
  { url: 'https://app.realmmlp.ca/signin', required: true, note: 'app shell / OIDC callback' },
  { url: 'https://sso.ampre.ca/realms/trreb/.well-known/openid-configuration', required: true, note: 'Keycloak SSO (renders the LOGIN form)' },
  { url: 'https://collab-static.stratuscollab.com/react/build/polyfill.34e5619945386e639419.js', required: true, note: 'SPA JS bundles (portal/booking UI after login)' },
  { url: 'https://e-login.realmmlp.ca', required: false, note: 'auth endpoint' },
  { url: 'https://browser.realmmlp.ca', required: false, note: 'portal' },
  { url: 'https://realmlive-default-rtdb.firebaseio.com/.json', required: false, note: 'live updates' },
  { url: 'https://www.torontomls.net', required: false, note: 'TRREB MLS' },
];

// Booking happens in BrokerBay, after the Realm "Online Appt" handoff. These
// hosts gate whether the BrokerBay booking SPA actually RENDERS (it shows only
// a spinner until they're reachable). `booking: true` = needed to book.
//   - edge.brokerbay.com       — BrokerBay app shell + booking API
//   - storage.googleapis.com   — BrokerBay's JS bundles (brokerbay-app-static-prod)
//   - app.launchdarkly.com     — feature flags polled at bootstrap; spinner hangs without them
//   - ws-us2.pusher.com        — realtime channel for live slot availability (WebSocket)
const BOOKING_HOSTS = [
  { url: 'https://edge.brokerbay.com/', booking: true, note: 'BrokerBay app shell + booking API' },
  { url: 'https://storage.googleapis.com/brokerbay-app-static-prod/', booking: true, note: 'BrokerBay JS bundles' },
  { url: 'https://app.launchdarkly.com/sdk/evalx/611e55f0f793b82690974a02/contexts/eyJrZXkiOiJicm9rZXJiYXktYXBwIn0', booking: true, note: 'feature flags (gates render — spinner hangs without)' },
  { url: 'https://ws-us2.pusher.com/', booking: true, note: 'realtime slot availability (WebSocket)' },
];

// The egress proxy rejects un-allowlisted hosts with a body that starts
// "Host not in allowlist". That's the only reliable block signal — a host can
// be reachable and still answer 403 at the app level (e.g. a GCS bucket root).
const PROXY_BLOCK_MARKER = 'Host not in allowlist';

async function probe(url) {
  // Use a throwaway Chromium request context so probing goes through the same
  // proxy + cert path the real automation uses.
  const { browser, context } = await launchRealmBrowser();
  try {
    const res = await context.request.get(url, { timeout: 15000, ignoreHTTPSErrors: true }).catch((e) => ({ err: e.message }));
    if (res.err) return { label: `ERR ${res.err.split('\n')[0]}`, blocked: true };
    const body = await res.text().catch(() => '');
    const blocked = body.startsWith(PROXY_BLOCK_MARKER);
    return { label: String(res.status()), blocked };
  } finally {
    await browser.close();
  }
}

async function renderCheck() {
  // Load the Keycloak auth URL — that's where the actual login form lives. If
  // the username field renders, login automation is unblocked.
  const { browser, page } = await launchRealmBrowser();
  const failedHosts = new Set();
  page.on('requestfailed', (r) => {
    try { failedHosts.add(new URL(r.url()).host); } catch {}
  });
  try {
    await page.goto(AUTH_URL, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const hasUser = await page.$('#username, input[name="username"]');
    const hasPass = await page.$('#password, input[name="password"]');
    return { rendered: !!(hasUser && hasPass), hasUser: !!hasUser, hasPass: !!hasPass, failedHosts: [...failedHosts] };
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`Proxy: ${PROXY_SERVER || '(none — direct)'}\n`);

  console.log('Direct host probes:');
  let requiredBlocked = false;
  for (const h of HOSTS) {
    const { label, blocked } = await probe(h.url);
    if (blocked && h.required) requiredBlocked = true;
    const flag = !blocked ? 'OK    ' : (h.required ? 'BLOCK!' : 'block ');
    console.log(`  ${flag} ${label.padEnd(6)} ${h.note.padEnd(38)} ${h.url.replace(/^https:\/\//, '')}`);
  }

  console.log('\nBooking stage (BrokerBay) host probes:');
  let bookingBlocked = false;
  for (const h of BOOKING_HOSTS) {
    // Reachable means the proxy let it through; an app-level 4xx (Pusher's 4xx,
    // a GCS bucket-root 403) still counts as reachable.
    const { label, blocked } = await probe(h.url);
    if (blocked) bookingBlocked = true;
    const flag = blocked ? 'BLOCK!' : 'OK    ';
    console.log(`  ${flag} ${label.padEnd(6)} ${h.note.padEnd(48)} ${h.url.replace(/^https:\/\//, '').split('/')[0]}`);
  }

  console.log('\nKeycloak login form render check:');
  const r = await renderCheck();
  console.log(`  login form rendered: ${r.rendered ? 'YES' : 'NO'}  (username=${r.hasUser}, password=${r.hasPass})`);
  if (r.failedHosts.length) console.log(`  blocked while loading: ${r.failedHosts.join(', ')}`);

  const loginUnblocked = r.rendered && !requiredBlocked;
  console.log(`\nLogin: ${loginUnblocked ? 'UNBLOCKED — you can run book.mjs.' : 'BLOCKED — see BLOCK! rows above.'}`);
  console.log(`Booking (BrokerBay): ${bookingBlocked ? 'BLOCKED — allowlist the BLOCK! booking hosts above, then start a NEW session.' : 'all required hosts reachable.'}`);
  process.exit(loginUnblocked && !bookingBlocked ? 0 : 1);
})();
