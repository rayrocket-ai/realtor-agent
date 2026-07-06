import type { MlsBooking } from "../db/schema.js";
import {
  AmbiguousListingError,
  ListingNotFoundError,
  NeedsLoginError,
  PortalChangedError,
  SubmitStateUnknownError,
  TimeUnavailableError,
  type PortalFlow,
  type SubmitResult,
} from "./types.js";

export interface BookingDeps {
  /** Persist a partial update to the booking row. */
  update(patch: Partial<MlsBooking>): Promise<void>;
  /** Append a step to the booking's audit log (also persisted). */
  logStep(step: string, note?: string): Promise<void>;
  /** Email the realtor. */
  notify(subject: string, body: string): Promise<void>;
  /** Create a calendar event for a successful booking; returns event id. Optional. */
  createCalendarEvent?(booking: MlsBooking, result: SubmitResult): Promise<string | null>;
  now?(): Date;
}

export interface BookingRunResult {
  status: "confirmed" | "submitted" | "needs_attention" | "failed" | "dry_run";
  /** True when the failure is transient and the job should be retried. */
  retryable: boolean;
}

/**
 * Drive one booking end-to-end through the portal flow.
 *
 * Error policy:
 *  - "The portal told us no" errors (bad login, listing not found, time taken,
 *    UI changed) are terminal: mark needs_attention/failed + email the realtor.
 *  - Anything unexpected BEFORE the submit click is transient: rethrown so the
 *    job queue retries.
 *  - Anything AFTER the submit click is never retried (double-booking risk).
 */
export async function runBookingFlow(
  booking: MlsBooking,
  flow: PortalFlow,
  deps: BookingDeps,
): Promise<BookingRunResult> {
  const now = deps.now ?? (() => new Date());

  // A previous attempt already reached the submit click but never recorded an
  // outcome — do not run again; the showing may already exist in BrokerBay.
  if (booking.submitAttemptedAt && !["confirmed", "submitted", "dry_run"].includes(booking.status)) {
    await deps.update({
      status: "needs_attention",
      attentionReason:
        "A previous attempt reached the final submit step but the outcome is unknown. " +
        "Check BrokerBay for an existing showing request before retrying.",
      updatedAt: now(),
    });
    await deps.notify(
      `[BOOKING] ${booking.address} — needs your attention`,
      `The booking for ${booking.address} reached the submit step on a previous attempt, ` +
        `but the result was never recorded (crash or timeout at the worst moment).\n\n` +
        `Please check BrokerBay for a duplicate before retrying from the dashboard.`,
    );
    return { status: "needs_attention", retryable: false };
  }

  await deps.update({ status: "running", error: null, attentionReason: null, updatedAt: now() });

  let submitAttempted = false;
  try {
    await deps.logStep("init", "launching browser and signing into REALM");
    await flow.init();

    await deps.logStep("search", `searching REALM for "${booking.address}"`);
    const listing = await flow.searchListing(booking.address);
    await deps.update({
      mlsNumber: listing.mlsNumber,
      matchedAddress: listing.matchedAddress,
      updatedAt: now(),
    });
    await deps.logStep(
      "listing_found",
      `${listing.matchedAddress}${listing.mlsNumber ? ` (MLS ${listing.mlsNumber})` : ""}`,
    );

    await deps.logStep("open_brokerbay", "following the Book Showing handoff into BrokerBay");
    await flow.openBooking();

    await deps.logStep("select_slot", `picking ${booking.requestedStart.toISOString()} for ${booking.durationMin} min`);
    await flow.selectSlot(booking.requestedStart, booking.durationMin);
    await flow.screenshot("slot-selected");

    if (booking.dryRun) {
      await flow.screenshot("dry-run-final");
      await deps.update({ status: "dry_run", updatedAt: now() });
      await deps.logStep("dry_run", "stopped before submit (dry run)");
      await deps.notify(
        `[BOOKING dry run] ${booking.address} — ready to submit`,
        `Dry run finished for ${booking.address}: found the listing, opened BrokerBay, and ` +
          `selected the slot. Nothing was submitted. Screenshots are on the dashboard.`,
      );
      return { status: "dry_run", retryable: false };
    }

    // Point of no return: record it BEFORE clicking so a crash mid-submit
    // can never lead to a silent double booking on retry.
    submitAttempted = true;
    await deps.update({ submitAttemptedAt: now(), updatedAt: now() });
    await deps.logStep("submit", "clicking the final confirm button");
    const result = await flow.submit(booking.notes);
    await flow.screenshot("after-submit");

    let gcalEventId: string | null = null;
    if (deps.createCalendarEvent) {
      try {
        gcalEventId = await deps.createCalendarEvent(booking, result);
      } catch (err) {
        await deps.logStep("calendar", `calendar event failed (booking itself succeeded): ${(err as Error).message}`);
      }
    }

    await deps.update({
      status: result.state,
      confirmationText: result.message,
      gcalEventId,
      updatedAt: now(),
    });
    await deps.logStep(result.state, result.message);
    await deps.notify(
      `[BOOKING ${result.state === "confirmed" ? "confirmed" : "requested"}] ${booking.address}`,
      `${result.state === "confirmed" ? "Confirmed" : "Request submitted (waiting on the listing side to approve)"}: ` +
        `${booking.matchedAddress ?? booking.address}\n` +
        `When: ${booking.requestedStart.toISOString()} for ${booking.durationMin} min\n\n` +
        `BrokerBay said: ${result.message}`,
    );
    return { status: result.state, retryable: false };
  } catch (err) {
    await flow.screenshot("error").catch(() => null);
    return await handleFlowError(booking, err, submitAttempted, deps, now);
  } finally {
    await flow.close().catch(() => undefined);
  }
}

