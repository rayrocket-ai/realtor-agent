import type { BrowserContext, Page } from "playwright";
import { config } from "../config.js";
import { launchBookingContext, saveShot } from "./browser.js";
import { completePropTxLogin, firstVisible, settleNavigation } from "./proptx-sso.js";
import { fmtSlot } from "./time.js";
import {
  AmbiguousListingError,
  ListingNotFoundError,
  NeedsLoginError,
  PortalChangedError,
  SubmitStateUnknownError,
  TimeUnavailableError,
  type ListingMatch,
  type PortalFlow,
  type SubmitResult,
} from "./types.js";

/**
 * Books a showing directly in the BrokerBay web app (edge.brokerbay.com),
 * signing in through its "PropTx" IdP button (→ shared PropTx SSO). This is
 * the path verified end-to-end against the live portal: BrokerBay's own search
 * finds the listing, so there's no separate REALM listing hop.
 *
 * The three-step booking screen is: pick date on the calendar → pick a time
 * slot → confirm duration in the popup → "Book Showing". TRREB-style MLS
 * numbers appear in the search result and are captured for the audit trail.
 */

const APP_URL = "https://edge.brokerbay.com";

/** Wait for the BrokerBay SPA to actually render (not just navigate). */
async function waitForApp(page: Page): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const body = ((await page.textContent("body").catch(() => "")) ?? "").trim();
    if (body.length > 200 && page.url().includes("brokerbay")) return;
    await page.waitForTimeout(1000);
  }
}

/**
 * Pull the MLS number out of a card's text. DOM textContent concatenates nodes
 * without whitespace, so "TRREB: W13503106" + "16 Curry…" arrives glued as
 * "TRREB: W1350310616 Curry…" — anchor on the board prefix first.
 */
