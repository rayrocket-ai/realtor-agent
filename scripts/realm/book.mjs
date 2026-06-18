// Realm (PropTx) → BrokerBay showing-request automation.
//
// Step 1 of the book-showing skill ("Realm booking"). Booking does NOT happen
// inside Realm: the Realm listing page's "Online Appt" link hands off to the
// BrokerBay booking SPA, which is where the date/time/duration form lives. This
// script logs in (Keycloak SSO + HighLevel SMS MFA via login.mjs), opens the
// listing, follows the BrokerBay handoff, fills the booking form, and — only
// with --confirm — clicks "Book Showing" and reads back the result.
//
// SAFETY MODEL
//   - Credentials only from env (REALM_USERNAME / REALM_PASSWORD); never logged.
//   - Dry-run by default: fills the form but does NOT click "Book Showing"
//     unless --confirm is passed. Nothing external happens without it.
//   - Hard guards: aborts loudly if login/MFA fails, the booking view never
//     renders, the requested date/slot isn't offered, or the slot is unavailable.
//   - Never prints a confirmation it didn't read back from BrokerBay.
//
// USAGE
//   node scripts/realm/book.mjs \
//     --address "85 Ronan Cres, Vaughan" --mls "N12851994" \
//     --date 2026-06-19 --start "4:00 PM" --end "4:30 PM" \
//     --client "Sarah Chen" [--type "Buyer/Broker"] [--note "..."] [--confirm]
//
//   --listing TREB-N12851994   skip lookup and use this Realm listing id directly
//   --start/--end accept "4:00 PM" or 24h "16:00"; duration is derived (15 or 30).
//
// Flow + selectors verified live 2026-06-18 (see docs/integrations.md §8–9).

import { existsSync, writeFileSync } from 'node:fs';
import { launchRealmBrowser } from './browser.mjs';
import { login, requireEnv } from './login.mjs';

// Reuse an authenticated session across runs so a dry-run + a --confirm (or
// several bookings in a row) don't each trigger a fresh SMS-MFA login. Falls
// back to a full login if there's no saved state or it has expired.
const STATE = process.env.REALM_STATE || '/tmp/realm-state.json';

