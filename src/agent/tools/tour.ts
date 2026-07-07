import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { mapsClient } from "../../channels/maps.js";
import { planTour, renderItinerary } from "../../tours/planner.js";
import { enqueue } from "../../jobs/queue.js";
import type { AgentTool } from "./index.js";

function fmt(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export const tourTools: AgentTool[] = [
  {
    definition: {
      name: "plan_showing_tour",
      description:
        "Plan a multi-property showing tour with realistic drive times from the office and between stops. Returns an ordered, timed schedule. Use when the lead wants to see 2+ properties in one outing. After the lead agrees, book each stop with book_showing (passing tour_id and the exact times from this plan).",
      input_schema: {
        type: "object",
        properties: {
          addresses: {
            type: "array",
            items: { type: "string" },
            description: "Full property addresses to visit (2-8)",
          },
          window_start: {
            type: "string",
            description: "ISO 8601 datetime the tour can begin (lead's earliest availability)",
          },
          duration_min: { type: "integer", description: "Minutes per showing (default 30)" },
        },
        required: ["addresses", "window_start"],
      },
    },
    handler: async (ctx, input) => {
      const addresses = Array.isArray(input.addresses) ? input.addresses.map(String) : [];
      if (addresses.length < 2 || addresses.length > 8) {
        return "Provide 2-8 addresses for a tour (for one property just use check_availability + book_showing).";
      }
      const windowStart = new Date(String(input.window_start));
      if (Number.isNaN(windowStart.getTime())) return "Invalid window_start — provide ISO 8601.";
      const durationMin = Number(input.duration_min ?? 30);

      const c = config();
      const stops = [c.OFFICE_ADDRESS, ...addresses];
      let matrix: Array<Array<number | null>>;
      try {
        matrix = await mapsClient().driveMatrix(stops);
      } catch (err) {
        return `Could not compute drive times (${(err as Error).message}). Plan with generous 30-min gaps instead.`;
      }

      const plan = planTour({ addresses, matrixMinutes: matrix, windowStart, durationMin });

      const tourDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: c.TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(windowStart);

      const [tour] = await db()
        .insert(schema.tours)
        .values({ leadId: ctx.lead.id, tourDate, status: "proposed" })
        .returning();

      const lines = plan.legs.map(
        (leg, i) =>
          `${i + 1}. ${leg.address} — ${fmt(leg.startsAt)} to ${fmt(leg.endsAt)} (drive ${leg.travelMinutesFromPrev} min${i === 0 ? " from office" : ""}) [starts_at: ${leg.startsAt.toISOString()}]`,
      );
      return (
        `Proposed tour (id: ${tour!.id}), total ~${plan.totalMinutes} min:\n` +
        lines.join("\n") +
        `\nPropose these times to the lead. Once they agree, call book_showing for EACH stop using the exact starts_at values and tour_id ${tour!.id}. Note: ${c.REALTOR_NAME} must still confirm each showing through BrokerBay — tell the lead times are "requested, pending listing-side confirmation".`
      );
    },
  },
  {
    definition: {
      name: "finalize_tour",
      description:
        "After booking all stops of a tour, generate the itinerary (times, drive legs, lockboxes when known) and send it to the realtor. Call once per tour when every stop is booked.",
      input_schema: {
        type: "object",
        properties: { tour_id: { type: "string" } },
        required: ["tour_id"],
      },
    },
    handler: async (ctx, input) => {
      const d = db();
      const tour = await d.query.tours.findFirst({
        where: eq(schema.tours.id, String(input.tour_id)),
      });
      if (!tour || tour.leadId !== ctx.lead.id) return "Tour not found for this lead.";

      const legs = await d.query.showings.findMany({
        where: and(eq(schema.showings.tourId, tour.id)),
        orderBy: asc(schema.showings.startsAt),
      });
      if (!legs.length) return "No showings are linked to this tour yet — book them first with book_showing.";

      const c = config();
      const md = renderItinerary({
        leadName: ctx.lead.name ?? "lead",
        tourDate: tour.tourDate,
        timeZone: c.TZ,
        legs: legs.map((s) => ({
          address: s.propertyAddress,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          travelMinutesFromPrev: s.travelMinutesFromPrev,
          lockboxCode: s.lockboxCode,
          instructions: s.instructions,
          confirmationStatus: s.confirmationStatus,
        })),
      });

      await d
        .update(schema.tours)
        .set({ status: "booked", itineraryMd: md, updatedAt: new Date() })
        .where(eq(schema.tours.id, tour.id));

      await enqueue({
        type: "notify-realtor",
        payload: {
          subject: `Tour itinerary — ${tour.tourDate} with ${ctx.lead.name ?? "lead"} (${legs.length} stops)`,
          body:
            md +
            `\n\nLockboxes/instructions fill in automatically as BrokerBay confirmations arrive.` +
            `\nLive view: ${c.APP_BASE_URL}/admin/tours`,
        },
      });
      return "Itinerary generated and sent to the realtor. Lockbox codes will be added as BrokerBay confirmations come in.";
    },
  },
  {
    definition: {
      name: "request_showing_change",
      description:
        "Ask the realtor to reschedule or cancel a showing in BrokerBay (bookings on other agents' listings can only be changed there, by a human). Prepares the exact change and notifies the realtor. Use when the lead can't make a time.",
      input_schema: {
        type: "object",
        properties: {
          showing_id: { type: "string" },
          change: { type: "string", description: "What to do, e.g. 'move to Sat 3pm' or 'cancel'" },
        },
        required: ["showing_id", "change"],
      },
    },
    handler: async (ctx, input) => {
      const showing = await db().query.showings.findFirst({
        where: eq(schema.showings.id, String(input.showing_id)),
      });
      if (!showing || showing.leadId !== ctx.lead.id) return "Showing not found for this lead.";
      const c = config();
      await enqueue({
        type: "notify-realtor",
        payload: {
          subject: `[ACTION] BrokerBay change needed: ${showing.propertyAddress}`,
          body:
            `Lead ${ctx.lead.name ?? ""} needs a change to the showing at ${showing.propertyAddress} ` +
            `(currently ${fmt(showing.startsAt)}):\n\n  ${String(input.change)}\n\n` +
            `Please make this change in BrokerBay. The calendar/records here will sync when the confirmation email arrives.\n` +
            `Timeline: ${c.APP_BASE_URL}/admin/leads/${ctx.lead.id}`,
        },
      });
      return `Change request sent to ${c.REALTOR_NAME} (BrokerBay changes need a human). Tell the lead the change is being processed and will be confirmed shortly.`;
    },
  },
];
