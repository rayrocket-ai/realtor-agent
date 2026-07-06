import type { BrowserContext, Locator, Page } from "playwright";
import { config } from "../config.js";
import { waitForOtp } from "./otp.js";
import {
  AmbiguousListingError,
  ListingNotFoundError,
  NeedsLoginError,
  PortalChangedError,
  type ListingMatch,
} from "./types.js";

/**
 * REALM (PropTx MLS) automation: sign in, find the listing by address, and
 * follow its "Book Showing" button into BrokerBay.
 *
 * REALM ships UI updates without notice, so every step tries several selector
 * strategies and fails with a PortalChangedError (plus an error screenshot,
 * taken by the caller) instead of guessing.
 */

const TFA_MARKERS =
  /verification code|authorization code|one[- ]time (code|password)|two[- ]?factor|authenticat(or|ion) (app|code)|enter the (code|authorization)|security code|code we sent/i;
const CAPTCHA_MARKERS = /captcha|are you a robot|unusual traffic/i;

function looksLikeLoginPage(page: Page): Locator {
  return page.locator('input[type="password"], input[name*="user" i], input[id*="user" i], input[type="email"]');
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/** Navigate to REALM and sign in if a login form appears. Idempotent. */
export async function ensureRealmLogin(page: Page): Promise<void> {
  const c = config();
  await page.goto(c.REALM_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);

  // Already signed in from the persistent profile?
  const passField = page.locator('input[type="password"]').first();
  const hasLogin = await passField.isVisible().catch(() => false);
  const hasUserOnly = !hasLogin && (await looksLikeLoginPage(page).first().isVisible().catch(() => false));
  if (!hasLogin && !hasUserOnly) return;

  if (!c.REALM_USERNAME || !c.REALM_PASSWORD) {
    throw new NeedsLoginError("realm", "REALM_USERNAME / REALM_PASSWORD not configured");
  }

  // A numeric board ID (e.g. TRREB member number) signs in through the
  // "User ID" SSO path, not the email form. Click over to it if offered.
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

  const user = await firstVisible(page, [
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ]);
  if (user) {
    await user.fill(c.REALM_USERNAME);
    // Two-step logins (username → Next → password): press Enter / Next if the
    // password field isn't on this screen yet.
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
    throw new PortalChangedError("realm-login", "no password field found on the sign-in page");
  }
  await pass.fill(c.REALM_PASSWORD);
  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
  ]);
  if (submit) await submit.click();
  else await pass.press("Enter");

  await settleNavigation(page);

  const loginStarted = new Date(Date.now() - 30_000); // OTP may arrive a moment before we look
  const body = (await page.textContent("body").catch(() => "")) ?? "";
  if (CAPTCHA_MARKERS.test(body)) {
    throw new NeedsLoginError("realm", "REALM is showing a captcha — complete the sign-in once via `npm run booking:login`");
  }
  if (TFA_MARKERS.test(body)) {
    await handleOtpChallenge(page, loginStarted);
  }
  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
    throw new NeedsLoginError("realm", "sign-in did not go through (password rejected?)");
  }
}

/**
 * Wait until a redirect chain fully settles: same URL twice in a row with a
 * non-empty body. SSO logins hop through several interstitials (and the proxy
 * bridge replays redirects as tiny script pages), so a single networkidle
 * isn't enough.
 */