async function ensureSession(creds) {
  if (existsSync(STATE)) {
    const ctx = await launchRealmBrowser({ headless: true, storageState: STATE });
    await ctx.page.goto('https://app.realmmlp.ca/dashboard', { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await ctx.page.waitForTimeout(3000);
    if (!/signin|sso\.ampre/.test(ctx.page.url())) { console.log('[realm] reused saved session.'); return ctx; }
    console.log('[realm] saved session expired — signing in again.');
    await ctx.browser.close();
  }
  const ctx = await launchRealmBrowser({ headless: true });
  await login(ctx.page, creds);
  writeFileSync(STATE, JSON.stringify(await ctx.context.storageState()));
  // Land on the dashboard so address-search resolution has the search UI ready.
  await ctx.page.goto('https://app.realmmlp.ca/dashboard', { waitUntil: 'load', timeout: 45000 }).catch(() => {});
  await ctx.page.waitForTimeout(3000);
  console.log('[realm] signed in, session saved.');
  return ctx;
}

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

// Normalize "16:00", "4:00 PM", "4:00PM" → "4:00 PM" (matches BrokerBay slot text).
function normalizeTime(t) {
  if (!t) return null;
  const s = t.trim().toUpperCase();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m) return `${parseInt(m[1], 10)}:${m[2]} ${m[3]}`;
  m = s.match(/^(\d{1,2}):(\d{2})$/); // 24h
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m[2]} ${ap}`;
  }
  throw new Error(`Could not parse time "${t}". Use "4:00 PM" or "16:00".`);
}

function toMinutes(t) {
  const m = normalizeTime(t).match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  let h = parseInt(m[1], 10) % 12;
  if (m[3] === 'PM') h += 12;
  return h * 60 + parseInt(m[2], 10);
}

// BrokerBay offers only 15- or 30-minute durations. Pick the closest allowed.
function deriveDuration(start, end) {
  if (!end) return 30; // skill default
  const mins = toMinutes(end) - toMinutes(start);
  if (mins <= 0) throw new Error(`End time must be after start time (got ${start}–${end}).`);
  return mins <= 15 ? 15 : 30;
}

// The Realm listing id is "TREB-<MLS#>". Accept an explicit --listing, derive
// from --mls, or fall back to searching Realm by address.
async function resolveListingId(page, { listing, mls, address }) {
  if (listing) return listing.toUpperCase().startsWith('TREB-') ? listing : `TREB-${listing}`;
  if (mls) return `TREB-${mls.replace(/^TREB-/i, '')}`;
  if (!address) throw new Error('Provide --listing, --mls, or --address to identify the listing.');

  // Search overlay: a button opens an input; typing + Enter → /s results page.
  const searchBtn = await page.$('button[aria-label="Open search"], button:has-text("Search REALM")');
  if (searchBtn) { await searchBtn.click(); await page.waitForTimeout(1500); }
  const input = await page.$('input[placeholder*="Search" i], input[type="search"], input:focus');
  if (!input) throw new Error('Realm search box did not open — cannot resolve address to a listing.');
  await input.fill(address);
  await page.waitForTimeout(2500);
  await input.press('Enter');
  await page.waitForTimeout(6000);

  // Results link to /view/listings/TREB-<id>. Match on the street number.
  const num = address.split(/\s+/)[0];
  const href = await page.evaluate((numTok) => {
    const a = [...document.querySelectorAll('a[href*="/view/listings/"]')]
      .find((el) => (el.innerText || '').toLowerCase().includes(numTok.toLowerCase()));
    return a ? a.getAttribute('href') : null;
  }, num);
  if (!href) throw new Error(`No Realm listing matched "${address}". Pass --mls or --listing instead.`);
  const id = href.split('/view/listings/')[1].split(/[?#]/)[0];
  console.log(`[realm] resolved "${address}" → ${id}`);
  return id;
}

// The booking UI renders inside the BrokerBay page's frame tree.
function bbFrame(target) {
  return target.frames().find((f) => /brokerbay\.com\/dashboard/.test(f.url())) || target.mainFrame();
}

// Open the listing and follow the "Online Appt" handoff into BrokerBay.
// Returns the BrokerBay page (popup) with the booking calendar mounted.
async function openBookingView(page, context, listingId) {
  await page.goto(`https://app.realmmlp.ca/view/listings/${listingId}?view=agent-full`,
    { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(4000);

  const link = page.getByRole('link', { name: /online appt/i }).first();
  if (!(await link.count())) {
    throw new Error(`No "Online Appt" link on listing ${listingId} — wrong id, or showings not offered online for this listing.`);
  }
  let bb = null;
  context.on('page', (p) => { if (/brokerbay/.test(p.url())) bb = p; });
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 20000 }).catch(() => null),
    link.click({ timeout: 10000 }),
  ]);
  const target = bb || popup || page;
  await target.waitForLoadState('load', { timeout: 30000 }).catch(() => {});

  // The shell shows a spinner first; the booking view mounts after LaunchDarkly
  // flags resolve and the Pusher availability socket connects.
  const fr = bbFrame(target);
  await fr.waitForSelector('.datepicker-booking, .timeslot', { timeout: 60000 }).catch(() => {
    throw new Error(
      'BrokerBay booking view did not render (still spinning). Check that ' +
      'app.launchdarkly.com and ws-us2.pusher.com are allowlisted — run check.mjs.'
    );
  });
  await target.waitForTimeout(2000);
  return target;
}

