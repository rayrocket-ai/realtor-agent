// Reusable Realm (PropTx) login via TRREB Keycloak SSO, with HighLevel SMS MFA.
//
// Extracted from book.mjs so the booking flow, the BrokerBay capture tool, and
// any future automation share one verified login path. Credentials come only
// from env (REALM_USERNAME / REALM_PASSWORD); the OTP is read back from
// HighLevel by otp_highlevel.mjs.

import { launchRealmBrowser, AUTH_URL } from './browser.mjs';
import { getLatestOtp } from './otp_highlevel.mjs';

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Set it in the environment settings; do not hard-code credentials.`);
  return v;
}

/**
 * Drive the Keycloak login form on an existing page, including the SMS MFA step.
 * Throws loudly if the form doesn't render, credentials are rejected, or the
 * MFA code is rejected. Returns nothing; on success the page is on the Realm app.
 */
export async function login(page, { username, password } = {}) {
  username = username || requireEnv('REALM_USERNAME');
  password = password || requireEnv('REALM_PASSWORD');

  await page.goto(AUTH_URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(2000);

  const userField = await page.waitForSelector('#username, input[name="username"]', { timeout: 10000 }).catch(() => null);
  if (!userField) {
    throw new Error(
      'Keycloak login form did not render — sso.ampre.ca is likely still blocked.\n' +
      'Run `node scripts/realm/check.mjs` and allowlist the BLOCK! hosts in the\n' +
      'environment network policy.'
    );
  }

  await page.fill('#username, input[name="username"]', username);
  await page.fill('#password, input[name="password"]', password);
  // Record submit time so OTP polling only accepts codes texted after this point.
  const submittedAt = Date.now();
  await page.click('#kc-login, input[type="submit"], button[type="submit"]');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const errEl = await page.$('#input-error, .alert-error, .pf-c-alert__title, .kc-feedback-text');
  if (errEl) {
    const msg = (await errEl.innerText().catch(() => '')) || 'invalid credentials';
    throw new Error(`Keycloak rejected the login: ${msg.trim()}. Check REALM_USERNAME / REALM_PASSWORD.`);
  }

  // MFA: Keycloak shows an OTP field. Fetch the SMS code from HighLevel.
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

  if (/sso\.ampre\.ca/.test(page.url())) {
    throw new Error(`Login did not complete — still on the SSO host (${page.url()}).`);
  }
}

/**
 * Launch a browser, log in, and return { browser, context, page } on the Realm
 * app. Caller must browser.close(). Pass { statePath } to persist the
 * authenticated storage state for faster subsequent runs.
 */
export async function loginAndOpen({ headless = true, statePath = null } = {}) {
  const { browser, context, page } = await launchRealmBrowser({ headless });
  await login(page);
  if (statePath) await context.storageState({ path: statePath });
  return { browser, context, page };
}
