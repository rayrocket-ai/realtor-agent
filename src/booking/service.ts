import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { enqueue } from "../jobs/queue.js";
import { createEvent } from "../channels/gcal/client.js";
import { runBookingFlow, type BookingDeps, type BookingRunResult } from "./orchestrator.js";
import { RealmBrokerBayFlow } from "./flow.js";
import { BrokerBayDirectFlow } from "./brokerbay-direct.js";
import type { MlsBooking } from "../db/schema.js";
import type { PortalFlow } from "./types.js";

/** Pick the portal flow from config (BrokerBay-direct by default). */
export function defaultFlow(bookingId: string): PortalFlow {
  return config().BOOKING_PORTAL === "realm"
    ? new RealmBrokerBayFlow(bookingId)
    : new BrokerBayDirectFlow(bookingId);
}

export interface CreateBookingInput {
  address: string;
  requestedStart: Date;
  durationMin?: number;
  notes?: string | null;
  source: "dashboard" | "cli" | "agent" | "telegram";
  leadId?: string | null;
  showingId?: string | null;
  dryRun?: boolean;
  /** When set, booking updates are also pushed to this Telegram chat. */
  telegramChatId?: string | null;
  /** Set when this booking is one stop of a multi-home tour. */
  tourId?: string | null;
  tourStop?: number | null;
  /** Delay the job so tour stops book in itinerary order. */
  enqueueRunAt?: Date;
}

/** Insert a booking request and queue it for the worker. Returns the row. */
export async function createBookingRequest(input: CreateBookingInput): Promise<MlsBooking> {
  const c = config();
  const [row] = await db()
    .insert(schema.mlsBookings)
    .values({
      address: input.address.trim(),
      requestedStart: input.requestedStart,
      durationMin: input.durationMin ?? c.BOOKING_DEFAULT_DURATION_MIN,
      notes: input.notes ?? null,
      source: input.source,
      notifyTelegramChatId: input.telegramChatId ?? null,
      tourId: input.tourId ?? null,
      tourStop: input.tourStop ?? null,
      leadId: input.leadId ?? null,
      showingId: input.showingId ?? null,
      dryRun: input.dryRun ?? c.BOOKING_DRY_RUN === "1",
    })
    .returning();
  await enqueue({
    type: "mls-booking",
    payload: { bookingId: row!.id },
    runAt: input.enqueueRunAt,
    dedupeKey: `mls-booking:${row!.id}`,
  });
  return row!;
}

/** Re-queue a stuck/failed booking from the dashboard. Clears the double-submit guard. */
export async function retryBooking(bookingId: string): Promise<void> {
  await db()
    .update(schema.mlsBookings)
    .set({ status: "pending", error: null, attentionReason: null, submitAttemptedAt: null, updatedAt: new Date() })
    .where(eq(schema.mlsBookings.id, bookingId));
  await enqueue({
    type: "mls-booking",
    payload: { bookingId },
    dedupeKey: `mls-booking:${bookingId}`,
  });
}

function realDeps(bookingId: string, telegramChatId?: string | null): BookingDeps {
  return {
    async update(patch) {
      await db().update(schema.mlsBookings).set(patch).where(eq(schema.mlsBookings.id, bookingId));
    },
    async logStep(step, note) {
      const entry = { t: new Date().toISOString(), step, ...(note ? { note } : {}) };
      await db()
        .update(schema.mlsBookings)
        .set({
          log: sql`${schema.mlsBookings.log} || ${JSON.stringify([entry])}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.mlsBookings.id, bookingId));
      console.log(`[booking ${bookingId.slice(0, 8)}] ${step}${note ? `: ${note}` : ""}`);
    },
    async notify(subject, body) {
      const link = `${config().APP_BASE_URL}/admin/bookings/${bookingId}`;
      await enqueue({
        type: "notify-realtor",
        payload: { subject, body: `${body}\n\nDashboard: ${link}` },
      });
      // Mirror the update to the Telegram chat that started this booking.
      if (telegramChatId) {
        const { sendMessage } = await import("../channels/telegram/client.js");
        await sendMessage(telegramChatId, `${subject}\n\n${body}`);
      }
    },
    async createCalendarEvent(booking, result) {
      const c = config();
      if (!c.gmailEnabled) return null;
      // A lead-driven booking already has its calendar event from book_showing.
      if (booking.showingId) return null;
      const end = new Date(booking.requestedStart.getTime() + booking.durationMin * 60_000);
      return createEvent({
        summary: `Showing: ${booking.matchedAddress ?? booking.address}${booking.mlsNumber ? ` (MLS ${booking.mlsNumber})` : ""}`,
        description: `Booked via REALM/BrokerBay by the assistant.\nStatus: ${result.state}\n${result.message}`,
        location: booking.matchedAddress ?? booking.address,
        start: booking.requestedStart,
        end,
      });
    },
  };
}

/** Load the row and run it through the portal flow. Used by the job handler and the CLI. */
export async function runBooking(
  bookingId: string,
  flowFactory: (bookingId: string) => PortalFlow = defaultFlow,
): Promise<BookingRunResult> {
  const booking = await db().query.mlsBookings.findFirst({
    where: eq(schema.mlsBookings.id, bookingId),
  });
  if (!booking) throw Object.assign(new Error(`booking ${bookingId} not found`), { permanent: true });
  if (["confirmed", "submitted", "dry_run", "cancelled"].includes(booking.status)) {
    return { status: booking.status as BookingRunResult["status"], retryable: false };
  }
  const deps = realDeps(bookingId, booking.notifyTelegramChatId);
  if (!config().bookingEnabled) {
    await deps.update({
      status: "needs_attention",
      attentionReason: "REALM_USERNAME / REALM_PASSWORD are not configured — set them in .env and retry.",
      updatedAt: new Date(),
    });
    await deps.notify(
      `[BOOKING] ${booking.address} — REALM not configured`,
      "A booking was requested but REALM credentials aren't set in .env, so nothing was booked.",
    );
    return { status: "needs_attention", retryable: false };
  }
  return runBookingFlow(booking, flowFactory(bookingId), deps);
}