export function mlsFromCardText(cardText: string): string | null {
  // No leading \b: textContent glues the status badge to the board name,
  // e.g. "NewTRREB: W13503106…".
  const prefixed = /(?:TRREB|MLS|ITSO|OREB|RAHB)[®™]?[:#]?\s*([A-Z]\d{8})/i.exec(cardText);
  if (prefixed) return prefixed[1]!.toUpperCase();
  const bare = /\b([A-Z]\d{7,8})\b/.exec(cardText);
  return bare ? bare[1]! : null;
}

/**
 * Pull the street address out of a search-result card's text, e.g. (glued)
 * "New • TRREB: W1350310616 Curry CrescentHalton Hills, ON$1,588,000 …"
 * → "16 Curry Crescent Halton Hills, ON".
 */
export function addressFromCardText(cardText: string, fallback: string): string {
  let t = cardText.replace(/\s+/g, " ").trim();
  const dollar = t.indexOf("$");
  if (dollar > 0) t = t.slice(0, dollar);
  t = t
    // Board-prefixed MLS number, glued or not (see mlsFromCardText).
    .replace(/(?:TRREB|MLS|ITSO|OREB|RAHB)[®™]?[:#]?\s*[A-Z]\d{8}/gi, " ")
    .replace(/\b[A-Z]\d{7,8}\b/g, " ")
    .replace(/\bNew\b|[•·|]/g, " ")
    // Re-insert the spaces textContent swallowed between elements.
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  // Addresses start at the street number.
  const m = /\d+.*$/.exec(t);
  const addr = (m ? m[0] : t).trim();
  return addr.length >= 6 ? addr.slice(0, 200) : fallback;
}

export class BrokerBayDirectFlow implements PortalFlow {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private listingMls: string | null = null;

  constructor(private bookingId: string) {}

  private p(): Page {
    if (!this.page) throw new Error("flow not initialized");
    return this.page;
  }

  async init(): Promise<void> {
    this.context = await launchBookingContext();
    this.page = await this.context.newPage();
    const page = this.page;

    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settleNavigation(page);

    // BrokerBay's own login: email → "PropTx" IdP → shared SSO.
    const emailInput = page.locator('input[type="email"]').first();
    if (await emailInput.isVisible().catch(() => false)) {
      const c = config();
      const email = c.BROKERBAY_EMAIL || c.REALTOR_EMAIL || c.GMAIL_ADDRESS;
      if (!email) throw new NeedsLoginError("brokerbay", "no BrokerBay email configured (BROKERBAY_EMAIL / REALTOR_EMAIL)");
      await emailInput.fill(email);
      const cont = await firstVisible(page, ['button[type="submit"]', 'button:has-text("Continue")']);
      if (cont) await cont.click();
      await settleNavigation(page);

      const proptx = await firstVisible(page, [
        'button:has-text("PropTx")',
        'a:has-text("PropTx")',
        'button:has-text("TRREB")',
      ]);
      if (proptx) {
        await proptx.click();
        await settleNavigation(page);
      }
      await completePropTxLogin(page);
      await settleNavigation(page);
    }

    await waitForApp(page);
    if (!page.url().includes("brokerbay")) {
      throw new NeedsLoginError("brokerbay", "did not reach the BrokerBay app after sign-in");
    }
    await saveShot(page, this.bookingId, "brokerbay-signed-in");
  }

  /**
   * Type a ref (address or MLS number) into the app search and wait for result
   * cards. Returns the single match's card info; throws on none/ambiguous.
   */
  private async findInSearch(ref: string): Promise<{ address: string; mlsNumber: string | null }> {
    const page = this.p();
    const search = await firstVisible(page, [
      'input[placeholder*="Search listings" i]',
      'input[placeholder*="Search" i]',
    ]);
    if (!search) throw new PortalChangedError("brokerbay-search", "couldn't find the BrokerBay search box");
    await search.click();
    await search.fill("");
    await search.fill(ref);
    await page.waitForTimeout(3500);

    // The results panel lists listings with a "Request Showing" button each.
    const requestButtons = page.locator('button:has-text("Request Showing")');
    const count = await requestButtons.count().catch(() => 0);
    if (count === 0) throw new ListingNotFoundError(ref);
    if (count > 1) {
      // Distinct listings for the same query → ask the realtor to be specific.
      const labels: string[] = [];
      const cards = page.locator('[class*="result" i], [class*="listing" i]');
      const n = Math.min((await cards.count().catch(() => 0)) as number, 8);
      for (let i = 0; i < n; i++) {
        const t = ((await cards.nth(i).textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
        if (t) labels.push(t.slice(0, 120));
      }
      throw new AmbiguousListingError(ref, labels.length ? labels : [`${count} matching listings`]);
    }

    const card = page.locator('[class*="result" i], [class*="listing" i]').first();
    const cardText = ((await card.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    return { address: addressFromCardText(cardText, ref), mlsNumber: mlsFromCardText(cardText) };
  }

  /**
   * Look a ref up WITHOUT opening the booking screen — used by the tour
   * planner to resolve MLS numbers to addresses before routing.
   */
  async resolveListing(ref: string): Promise<ListingMatch> {
    const found = await this.findInSearch(ref);
    return { mlsNumber: found.mlsNumber, matchedAddress: found.address };
  }

  async searchListing(ref: string): Promise<ListingMatch> {
    const page = this.p();
    const found = await this.findInSearch(ref);
    this.listingMls = found.mlsNumber;

    const requestButtons = page.locator('button:has-text("Request Showing")');
    await requestButtons.first().click();
    // The booking screen shows "Step 3 - Select Time".
    await page.locator("text=/Select Time/i").first().waitFor({ timeout: 30_000 }).catch(() => {
      throw new PortalChangedError("brokerbay-book-open", "the booking screen didn't open after Request Showing");
    });
    await page.waitForTimeout(3000);
    await saveShot(page, this.bookingId, "booking-form");

    return { mlsNumber: this.listingMls, matchedAddress: found.address };
  }

  async openBooking(): Promise<void> {
    // With the direct flow, searchListing already opened the booking screen.
  }

  async selectSlot(start: Date, durationMin: number): Promise<void> {
    const page = this.p();
    const c = config();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: c.TZ,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatToParts(start);
    const day = parts.find((x) => x.type === "day")?.value ?? "";
    const month = parts.find((x) => x.type === "month")?.value ?? "";
    const year = parts.find((x) => x.type === "year")?.value ?? "";

    // Step 2 — calendar. Advance months until the target is shown, then click
    // the day cell (avoid matching the year "2026" etc.).
    for (let hop = 0; hop <= 6; hop++) {
      const shown = ((await page.textContent("body").catch(() => "")) ?? "");
      if (shown.includes(`${year} ${month}`) || shown.includes(`${month} ${year}`) || hop === 0) {
        const cell = page
          .locator(
            `[class*="calendar" i] :text-is("${day}"), [role="gridcell"]:text-is("${day}"), td:text-is("${day}")`,
          )
          .first();
        if (await cell.isVisible().catch(() => false)) {
          const disabled = (await cell.getAttribute("aria-disabled").catch(() => null)) === "true";
          if (!disabled) {
            await cell.click();
            await page.waitForTimeout(1500);
            break;
          }
        }
      }
      const next = await firstVisible(page, ['[aria-label*="next" i]', 'button:has-text("›")', 'button:has-text(">")']);
      if (!next || hop === 6) throw new PortalChangedError("brokerbay-date", `couldn't select ${month} ${day}, ${year}`);
      await next.click();
      await page.waitForTimeout(800);
    }

    // Step 3 — time slot.
    const wanted = fmtSlot(start, c.TZ); // "5:00 PM"
    const slot = page.locator(`:text-is("${wanted}")`).first();
    if (!(await slot.isVisible().catch(() => false))) {
      const alts = await this.visibleSlots();
      throw new TimeUnavailableError(wanted, alts);
    }
    await slot.click();
    await page.waitForTimeout(1500);

    // Duration popup — radios (15/30/45/60) capped at the listing's max, then Done.
    const durOption = page.locator(`:text-is("${durationMin} minutes"), label:has-text("${durationMin} minutes")`).first();
    if (await durOption.isVisible().catch(() => false)) {
      await durOption.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    const done = await firstVisible(page, ['button:has-text("Done")', ':text-is("Done")']);
    if (done) {
      await done.click();
      await page.waitForTimeout(1500);
    }
    await saveShot(page, this.bookingId, "slot-selected");
  }

  private async visibleSlots(): Promise<string[]> {
    const page = this.p();
    const times = page.getByText(/^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i);
    const n = Math.min((await times.count().catch(() => 0)) as number, 40);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = ((await times.nth(i).textContent().catch(() => "")) ?? "").trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 16);
  }

  async submit(notes?: string | null): Promise<SubmitResult> {
    const page = this.p();
    if (notes) {
      const addNote = await firstVisible(page, ['button:has-text("Add Note")']);
      if (addNote) {
        await addNote.click();
        await page.waitForTimeout(500);
        const noteBox = await firstVisible(page, ["textarea", 'input[placeholder*="note" i]']);
        if (noteBox) await noteBox.fill(notes);
      }
    }

    // The header "Book Showing" button is the final submit.
    const submit = page.locator('button:has-text("Book Showing")').last();
    if (!(await submit.isVisible().catch(() => false))) {
      throw new PortalChangedError("brokerbay-submit", "no Book Showing submit button on the booking screen");
    }
    await submit.click();
    await page.waitForTimeout(4000);

    // A terms/confirm dialog may appear.
    const confirm = await firstVisible(page, [
      'button:has-text("Confirm Booking")',
      'button:has-text("Confirm")',
      'button:has-text("Agree")',
      'button:has-text("Accept")',
      'button:has-text("OK")',
    ]);
    if (confirm) {
      await confirm.click();
      await page.waitForTimeout(4000);
    }
    await settleNavigation(page);
    await saveShot(page, this.bookingId, "after-submit");

    // BrokerBay lands on the listing's Showings tab; the new row reads "New"
    // (request submitted, awaiting listing-side confirm) or "Confirmed".
    const body = ((await page.textContent("body").catch(() => "")) ?? "").replace(/\s+/g, " ");
    const confirmed = /\bconfirmed\b/i.test(body) && !/needs? action/i.test(body);
    const submitted =
      /request (sent|submitted|received|processed)|being processed|pending|awaiting|no more showings|showing requested|\bnew\b/i.test(
        body,
      );

    if (confirmed || submitted) {
      return {
        state: confirmed ? "confirmed" : "submitted",
        message: confirmed
          ? "BrokerBay confirmed the showing."
          : "Showing request submitted — waiting for the listing side to confirm.",
      };
    }

    const err = await page
      .locator('[class*="error" i], [role="alert"]')
      .first()
      .textContent()
      .catch(() => null);
    if (err?.trim()) throw new SubmitStateUnknownError(`BrokerBay showed: ${err.trim().slice(0, 300)}`);
    throw new SubmitStateUnknownError("no confirmation or error text found after the Book Showing click");
  }

  async screenshot(name: string): Promise<string | null> {
    if (!this.page) return null;
    return saveShot(this.page, this.bookingId, name).catch(() => null);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
  }
}
