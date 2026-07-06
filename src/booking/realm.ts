import type { BrowserContext, Locator, Page } from "playwright";
import { config } from "../config.js";
import { completePropTxLogin, firstVisible, settleNavigation } from "./proptx-sso.js";
import {
  AmbiguousListingError,
  ListingNotFoundError,
  PortalChangedError,
  type ListingMatch,
} from "./types.js";

/**
 * REALM (PropTx MLS) automation: sign in (shared PropTx SSO), find the listing
 * by address, and follow its "Book Showing" button into BrokerBay.
 *
 * REALM ships UI updates without notice, so every step tries several selector
 * strategies and fails with a PortalChangedError (plus an error screenshot,
 * taken by the caller) instead of guessing.
 */

/** Navigate to REALM and sign in if a login form appears. Idempotent. */
export async function ensureRealmLogin(page: Page): Promise<void> {
  const c = config();
  await page.goto(c.REALM_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleNavigation(page);
  await completePropTxLogin(page);
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