async function fillBooking(target, booking) {
  const fr = bbFrame(target);

  // Step 1 — Showing Type (default Buyer/Broker).
  if (booking.type) {
    await fr.selectOption('select[name="showingType"]', { label: booking.type })
      .catch(() => console.log(`[realm] showing type "${booking.type}" not found — leaving default.`));
  }

  // Optional note.
  if (booking.note) {
    await fr.getByRole('button', { name: /add note/i }).click({ timeout: 5000 }).catch(() => {});
    await fr.locator('textarea').first().fill(booking.note).catch(() => {});
  }

  // Step 2 — Date. Verify the calendar is on the requested month/year.
  const [y, mo, d] = booking.date.split('-').map((n) => parseInt(n, 10));
  const monthName = new Date(y, mo - 1, d).toLocaleString('en-US', { month: 'long' });
  const header = (await fr.locator('.datepicker-booking, .datepicker').first().innerText().catch(() => '')) || '';
  if (!(header.includes(monthName) && header.includes(String(y)))) {
    // Try to advance the calendar to the right month (best-effort arrow click).
    let moved = false;
    for (let i = 0; i < 12; i++) {
      const nav = fr.locator('.datepicker-booking [class*="next" i], .datepicker [class*="next" i], .datepicker-booking i.fa-chevron-right').first();
      if (!(await nav.count())) break;
      await nav.click({ timeout: 3000 }).catch(() => {});
      await target.waitForTimeout(800);
      const h = await fr.locator('.datepicker-booking, .datepicker').first().innerText().catch(() => '');
      if (h.includes(monthName) && h.includes(String(y))) { moved = true; break; }
    }
    if (!moved) {
      throw new Error(`Calendar isn't showing ${monthName} ${y} and month navigation isn't mapped. Pick a nearer date or extend the date stepper.`);
    }
  }
  const dayCell = fr.locator('.datecontainer:not(.no-hover) .datenumber', { hasText: new RegExp(`^${d}$`) }).first();
  if (!(await dayCell.count())) throw new Error(`Date ${booking.date} is not selectable in the calendar (past or out of range).`);
  await dayCell.click({ timeout: 10000 });
  await target.waitForTimeout(5000); // availability refreshes over Pusher

  // Step 3 — Time slot. Must exist AND be available (no timeslot-unavailable).
  const start = normalizeTime(booking.start);
  const present = fr.locator('.timeslot', { hasText: start });
  if (!(await present.count())) throw new Error(`No ${start} slot exists for ${booking.date}.`);
  const slot = fr.locator('.timeslot:not(.timeslot-unavailable)', { hasText: start }).first();
  if (!(await slot.count())) throw new Error(`The ${start} slot on ${booking.date} is unavailable (already booked or blocked).`);
  await slot.click({ timeout: 10000 });
  await target.waitForTimeout(3000);

  // Duration (15 or 30; "max 30 min"). Set the radio, then confirm with Done.
  const dur = deriveDuration(booking.start, booking.end);
  const durRadio = fr.locator(`input[type="radio"][name="duration"][value="${dur}"]`);
  if (await durRadio.count()) {
    await durRadio.check({ timeout: 4000 }).catch(() => durRadio.click({ timeout: 4000 }).catch(() => {}));
    await fr.getByRole('button', { name: /^done$/i }).click({ timeout: 4000 }).catch(() => {});
    await target.waitForTimeout(1500);
  }

  // Confirm the selection actually registered before we offer to submit.
  const selected = await fr.locator('.timeslot-selected').first().innerText().catch(() => '');
  console.log(`[realm] selected slot: ${selected.replace(/\s+/g, ' ').trim() || '(unconfirmed)'} | duration ${dur} min`);
  return { dur, selected };
}

