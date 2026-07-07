import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { enqueue } from "../jobs/queue.js";
import { createBookingRequest } from "./service.js";
import { geocode, planTourRoute, type RouteStop } from "./geo.js";
import { isMlsNumber } from "../channels/telegram/parse.js";
import { BrokerBayDirectFlow } from "./brokerbay-direct.js";
import type { Tour, TourStopPlan } from "../db/schema.js";

/**
 * Multi-home tours: several listings, one start time. The planner resolves MLS
 * numbers to addresses (one BrokerBay session), geocodes every stop, orders
 * them by driving distance, lays showings back-to-back on the 15-minute grid,
 * and queues a normal booking per stop — so each stop gets the full booking
 * machinery (screenshots, no-double-submit guard, notifications).
 */

export interface CreateTourInput {
  refs: string[];
  requestedStart: Date;
  durationMin?: number;
  notes?: string | null;
  source: "telegram" | "dashboard" | "cli";
  telegramChatId?: string | null;
  dryRun?: boolean;
}

export async function createTourRequest(input: CreateTourInput): Promise<Tour> {
  const c = config();
  const [row] = await db()
    .insert(schema.tours)
    .values({
      refs: input.refs,
      requestedStart: input.requestedStart,
      durationMin: input.durationMin ?? c.BOOKING_DEFAULT_DURATION_MIN,
      notes: input.notes ?? null,
      source: input.source,
      notifyTelegramChatId: input.telegramChatId ?? null,
      dryRun: input.dryRun ?? c.BOOKING_DRY_RUN === "1",
    })
    .returning();
  await enqueue({
    type: "tour-plan",
    payload: { tourId: row!.id },
    dedupeKey: `tour-plan:${row!.id}`,
  });
  return row!;
}

async function notifyTour(tour: Tour, subject: string, body: string): Promise<void> {
  await enqueue({
    type: "notify-realtor",
    payload: { subject, body },
  });
  if (tour.notifyTelegramChatId) {
    const { sendMessage } = await import("../channels/telegram/client.js");
    await sendMessage(tour.notifyTelegramChatId, `${subject}\n\n${body}`);
  }
}

function fmtLocal(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function itineraryText(stops: TourStopPlan[]): string {
  return stops
    .map((s, i) => {
      const travel =
        i > 0
          ? ` (${s.distanceKmFromPrev != null ? `${s.distanceKmFromPrev} km, ` : ""}~${s.travelMinFromPrev} min drive)`
          : "";
      return `${i + 1}. ${fmtLocal(new Date(s.startsAt))} — ${s.address}${s.mlsNumber ? ` (${s.mlsNumber})` : ""}${travel}`;
    })
    .join("\n");
}

/**
 * Plan a tour and queue its bookings. Idempotent: if stops were already
 * created (retry after a crash), it does nothing.
 */
export async function planTour(tourId: string): Promise<void> {
  const d = db();
  const tour = await d.query.tours.findFirst({ where: eq(schema.tours.id, tourId) });
  if (!tour) throw new Error(`tour ${tourId} not found`);
  if (["booked", "cancelled", "failed"].includes(tour.status)) return;

  const existing = await d.query.mlsBookings.findMany({
    where: eq(schema.mlsBookings.tourId, tourId),
  });
  if (existing.length > 0) {
    // A previous attempt already created the stops — don't double-book.
    await d.update(schema.tours).set({ status: "booked", updatedAt: new Date() }).where(eq(schema.tours.id, tourId));
    return;
  }

  await d.update(schema.tours).set({ status: "planning", updatedAt: new Date() }).where(eq(schema.tours.id, tourId));

  // 1) Resolve MLS numbers (and normalize addresses) via one BrokerBay session.
  const unresolved: string[] = [];
  const stops: RouteStop[] = [];
  const needsBrowser = tour.refs.some((r) => isMlsNumber(r));
  if (needsBrowser) {
    const flow = new BrokerBayDirectFlow(tour.id);
    try {
      await flow.init();
      for (const ref of tour.refs) {
        try {
          const match = await flow.resolveListing(ref);
          stops.push({ ref, address: match.matchedAddress, mlsNumber: match.mlsNumber });
        } catch (err) {
          console.warn(`[tour ${tour.id.slice(0, 8)}] couldn't resolve "${ref}": ${(err as Error).message}`);
          unresolved.push(ref);
        }
      }
    } finally {
      await flow.close().catch(() => undefined);
    }
  } else {
    for (const ref of tour.refs) stops.push({ ref, address: ref, mlsNumber: null });
  }

  if (!stops.length) {
    await d
      .update(schema.tours)
      .set({ status: "needs_attention", error: `None of the listings could be found: ${unresolved.join("; ")}`, updatedAt: new Date() })
      .where(eq(schema.tours.id, tourId));
    await notifyTour(
      tour,
      `[TOUR] couldn't find any of the listings`,
      `I couldn't find these on BrokerBay: ${unresolved.join(", ")}. Double-check the MLS numbers / addresses and resend.`,
    );
    return;
  }

  // 2) Geocode (best-effort; Nominatim etiquette = 1 req/sec).
  for (const s of stops) {
    s.point = (await geocode(s.address)) ?? undefined;
    await new Promise((r) => setTimeout(r, 1100));
  }
  const geocoded = stops.filter((s) => s.point).length;

  // 3) Order by distance and lay out the times.
  const planned = planTourRoute(stops, tour.requestedStart, tour.durationMin);
  const itinerary: TourStopPlan[] = planned.map((s) => ({
    ref: s.ref,
    address: s.address,
    mlsNumber: s.mlsNumber ?? null,
    lat: s.point?.lat,
    lng: s.point?.lng,
    startsAt: s.startsAt.toISOString(),
    travelMinFromPrev: s.travelMinFromPrev,
    distanceKmFromPrev: s.distanceKmFromPrev,
  }));

  // 4) One normal booking per stop, queued in order. Each stop searches by the
  // ORIGINAL ref — that exact string is what already found the listing during
  // resolution; the prettified address is only for routing and display.
  for (let i = 0; i < planned.length; i++) {
    const s = planned[i]!;
    await createBookingRequest({
      address: s.ref,
      requestedStart: s.startsAt,
      durationMin: tour.durationMin,
      notes: tour.notes,
      source: tour.source as "telegram" | "dashboard" | "cli",
      dryRun: tour.dryRun || undefined,
      telegramChatId: tour.notifyTelegramChatId,
      tourId: tour.id,
      tourStop: i + 1,
      // Keep the worker booking them in itinerary order.
      enqueueRunAt: new Date(Date.now() + i * 10_000),
    });
  }

  await d
    .update(schema.tours)
    .set({ status: "booked", itinerary, updatedAt: new Date() })
    .where(eq(schema.tours.id, tourId));

  const orderNote =
    geocoded === stops.length
      ? "ordered by shortest driving route"
      : geocoded > 0
        ? "partially ordered (some addresses couldn't be located — kept your order)"
        : "kept in the order you sent (couldn't locate the addresses to route them)";
  await notifyTour(
    tour,
    `[TOUR] ${planned.length} showings planned${tour.dryRun ? " (dry run)" : ""}`,
    `Itinerary (${orderNote}):\n${itineraryText(itinerary)}` +
      (unresolved.length ? `\n\n⚠️ Not found, skipped: ${unresolved.join(", ")}` : "") +
      `\n\nBooking each stop now — you'll get a message per stop as BrokerBay responds.`,
  );
}
