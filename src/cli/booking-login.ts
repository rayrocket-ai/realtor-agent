/**
 * One-time interactive sign-in helper for the booking portal. Opens the login
 * flow in the persistent booking browser profile so the session (including the
 * one-time SMS authorization code) is saved and reused by every future booking.
 *
 * The SMS code is normally read automatically (HighLevel / Gmail). If it isn't,
 * paste it into the box on /admin/bookings, or `echo CODE > data/booking/otp.txt`.
 *
 * Just verify / refresh the saved session:
 *   npm run booking:login
 */
import { loadConfig } from "../config.js";
import { launchBookingContext } from "../booking/browser.js";
import { ensureRealmLogin } from "../booking/realm.js";
import { completePropTxLogin, settleNavigation } from "../booking/proptx-sso.js";
import { firstVisible } from "../booking/proptx-sso.js";
import { NeedsLoginError } from "../booking/types.js";

async function main(): Promise<void> {
  const c = loadConfig();
  const portal = c.BOOKING_PORTAL;
  const target = portal === "realm" ? c.REALM_URL : c.BROKERBAY_URL;
  console.log(`Signing into ${portal} (${target})…`);
  const context = await launchBookingContext();
  const page = await context.newPage();
  try {
    if (portal === "realm") {
      await ensureRealmLogin(page);
    } else {
      await page.goto(c.BROKERBAY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await settleNavigation(page);
      const emailInput = page.locator('input[type="email"]').first();
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill(c.BROKERBAY_EMAIL || c.REALTOR_EMAIL || c.GMAIL_ADDRESS);
        const cont = await firstVisible(page, ['button[type="submit"]', 'button:has-text("Continue")']);
        if (cont) await cont.click();
        await settleNavigation(page);
        const proptx = await firstVisible(page, ['button:has-text("PropTx")', 'a:has-text("PropTx")']);
        if (proptx) {
          await proptx.click();
          await settleNavigation(page);
        }
        await completePropTxLogin(page);
        await settleNavigation(page);
      }
    }
    console.log(`✓ Signed into ${portal}. Session saved — bookings will reuse it.`);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    if (err instanceof NeedsLoginError) {
      console.error(
        "If a verification code was needed, make sure REALM_OTP_SENDER + HighLevel/Gmail are configured, " +
          "or paste the code into /admin/bookings while this runs.",
      );
    }
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
