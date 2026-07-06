import { runBooking } from "../../booking/service.js";
import type { JobHandler } from "./index.js";

/**
 * Run one MLS booking through REALM → BrokerBay. The orchestrator handles all
 * "portal said no" outcomes itself (status + realtor email); we only rethrow
 * transient errors so the queue's retry/backoff kicks in.
 */
export const mlsBookingHandler: JobHandler = async (payload) => {
  const bookingId = String(payload.bookingId ?? "");
  if (!bookingId) throw new Error("mls-booking job missing bookingId");
  const result = await runBooking(bookingId);
  if (result.retryable) {
    throw new Error(`booking ${bookingId} hit a transient error — retrying`);
  }
};
