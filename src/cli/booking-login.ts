/**
 * One-time interactive REALM sign-in helper. Opens the login flow in the
 * persistent booking browser profile so a 2FA prompt can be completed once;
 * every future booking reuses the saved session.
 *
 * On a headless server, run it with a visible browser over X forwarding:
 *   ssh -X user@server 'cd /opt/realtor-agent && BOOKING_HEADLESS=0 npm run booking:login'
 * or run headless just to verify the stored session still works:
 *   npm run booking:login
 */
import { loadConfig } from "../config.js";
import { launchBookingContext } from "../booking/browser.js";
import { ensureRealmLogin } from "../booking/realm.js";
import { NeedsLoginError } from "../booking/types.js";

async function main(): Promise<void> {
  const c = loadConfig();
  const headless = c.BOOKING_HEADLESS === "1";
  console.log(`Opening ${c.REALM_URL} (${headless ? "headless" : "visible browser"})…`);
  const context = await launchBookingContext();
  const page = await context.newPage();
  try {
    await ensureRealmLogin(page);
    console.log("✓ Signed into REALM. Session saved — bookings will reuse it.");
  } catch (err) {
    if (err instanceof NeedsLoginError && !headless) {
      console.log(`REALM needs manual input (${err.message}).`);
      console.log("Complete the sign-in in the browser window, then close it. The session will be saved.");
      await page.waitForEvent("close", { timeout: 10 * 60_000 }).catch(() => undefined);
      console.log("Browser closed — if you finished signing in, the session is saved.");
    } else {
      console.error(`✗ ${(err as Error).message}`);
      if (err instanceof NeedsLoginError) {
        console.error("Re-run with BOOKING_HEADLESS=0 (over ssh -X or on a machine with a display) to complete 2FA once.");
      }
      process.exitCode = 1;
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
