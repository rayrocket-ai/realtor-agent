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

import { launchRealmBrowser, SIGNIN_URL, PROXY_SERVER } from './browser.mjs';

// Hosts the SPA references. "required" = needed for login/booking core flow;
// the rest are nice-to-have (live updates, analytics, 3rd-party widgets).
const HOSTS = [
  { url: 'https://app.realmmlp.ca/signin', required: true, note: 'app shell' },
  { url: 'https://e-login.realmmlp.ca', required: true, note: 'auth endpoint' },
  { url: 'https://browser.realmmlp.ca', required: true, note: 'portal' },
  { url: 'https://collab-static.stratuscollab.com/react/build/polyfill.34e5619945386e639419.js', required: true, note: 'SPA JS bundles (renders the login form)' },
  { url: 'https://realmlive-default-rtdb.firebaseio.com/.json', required: false, note: 'live updates' },
  { url: 'https://app.trenlii.com', required: false, note: 'embedded widget' },
  { url: 'https://verifiedtransactions.realmmlp.com', required: false, note: 'transactions' },
  { url: 'https://www.torontomls.net', required: false, note: 'TRREB MLS' },
];

async function probe(url) {
  // Use a throwaway Chromium request context so probing goes through the same
  // proxy + cert path the real automation uses.
  const { browser, context } = await launchRealmBrowser();
  try {
    const res = await context.request.get(url, { timeout: 15000, ignoreHTTPSErrors: true }).catch((e) => ({ err: e.message }));
    return res.err ? `ERR ${res.err.split('\n')[0]}` : String(res.status());
  } finally {
    await browser.close();
  }
}

async function renderCheck() {
  const { browser, page } = await launchRealmBrowser();
  const failedHosts = new Set();
  page.on('requestfailed', (r) => {
    try { failedHosts.add(new URL(r.url()).host); } catch {}
  });
  try {
    await page.goto(SIGNIN_URL, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const inputs = await page.$$eval('input', (els) => els.length);
    const buttons = await page.$$eval('button', (els) => els.length);
    return { rendered: inputs > 0 || buttons > 0, inputs, buttons, failedHosts: [...failedHosts] };
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`Proxy: ${PROXY_SERVER || '(none — direct)'}\n`);

  console.log('Direct host probes:');
  let requiredBlocked = false;
  for (const h of HOSTS) {
    const status = await probe(h.url);
    const ok = /^(2|3)\d\d$/.test(status);
    if (!ok && h.required) requiredBlocked = true;
    const flag = ok ? 'OK    ' : (h.required ? 'BLOCK!' : 'block ');
    console.log(`  ${flag} ${status.padEnd(6)} ${h.note.padEnd(38)} ${h.url.replace(/^https:\/\//, '')}`);
  }

  console.log('\nLogin form render check:');
  const r = await renderCheck();
  console.log(`  form rendered: ${r.rendered ? 'YES' : 'NO'}  (inputs=${r.inputs}, buttons=${r.buttons})`);
  if (r.failedHosts.length) console.log(`  blocked while loading: ${r.failedHosts.join(', ')}`);

  const unblocked = r.rendered && !requiredBlocked;
  console.log(`\nVerdict: ${unblocked ? 'Realm automation is UNBLOCKED.' : 'Still blocked — see BLOCK! rows above. Allowlist those hosts in the environment network policy.'}`);
  process.exit(unblocked ? 0 : 1);
})();