async function handleFlowError(
  booking: MlsBooking,
  err: unknown,
  submitAttempted: boolean,
  deps: BookingDeps,
  now: () => Date,
): Promise<BookingRunResult> {
  const e = err as Error;

  const terminal = async (
    status: "needs_attention" | "failed",
    reason: string,
    subject: string,
  ): Promise<BookingRunResult> => {
    await deps.update({
      status,
      attentionReason: status === "needs_attention" ? reason : null,
      error: e.message,
      updatedAt: now(),
    });
    await deps.logStep(status, e.message);
    await deps.notify(subject, `${reason}\n\nDetails:\n${e.message}\n\nScreenshots are on the dashboard under this booking.`);
    return { status, retryable: false };
  };

  if (e instanceof NeedsLoginError) {
    return terminal(
      "needs_attention",
      `Signing in needs a human (2FA prompt, captcha, or a rejected password). ` +
        `Run \`npm run booking:login\` on the server to complete the sign-in once — the session is saved for future bookings.`,
      `[BOOKING] ${booking.address} — sign-in needs your attention`,
    );
  }
  if (e instanceof ListingNotFoundError) {
    return terminal(
      "needs_attention",
      `REALM search found no active listing for "${booking.address}". Double-check the address (unit number, city) and retry.`,
      `[BOOKING] ${booking.address} — listing not found`,
    );
  }
  if (e instanceof AmbiguousListingError) {
    return terminal(
      "needs_attention",
      `More than one listing matched. Retry with a more specific address.`,
      `[BOOKING] ${booking.address} — multiple listings matched`,
    );
  }
  if (e instanceof TimeUnavailableError) {
    return terminal(
      "needs_attention",
      `The requested time isn't available on BrokerBay. Pick one of the open slots and retry.`,
      `[BOOKING] ${booking.address} — requested time unavailable`,
    );
  }
  if (e instanceof PortalChangedError) {
    return terminal(
      "failed",
      `The portal page didn't look like expected — REALM/BrokerBay may have changed their UI. ` +
        `The error screenshot on the dashboard shows exactly where it got stuck.`,
      `[BOOKING] ${booking.address} — portal UI mismatch`,
    );
  }
  if (e instanceof SubmitStateUnknownError || submitAttempted) {
    return terminal(
      "needs_attention",
      `The final submit was clicked but the outcome couldn't be read back. ` +
        `Check BrokerBay: the showing request may or may not exist. Do NOT blindly retry.`,
      `[BOOKING] ${booking.address} — submit outcome unknown`,
    );
  }

  // Unknown error before submit (timeout, crash, network) — let the queue retry.
  // Marked failed (not pending) so the row is accurate if retries run out;
  // a successful retry overwrites it on its way through.
  await deps.update({ status: "failed", error: e.message, updatedAt: now() });
  await deps.logStep("retry", `transient error (queue will retry): ${e.message}`);
  return { status: "failed", retryable: true };
}