async function settleNavigation(page: Page, maxSeconds = 25): Promise<void> {
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

/** Fill REALM's one-time-code screen using Gmail / the dashboard drop box. */
async function handleOtpChallenge(page: Page, since: Date): Promise<void> {
  // Some flows make you pick SMS/email delivery first. Exact text matches only —
  // a substring match would hit "Resend" and fire a duplicate code.
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
      "REALM asked for a verification code and none arrived in time (Gmail / dashboard box)",
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
  if (!codeInput) throw new PortalChangedError("realm-otp", "couldn't find the verification-code field");
  await codeInput.fill(code);

  const verify = await firstVisible(page, [
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

function normalizeAddress(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(
      /\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|court|crt|ct|crescent|cres|lane|ln|way|circle|cir|place|pl|trail|trl|unit|apt|suite)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function addressesMatch(query: string, candidate: string): boolean {
  const q = normalizeAddress(query);
  const c = normalizeAddress(candidate);
  if (!q || !c) return false;
  if (c.includes(q) || q.includes(c)) return true;
  // Street number + first street token is usually enough to disambiguate.
  const qTokens = q.split(" ");
  return qTokens.length >= 2 && c.includes(qTokens.slice(0, 2).join(" "));
}

/** TRREB-style MLS numbers: letter + 7-8 digits (W1234567, C5678901…). */
export function extractMlsNumber(text: string): string | null {
  const m = /\b([A-Z]\d{7,8})\b/.exec(text);
  return m ? m[1]! : null;
}

/**
 * Search REALM for the address and open the matching listing's detail page.
 * Returns what was matched; leaves `page` on the listing detail.
 */
export async function openListing(page: Page, address: string): Promise<ListingMatch> {
  const search = await firstVisible(page, [
    'input[placeholder*="search" i]',
    'input[aria-label*="search" i]',
    'input[type="search"]',
    '[class*="omni" i] input',
    '[class*="search" i] input',
  ]);
  if (!search) throw new PortalChangedError("realm-search", "couldn't find the REALM search box");

  await search.click();
  await search.fill(address);
  // Give the type-ahead a moment to populate.
  await page.waitForTimeout(1500);

  // Prefer a type-ahead suggestion that matches the address.
  const suggestions = page.locator(
    '[role="option"], [class*="suggestion" i] li, [class*="autocomplete" i] li, [class*="typeahead" i] li',
  );
  const sugCount = await suggestions.count().catch(() => 0);
  const matching: Array<{ loc: Locator; text: string }> = [];
  for (let i = 0; i < Math.min(sugCount, 15); i++) {
    const loc = suggestions.nth(i);
    const text = ((await loc.textContent().catch(() => "")) ?? "").trim();
    if (text && addressesMatch(address, text)) matching.push({ loc, text });
  }

  let matchedAddress = address;
  if (matching.length === 1) {
    matchedAddress = matching[0]!.text.slice(0, 200);
    await matching[0]!.loc.click();
  } else if (matching.length > 1) {
    // Distinct listings (e.g. different unit numbers) → ask the realtor.
    const distinct = [...new Set(matching.map((m) => m.text))];
    if (distinct.length > 1) throw new AmbiguousListingError(address, distinct.slice(0, 8));
    matchedAddress = matching[0]!.text.slice(0, 200);
    await matching[0]!.loc.click();
  } else {
    // No usable suggestions — submit the search and scan the results list.
    await search.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    const rows = page.locator(
      '[class*="listing" i] a, [class*="result" i] a, [class*="card" i] a, table tbody tr',
    );
    const rowCount = await rows.count().catch(() => 0);
    const hits: Array<{ loc: Locator; text: string }> = [];
    for (let i = 0; i < Math.min(rowCount, 25); i++) {
      const loc = rows.nth(i);
      const text = ((await loc.textContent().catch(() => "")) ?? "").trim();
      if (text && addressesMatch(address, text)) hits.push({ loc, text });
    }
    if (hits.length === 0) throw new ListingNotFoundError(address);
    const distinct = [...new Set(hits.map((h) => normalizeAddress(h.text)))];
    if (distinct.length > 1) {
      throw new AmbiguousListingError(address, hits.slice(0, 8).map((h) => h.text.slice(0, 120)));
    }
    matchedAddress = hits[0]!.text.slice(0, 200);
    await hits[0]!.loc.click();
  }

  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
  return {
    mlsNumber: extractMlsNumber(bodyText),
    matchedAddress: matchedAddress.replace(/\s+/g, " ").trim(),
  };
}

/**
 * On the listing detail page, click the Book Showing / BrokerBay button.
 * BrokerBay may open in a popup or the same tab — return whichever page it is.
 */
export async function openBrokerBayFromListing(context: BrowserContext, page: Page): Promise<Page> {
  const button = await firstVisible(page, [
    'a:has-text("Book Showing")',
    'button:has-text("Book Showing")',
    'a:has-text("Book a Showing")',
    'button:has-text("Book a Showing")',
    '[title*="brokerbay" i]',
    'a[href*="brokerbay" i]',
    'button:has-text("BrokerBay")',
    'a:has-text("BrokerBay")',
    'button:has-text("Schedule")',
  ]);
  if (!button) {
    throw new PortalChangedError(
      "realm-book-button",
      "no Book Showing / BrokerBay button on the listing page (listing may not accept online bookings)",
    );
  }

  const popupPromise = context.waitForEvent("page", { timeout: 20_000 }).catch(() => null);
  await button.click();
  const popup = await popupPromise;
  const bbPage = popup ?? page;
  await bbPage.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => undefined);
  await bbPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  return bbPage;
}
