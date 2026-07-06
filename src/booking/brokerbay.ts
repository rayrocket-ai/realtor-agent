import type { Locator, Page } from "playwright";
import { config } from "../config.js";
import { fmtSlot } from "./time.js";
import {
  NeedsLoginError,
  PortalChangedError,
  SubmitStateUnknownError,
  TimeUnavailableError,
  type SubmitResult,
} from "./types.js";

/**
 * BrokerBay booking automation. Entered via REALM's Book Showing handoff
 * (usually already signed in through SSO); falls back to BROKERBAY_EMAIL /
 * BROKERBAY_PASSWORD if BrokerBay asks for its own login.
 */

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/** Sign in on BrokerBay if it presents its own login instead of honouring SSO. */
export async function ensureBrokerBayLogin(page: Page): Promise<void> {
  const pass = page.locator('input[type="password"]').first();
  if (!(await pass.isVisible().catch(() => false))) return; // SSO carried through

  const c = config();
  if (!c.BROKERBAY_EMAIL || !c.BROKERBAY_PASSWORD) {
    throw new NeedsLoginError(
      "brokerbay",
      "BrokerBay asked for its own sign-in and BROKERBAY_EMAIL / BROKERBAY_PASSWORD are not set",
    );
  }
  const email = await firstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[autocomplete="username"]',
  ]);
  if (email) await email.fill(c.BROKERBAY_EMAIL);
  await pass.fill(c.BROKERBAY_PASSWORD);
  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
  ]);
  if (submit) await submit.click();
  else await pass.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);

  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
    throw new NeedsLoginError("brokerbay", "BrokerBay sign-in did not go through");
  }
}

/** If we landed on the BrokerBay listing page (not the booking modal), open the booking UI. */
export async function openBookingUi(page: Page): Promise<void> {
  // Already showing a time grid or a calendar? Then there's nothing to click.
  if (await onBookingScreen(page)) return;
  const book = await firstVisible(page, [
    'button:has-text("Book Showing")',
    'button:has-text("Book a Showing")',
    'a:has-text("Book Showing")',
    'button:has-text("Book")',
    'button:has-text("Schedule")',
  ]);
  if (book) {
    await book.click();
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
  }
  if (!(await onBookingScreen(page))) {
    throw new PortalChangedError("brokerbay-open", "couldn't reach the BrokerBay date/time-selection screen");
  }
}

/** Some flows show the calendar before any times, so accept either. */
async function onBookingScreen(page: Page): Promise<boolean> {
  if (await hasTimeGrid(page)) return true;
  const cal = page
    .locator('[class*="calendar" i], [role="grid"], input[type="date"], [class*="datepicker" i]')
    .first();
  return cal.isVisible().catch(() => false);
}

async function hasTimeGrid(page: Page): Promise<boolean> {
  // The booking screen shows clickable clock times like "2:00 PM".
  const times = page.getByText(/^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i);
  return ((await times.count().catch(() => 0)) as number) >= 3;
}

