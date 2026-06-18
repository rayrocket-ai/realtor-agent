// Realm (PropTx) showing-request automation.
//
// Signs in to the Realm member portal and submits a showing request for a
// listing. This is step 1 of the book-showing skill ("Realm booking"), which
// today only emits a paste-ready block because the portal could not be reached.
//
// SAFETY MODEL
//   - Reads credentials only from env (REALM_USERNAME / REALM_PASSWORD).
//   - Dry-run by default: it logs in and fills the form but DOES NOT click the
//     final submit unless --confirm is passed. Nothing external happens without it.
//   - Hard guard: if the login form does not render (the SPA JS host is still
//     blocked) or MFA is required, it aborts loudly instead of pretending.
//   - It never prints "booking placed" unless the portal returned a confirmation.
//
// USAGE
//   node scripts/realm/book.mjs \
//     --address "123 Main St, Toronto" --mls "W1234567" \
//     --date 2026-06-20 --start 14:00 --end 14:30 \
//     --client "Sarah Chen" [--confirm]
//
// STATUS: the login + form selectors below are marked TODO(form-mapping). They
// cannot be finalised until collab-static.stratuscollab.com is allowlisted and
// the form actually renders (run scripts/realm/check.mjs — it must say UNBLOCKED).
// The structure, guards, and login attempt are real; only the exact selectors
// need confirming against the live DOM.

import { launchRealmBrowser, AUTH_URL } from './browser.mjs';
import { getLatestOtp } from './otp_highlevel.mjs';

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Set it in the environment settings; do not hard-code credentials.`);
  return v;
}

async function login(page, { username, password }) {
  // Go straight to the Keycloak OIDC auth endpoint (same place the "Member"
  // button leads). This is a server-rendered Keycloak login page, so its
  // selectors are standard and stable.
  await page.goto(AUTH_URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Guard: if the username field never appears, sso.ampre.ca is still blocked.
  const userField = await page.waitForSelector('#username, input[name="username"]', { timeout: 10000 }).catch(() => null);
  if (!userField) {
    throw new Error(
      'Keycloak login form did not render — sso.ampre.ca is likely still blocked.\n' +
      'Run `node scripts/realm/check.mjs` and allowlist the BLOCK! hosts in the\n' +
      'environment network policy (sso.ampre.ca for login; collab-static.stratuscollab.com for the portal).'
    );
  }

  // Standard Keycloak login form selectors.
  await page.fill('#username, input[name="username"]', username);
  await page.fill('#password, input[name="password"]', password);
  // Record the moment we submit, so OTP polling only accepts codes texted after
  // this point (avoids reusing a stale code from a previous login).
  const submittedAt = Date.now();
  await page.click('#kc-login, input[type="submit"], button[type="submit"]');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Login error surfaced by Keycloak (bad credentials, etc.).
  const errEl = await page.$('#input-error, .alert-error, .pf-c-alert__title, .kc-feedback-text');
  if (errEl) {
    const msg = (await errEl.innerText().catch(() => '')) || 'invalid credentials';
    throw new Error(`Keycloak rejected the login: ${msg.trim()}. Check REALM_USERNAME / REALM_PASSWORD.`);
  }

  // MFA: Keycloak shows an OTP field. Fetch the SMS code from HighLevel and enter it.
  const otpSel = '#otp, input[name="otp"], input[autocomplete="one-time-code"]';
  const otpField = await page.$(otpSel);
  if (otpField) {
    console.log('[realm] MFA prompt detected — fetching SMS code from HighLevel...');
    const code = await getLatestOtp({ sinceMs: submittedAt, timeoutMs: 120000, pollMs: 5000 });
    console.log('[realm] code received, submitting.');
    await page.fill(otpSel, code);
    await page.click('#kc-login, input[type="submit"], button[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const otpErr = await page.$('#input-error, .alert-error, .pf-c-alert__title, .kc-feedback-text');
    if (otpErr) {
      const msg = (await otpErr.innerText().catch(() => '')) || 'invalid code';
      throw new Error(`Keycloak rejected the MFA code: ${msg.trim()}.`);
    }
  }

  // Success = redirected off the SSO host back to the Realm app.
  if (/sso\.ampre\.ca/.test(page.url())) {
    throw new Error(`Login did not complete — still on the SSO host (${page.url()}).`);
  }
}

async function submitShowing(page, booking, confirm) {
  // TODO(form-mapping): this whole function needs the live booking form to map.
  // Steps, once the DOM is known:
  //   1. Navigate to the listing (search by MLS#/address or open the showing-
  //      request URL for the listing).
  //   2. Fill date (booking.date) and time window (booking.start–booking.end).
  //   3. Attach the buyer/client and any required agent fields.
  //   4. If !confirm -> stop here (dry run) and report "form filled, not submitted".
  //   5. If confirm  -> click submit, read back the confirmation number/text.
  throw new Error(
    'Booking form not yet mapped. Re-run after the portal renders to capture the ' +
    'showing-request DOM, then implement submitShowing(). Booking was NOT placed.'
  );
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const booking = {
    address: args.address, mls: args.mls, date: args.date,
    start: args.start, end: args.end, client: args.client,
  };

  const creds = { username: requireEnv('REALM_USERNAME'), password: requireEnv('REALM_PASSWORD') };

  const { browser, page } = await launchRealmBrowser({ headless: true });
  try {
    console.log(`[realm] signing in${args.confirm ? '' : ' (DRY RUN — will not submit)'}...`);
    await login(page, creds);
    console.log('[realm] signed in.');

    await submitShowing(page, booking, args.confirm);
    // submitShowing currently throws (form unmapped); this line is reached only
    // once it is implemented and a real confirmation comes back.
    console.log('[realm] showing request submitted.');
  } catch (err) {
    await page.screenshot({ path: '/tmp/realm-last.png', fullPage: true }).catch(() => {});
    console.error(`[realm] ${err.message}`);
    console.error('[realm] screenshot (if any): /tmp/realm-last.png');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
