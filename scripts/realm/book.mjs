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

import { launchRealmBrowser, SIGNIN_URL } from './browser.mjs';

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
  await page.goto(SIGNIN_URL, { waitUntil: 'load', timeout: 45000 });
  // Give the SPA a moment to render its login form.
  await page.waitForTimeout(4000);

  // Guard: if nothing rendered, the JS host is still blocked. Abort honestly.
  const inputCount = await page.$$eval('input', (els) => els.length);
  if (inputCount === 0) {
    throw new Error(
      'Login form did not render — the Realm SPA JS host is still blocked.\n' +
      'Run `node scripts/realm/check.mjs` and allowlist any BLOCK! hosts in the\n' +
      'environment network policy (currently: collab-static.stratuscollab.com).'
    );
  }

  // TODO(form-mapping): confirm these selectors against the live rendered form.
  // Realm/Stratus login is typically a username + password + submit flow.
  const userSel = 'input[type="text"], input[name*="user" i], input[id*="user" i]';
  const passSel = 'input[type="password"]';
  const submitSel = 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login")';

  await page.fill(userSel, username);
  await page.fill(passSel, password);
  await page.click(submitSel);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Blocker 3: MFA. If a one-time-code field appears, unattended booking is not
  // possible — bail rather than hang.
  const mfa = await page.$('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i]');
  if (mfa) {
    throw new Error('Realm prompted for an MFA/2FA code. Unattended booking is not possible until this is resolved (see docs/integrations.md).');
  }

  // Heuristic success check: the login inputs should be gone.
  const stillOnLogin = await page.$(passSel);
  if (stillOnLogin) {
    throw new Error('Login appears to have failed (still on the sign-in page). Check REALM_USERNAME / REALM_PASSWORD.');
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