/** Extract visible "H:MM AM/PM" strings, deduped, in page order. */
async function visibleSlotTexts(page: Page): Promise<string[]> {
  const times = page.getByText(/^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i);
  const n = Math.min((await times.count().catch(() => 0)) as number, 80);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((await times.nth(i).textContent().catch(() => "")) ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Select the requested date on the BrokerBay calendar / date strip. */
export async function selectDate(page: Page, start: Date): Promise<void> {
  const c = config();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: c.TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).formatToParts(start);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("day");
  const month = get("month");

  // 1) A native date input, if the UI has one.
  const dateInput = page.locator('input[type="date"]').first();
  if (await dateInput.isVisible().catch(() => false)) {
    const iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: c.TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(start);
    await dateInput.fill(iso);
    await page.waitForTimeout(1000);
    return;
  }

  // 2) An aria-labelled calendar day, e.g. aria-label="July 8, 2026".
  const aria = page.locator(`[aria-label*="${month} ${day}" i]`).first();
  if (await aria.isVisible().catch(() => false)) {
    await aria.click();
    await page.waitForTimeout(1000);
    return;
  }

  // 3) A date strip / calendar grid: advance "next" up to 8 times looking for the day cell.
  for (let hop = 0; hop <= 8; hop++) {
    const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
    if (bodyText.includes(month) || hop === 0) {
      const cell = page
        .locator(
          `[class*="calendar" i] :text-is("${day}"), [class*="date" i] :text-is("${day}"), [role="gridcell"]:has-text("${day}")`,
        )
        .first();
      if (await cell.isVisible().catch(() => false)) {
        const disabled = await cell.getAttribute("aria-disabled").catch(() => null);
        if (disabled !== "true") {
          await cell.click();
          await page.waitForTimeout(1000);
          return;
        }
      }
    }
    const next = await firstVisible(page, [
      '[aria-label*="next" i]',
      'button:has-text("›")',
      'button:has-text(">")',
      '[class*="next" i]',
    ]);
    if (!next) break;
    await next.click();
    await page.waitForTimeout(700);
  }
  throw new PortalChangedError("brokerbay-date", `couldn't select ${month} ${day} on the calendar`);
}

/** Pick the requested start time (and duration if the UI offers one). */
export async function selectTime(page: Page, start: Date, durationMin: number): Promise<void> {
  const c = config();
  const wanted = fmtSlot(start, c.TZ); // e.g. "2:00 PM"

  // Duration first when present — changing it can redraw the slot grid.
  const durationControl = await firstVisible(page, [
    `select:has(option:has-text("minutes"))`,
    '[class*="duration" i] select',
  ]);
  if (durationControl) {
    await durationControl
      .selectOption({ label: `${durationMin} minutes` })
      .catch(() =>
        durationControl.selectOption({ label: `${durationMin} min` }).catch(() => undefined),
      );
    await page.waitForTimeout(700);
  } else {
    const durBtn = page
      .locator(`button:has-text("${durationMin} min"), [role="option"]:has-text("${durationMin} min")`)
      .first();
    if (await durBtn.isVisible().catch(() => false)) {
      await durBtn.click();
      await page.waitForTimeout(700);
    }
  }

  const slot = page
    .locator(
      `button:text-is("${wanted}"), [role="option"]:text-is("${wanted}"), [role="button"]:text-is("${wanted}"), li:text-is("${wanted}")`,
    )
    .first();
  if (await slot.isVisible().catch(() => false)) {
    const disabled =
      (await slot.isDisabled().catch(() => false)) ||
      (await slot.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (!disabled) {
      await slot.click();
      await page.waitForTimeout(700);
      return;
    }
  }

  // Requested slot missing or greyed out → report what IS open.
  const alternatives = await visibleSlotTexts(page);
  throw new TimeUnavailableError(wanted, alternatives.slice(0, 16));
}

/** Fill the optional note and click the final submit; read back the outcome. */
export async function submitBooking(page: Page, notes?: string | null): Promise<SubmitResult> {
  if (notes) {
    const noteBox = await firstVisible(page, [
      "textarea",
      'input[name*="note" i]',
      'input[placeholder*="note" i]',
    ]);
    if (noteBox) await noteBox.fill(notes);
  }

  const submit = await firstVisible(page, [
    'button:has-text("Confirm Booking")',
    'button:has-text("Book Showing")',
    'button:has-text("Submit Request")',
    'button:has-text("Request Showing")',
    'button:has-text("Confirm")',
    'button:has-text("Submit")',
    'button:has-text("Book")',
  ]);
  if (!submit) throw new PortalChangedError("brokerbay-submit", "no confirm/submit button found");

  await submit.click();
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(2000);

  const body = (await page.textContent("body").catch(() => "")) ?? "";
  const confirmed = /\b(showing )?(is )?confirmed\b|\bapproved\b|booking confirmed/i.test(body);
  const submitted =
    /request (sent|submitted|received)|pending (confirmation|approval)|awaiting (confirmation|approval)|successfully (requested|submitted)/i.test(
      body,
    );

  if (confirmed || submitted) {
    const m =
      /([^.\n]{0,120}(confirmed|approved|request (sent|submitted|received)|pending (confirmation|approval)|awaiting (confirmation|approval))[^.\n]{0,120})/i.exec(
        body,
      );
    return {
      state: confirmed ? "confirmed" : "submitted",
      message: (m?.[1] ?? "Booking submitted").replace(/\s+/g, " ").trim(),
    };
  }

  // Validation error still on screen? Surface it instead of "unknown".
  const errText = await page
    .locator('[class*="error" i], [role="alert"]')
    .first()
    .textContent()
    .catch(() => null);
  if (errText?.trim()) {
    throw new SubmitStateUnknownError(`BrokerBay showed: ${errText.trim().slice(0, 300)}`);
  }
  throw new SubmitStateUnknownError("no confirmation or error text found after the submit click");
}
