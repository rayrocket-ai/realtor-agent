import type { Locator, Page } from "playwright";
import { config } from "../config.js";
import { waitForOtp } from "./otp.js";
import { NeedsLoginError, PortalChangedError } from "./types.js";

/**
 * Shared PropTx / TRREB single-sign-on (Keycloak at sso.ampre.ca).
 *
 * Both entry points funnel here once a sign-in form appears:
 *   - REALM / TorontoMLS  (src/booking/realm.ts)
 *   - BrokerBay's "PropTx" IdP button  (src/booking/brokerbay-direct.ts)
 *
 * A numeric REALM_USERNAME (a TRREB member number) uses the User ID + PIN
 * path; the SMS authorization code is read automatically by waitForOtp
 * (HighLevel / Gmail) or from the dashboard drop box.
 *
 * The portals ship UI changes without notice, so every step tries several
 * selectors and fails with a typed, non-retryable error instead of guessing.
 */

const TFA_MARKERS =
  /verification code|authorization code|one[- ]time (code|password)|two[- ]?factor|authenticat(or|ion) (app|code)|enter the (code|authorization)|security code|code we sent/i;
const CAPTCHA_MARKERS = /captcha|are you a robot|unusual traffic/i;

export async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/**
 * Wait until a redirect chain settles: same URL twice running with a non-empty
 * body. SSO hops through several interstitials (and the proxy bridge replays
 * redirects as tiny script pages), so one networkidle isn't enough.
 */
export async function settleNavigation(page: Page, maxSeconds = 25): Promise<void> {
  let prevUrl = "";
  for (let i = 0; i < maxSeconds; i++) {
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const url = page.url();
    const body = ((await page.textContent("body").catch(() => "")) ?? "").trim();
    if (body.length > 0 && url === prevUrl) return;
    prevUrl = url;
    await page.waitForTimeout(1000);
  }
}

/** True if a username/password sign-in form is currently on screen. */
export async function onLoginForm(page: Page): Promise<boolean> {
  const login = page.locator(
    'input[type="password"], input[name*="user" i], input[id*="user" i], input[type="email"]',
  );
  return login.first().isVisible().catch(() => false);
}

/**
 * Complete whatever PropTx sign-in form is on screen (username → PIN → OTP).
 * No-op-safe to call when already signed in — checks `onLoginForm` first.
 */
export async function completePropTxLogin(page: Page): Promise<void> {
  const c = config();
  if (!(await onLoginForm(page))) return;

  if (!c.REALM_USERNAME || !c.REALM_PASSWORD) {
    throw new NeedsLoginError("realm", "REALM_USERNAME / REALM_PASSWORD not configured");
  }

  // A numeric board ID signs in through the "User ID" path, not the email form.
  if (!c.REALM_USERNAME.includes("@")) {
    const userIdBtn = await firstVisible(page, [
      'button:has-text("User ID")',
      'a:has-text("User ID")',
      'button:has-text("Member ID")',
      'a:has-text("Member ID")',
    ]);
    if (userIdBtn) {
      await userIdBtn.click();
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    }
  }

  const passField = page.locator('input[type="password"]').first();
  const user = await firstVisible(page, [
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ]);
  if (user) {
    await user.fill(c.REALM_USERNAME);
    // Two-step logins (username → Next → password): advance if the password
    // field isn't on this screen yet.
    if (!(await passField.isVisible().catch(() => false))) {
      const next = await firstVisible(page, [
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button[type="submit"]',
      ]);
      if (next) await next.click();
      else await user.press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    }
  }

  const pass = page.locator('input[type="password"]').first();
  if (!(await pass.isVisible().catch(() => false))) {
    throw new PortalChangedError("proptx-login", "no password/PIN field found on the sign-in page");
  }
  await pass.fill(c.REALM_PASSWORD);
  const submit = await firstVisible(page, [
    "#kc-login",
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
  ]);
  if (submit) await submit.click();
  else await pass.press("Enter");

  await settleNavigation(page);

  const loginStarted = new Date(Date.now() - 30_000); // OTP may land just before we look
  const body = (await page.textContent("body").catch(() => "")) ?? "";
  if (CAPTCHA_MARKERS.test(body)) {
    throw new NeedsLoginError("realm", "PropTx is showing a captcha — complete the sign-in once via `npm run booking:login`");
  }
  if (TFA_MARKERS.test(body)) {
    await handleOtpChallenge(page, loginStarted);
  }
  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
    throw new NeedsLoginError("realm", "sign-in did not go through (User ID / PIN rejected?)");
  }
}

/** Fill PropTx's one-time authorization-code screen. */
async function handleOtpChallenge(page: Page, since: Date): Promise<void> {
  // If a delivery choice is shown, pick send — exact text only so a substring
  // match never fires "Resend" and burns a second code.
  const send = await firstVisible(page, [
    'button:text-is("Send code")',
    'button:text-is("Send Code")',
    'button:text-is("Text me")',
  ]);
  if (send) {
    await send.click();
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  }

  const code = await waitForOtp(since);
  if (!code) {
    throw new NeedsLoginError(
      "realm",
      "PropTx asked for a verification code and none arrived in time (HighLevel / Gmail / dashboard box)",
    );
  }

  const codeInput = await firstVisible(page, [
    'input[autocomplete="one-time-code"]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[name*="otp" i]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="text"]',
  ]);
  if (!codeInput) throw new PortalChangedError("proptx-otp", "couldn't find the verification-code field");
  await codeInput.fill(code);

  const verify = await firstVisible(page, [
    "#kc-login",
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Continue")',
  ]);
  if (verify) await verify.click();
  else await codeInput.press("Enter");
  await settleNavigation(page);

  const after = (await page.textContent("body").catch(() => "")) ?? "";
  if (TFA_MARKERS.test(after) && (await codeInput.isVisible().catch(() => false))) {
    throw new NeedsLoginError("realm", "the verification code was rejected");
  }
}