// Click "Book Showing" and wait for BrokerBay to actually accept the request.
//
// The submit button ("Book Showing") sits in a sticky header. Scrolling it into
// view re-renders the time-slot list and de-selects the slot (disabling the
// button), so DON'T scroll — the tall viewport set in browser.mjs keeps the whole
// form on-screen, letting us fire a real (trusted) Playwright click in place. A
// synthetic el.click() is NOT enough: BrokerBay's handler ignores untrusted events.
//
// reCAPTCHA Enterprise (score-based, invisible) runs on submit and POSTs to
// /recaptcha/enterprise/reload for a token. We only treat reCAPTCHA as the cause
// of a failure if one of its *core* resources actually fails to load — the
// /recaptcha/enterprise/clr telemetry beacon is routinely ERR_ABORTED on idle and
// is NOT a failure, so ignoring it avoids false "captcha blocked" reports.
//
// Returns { text, ref } on a confirmed submit; throws (booking NOT placed) otherwise.
async function submitBooking(target) {
  const fr = bbFrame(target);

  // The button enables only once a valid date + time + duration are selected.
  // Confirm an enabled instance exists before attempting the (trusted) click.
  const enabled = await fr.evaluate(() => [...document.querySelectorAll('button')]
    .some((b) => /^book showing$/i.test((b.innerText || '').trim()) && !b.disabled));
  if (!enabled) {
    throw new Error('"Book Showing" is disabled — the date/time/duration selection did not register. Nothing was submitted.');
  }
  const book = fr.getByRole('button', { name: /^book showing$/i }).first();

  let captchaCoreFailed = false;
  const onFail = (r) => {
    const u = r.url();
    if (/recaptcha\/(enterprise\.js|api\.js)/.test(u) ||
        /recaptcha\/enterprise\/(anchor|reload)/.test(u) ||
        /gstatic\.com\/recaptcha\/releases/.test(u)) captchaCoreFailed = true;
  };
  target.on('requestfailed', onFail);

  // Surface BrokerBay's submit-time error (e.g. an automation/"logged out" rejection)
  // so a failure is reported honestly instead of as a silent timeout.
  let submitError = null;
  const readToast = async () => (await bbFrame(target).evaluate(() =>
    [...document.querySelectorAll('.ant-message, .ant-notification, .toast, .Toastify, [class*="error" i], [class*="alert" i]')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []));

  await book.click({ timeout: 10000 });
  for (let i = 0; i < 3 && !submitError; i++) {
    await target.waitForTimeout(1500);
    const toasts = await readToast();
    const hit = toasts.find((t) => /logged out|log back in|error|failed|unable/i.test(t));
    if (hit) submitError = hit;
  }
  if (submitError) {
    target.off('requestfailed', onFail);
    throw new Error(`Booking was REJECTED by BrokerBay at submit: "${submitError}". Nothing was booked.`);
  }

  // Poll for a genuine acceptance signal from BrokerBay (mirrors the wording of
  // the "Showing Request" confirmation: "Your showing request is being processed.").
  const SUCCESS = /request is being processed|please wait for further instruction|showing (request|has been) (submitted|confirmed|booked|requested)|your showing (request )?(has been|is)/i;
  for (let i = 0; i < 10; i++) {
    await target.waitForTimeout(3000);
    const text = await bbFrame(target).evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
    if (SUCCESS.test(text)) {
      target.off('requestfailed', onFail);
      const ref = (text.match(/(confirmation|reference|appointment)[^\w]{0,3}#?\s*([A-Z0-9-]{4,})/i) || [])[2] || null;
      return { text: text.slice(0, 600), ref };
    }
  }
  target.off('requestfailed', onFail);

  if (captchaCoreFailed) {
    throw new Error(
      'Booking did NOT go through — a core reCAPTCHA resource failed to load. BrokerBay needs ' +
      'www.google.com and www.gstatic.com allowlisted to submit. Nothing was booked.'
    );
  }
  throw new Error(
    'Booking did NOT complete — clicked "Book Showing" but no confirmation appeared within the ' +
    'timeout. Nothing was booked. Check BrokerBay manually before retrying.'
  );
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const booking = {
    address: args.address, mls: args.mls, listing: args.listing,
    date: args.date, start: args.start, end: args.end,
    client: args.client, type: args.type, note: args.note,
  };
  if (!booking.date || !booking.start) {
    console.error('Missing required --date and/or --start. See usage at the top of book.mjs.');
    process.exit(2);
  }
  // Validate time parsing up front so we fail before opening a browser.
  normalizeTime(booking.start);
  if (booking.end) deriveDuration(booking.start, booking.end);

  const creds = { username: requireEnv('REALM_USERNAME'), password: requireEnv('REALM_PASSWORD') };

  console.log(`[realm] ${args.confirm ? 'BOOKING (will submit on success)' : 'DRY RUN — will NOT submit'}...`);
  const { browser, context, page } = await ensureSession(creds);
  try {
    const listingId = await resolveListingId(page, booking);
    console.log(`[realm] opening booking view for ${listingId}...`);
    const bb = await openBookingView(page, context, listingId);

    console.log(`[realm] filling booking: ${booking.date} ${normalizeTime(booking.start)}` +
      (booking.end ? `–${normalizeTime(booking.end)}` : '') + (booking.client ? ` for ${booking.client}` : ''));
    await fillBooking(bb, booking);
    await bb.screenshot({ path: '/tmp/realm-booking-filled.png', fullPage: true }).catch(() => {});

    if (!args.confirm) {
      console.log('[realm] DRY RUN complete — form filled, NOT submitted. Screenshot: /tmp/realm-booking-filled.png');
      console.log('[realm] Re-run with --confirm to place the booking.');
      return;
    }

    console.log('[realm] submitting booking...');
    const res = await submitBooking(bb);
    await bb.screenshot({ path: '/tmp/realm-booking-result.png', fullPage: true }).catch(() => {});
    console.log('[realm] BOOKING PLACED — BrokerBay accepted the request.' +
      (res.ref ? ` Confirmation/reference: ${res.ref}` : ' (No reference number shown; check the confirmation email.)'));
    console.log('[realm] result screenshot: /tmp/realm-booking-result.png');
  } catch (err) {
    await page.screenshot({ path: '/tmp/realm-last.png', fullPage: true }).catch(() => {});
    console.error(`[realm] ${err.message}`);
    console.error('[realm] screenshot (if any): /tmp/realm-last.png');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
