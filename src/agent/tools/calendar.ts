import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { findFreeSlots, createEvent, updateEvent, deleteEvent } from "../../channels/gcal/client.js";
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

async function scheduleReminders(showingId: string, startsAt: Date): Promise<void> {
  const offsets: Array<[string, number]> = [
    ["24h", 24 * 60 * 60 * 1000],
    ["2h", 2 * 60 * 60 * 1000],
  ];
  for (const [label, ms] of offsets) {
    const runAt = new Date(startsAt.getTime() - ms);
    if (runAt.getTime() > Date.now()) {
      await enqueue({
        type: "showing-reminder",
        payload: { showingId, label },
        runAt,
        dedupeKey: `showing-reminder:${showingId}:${label}`,
      });
    }
  }
}

export const calendarTools: AgentTool[] = [
  {
    definition: {
      name: "check_availability",
      description:
        "Find open time slots on the realtor's calendar for a showing. Returns available start times within working hours. Always call this before proposing times to a lead.",
      input_schema: {
        type: "object",
        properties: {
          range_start: {
            type: "string",
            description: "ISO 8601 start of the search window, e.g. 2026-07-05T00:00:00-04:00",
          },
          range_end: { type: "string", description: "ISO 8601 end of the search window" },
          duration_min: {
            type: "integer",
            description: "Showing duration in minutes (default 45)",
          },
        },
        required: ["range_start", "range_end"],
      },
    },
    handler: async (_ctx, input) => {
      const start = new Date(String(input.range_start));
      const end = new Date(String(input.range_end));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return "Invalid dates. Provide ISO 8601 range_start and range_end.";
      }
      const duration = Number(input.duration_min ?? 45);
      const slots = await findFreeSlots(start, end, duration);
      if (!slots.length) return "No free slots in that window. Try a different day or a wider range.";
      return (
        "Available slots (Toronto time):\n" +
        slots
          .slice(0, 8)
          .map((s) => `- ${fmt(s.start)} (starts ${s.start.toISOString()})`)
          .join("\n")
      );
    },
  },
  {
    definition: {
      name: "book_showing",
      description:
        "Book a property showing on the realtor's calendar and confirm it. Only call after the lead has agreed to a specific time you verified with check_availability.",
      input_schema: {
        type: "object",
        properties: {
          property_address: { type: "string" },
          mls_number: { type: "string" },
          starts_at: { type: "string", description: "ISO 8601 start time (use the exact 'starts' value from check_availability)" },
          duration_min: { type: "integer", description: "Duration in minutes (default 45)" },
        },
        required: ["property_address", "starts_at"],
      },
    },
    handler: async (ctx, input) => {
      const startsAt = new Date(String(input.starts_at));
      if (Number.isNaN(startsAt.getTime())) return "Invalid starts_at — provide ISO 8601.";
      const duration = Number(input.duration_min ?? 45);
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);
      const address = String(input.property_address);

      // Conflict check right before booking.
      const free = await findFreeSlots(startsAt, endsAt, duration);
      const exact = free.some((s) => s.start.getTime() === startsAt.getTime());
      if (!exact) {
        return `That time is no longer available. Re-run check_availability and propose new times.`;
      }

      const c = config();
      const eventId = await createEvent({
        summary: `Showing: ${address}${input.mls_number ? ` (MLS ${input.mls_number})` : ""} — ${ctx.lead.name ?? "lead"}`,
        description: `Booked by ${c.REALTOR_NAME}'s AI assistant.\nLead: ${ctx.lead.name ?? ""} ${ctx.lead.email ?? ""} ${ctx.lead.phone ?? ""}`,
        location: address,
        start: startsAt,
        end: endsAt,
        attendeeEmail: ctx.lead.email,
      });

      const [showing] = await db()
        .insert(schema.showings)
        .values({
          leadId: ctx.lead.id,
          propertyAddress: address,
          mlsNumber: input.mls_number ? String(input.mls_number) : null,
          startsAt,
          endsAt,
          gcalEventId: eventId,
          status: "confirmed",
          remindersScheduled: true,
        })
        .returning();

      await scheduleReminders(showing!.id, startsAt);
      await db()
        .update(schema.leads)
        .set({ stage: "showing_booked", updatedAt: new Date() })
        .where(eq(schema.leads.id, ctx.lead.id));

      return `Booked: ${address} on ${fmt(startsAt)} (showing id: ${showing!.id}). Calendar invite ${ctx.lead.email ? "sent to the lead's email" : "created"}. Reminders scheduled for 24h and 2h before.`;
    },
  },
  {
    definition: {
      name: "cancel_showing",
      description: "Cancel a booked showing (removes the calendar event and reminders).",
      input_schema: {
        type: "object",
        properties: {
          showing_id: { type: "string", description: "The showing id from the lead brief" },
        },
        required: ["showing_id"],
      },
    },
    handler: async (ctx, input) => {
      const showing = await db().query.showings.findFirst({
        where: eq(schema.showings.id, String(input.showing_id)),
      });
      if (!showing || showing.leadId !== ctx.lead.id) return "Showing not found for this lead.";
      if (showing.gcalEventId) await deleteEvent(showing.gcalEventId);
      await db()
        .update(schema.showings)
        .set({ status: "cancelled" })
        .where(eq(schema.showings.id, showing.id));
      return `Cancelled the showing at ${showing.propertyAddress} (${fmt(showing.startsAt)}).`;
    },
  },
  {
    definition: {
      name: "reschedule_showing",
      description:
        "Move a booked showing to a new time. Verify the new time with check_availability first.",
      input_schema: {
        type: "object",
        properties: {
          showing_id: { type: "string" },
          new_starts_at: { type: "string", description: "ISO 8601 new start time" },
        },
        required: ["showing_id", "new_starts_at"],
      },
    },
    handler: async (ctx, input) => {
      const showing = await db().query.showings.findFirst({
        where: eq(schema.showings.id, String(input.showing_id)),
      });
      if (!showing || showing.leadId !== ctx.lead.id) return "Showing not found for this lead.";
      const newStart = new Date(String(input.new_starts_at));
      if (Number.isNaN(newStart.getTime())) return "Invalid new_starts_at — provide ISO 8601.";
      const durationMs = showing.endsAt.getTime() - showing.startsAt.getTime();
      const newEnd = new Date(newStart.getTime() + durationMs);

      if (showing.gcalEventId) await updateEvent(showing.gcalEventId, { start: newStart, end: newEnd });
      await db()
        .update(schema.showings)
        .set({ startsAt: newStart, endsAt: newEnd })
        .where(eq(schema.showings.id, showing.id));
      await scheduleReminders(showing.id, newStart);
      return `Rescheduled ${showing.propertyAddress} to ${fmt(newStart)}.`;
    },
  },
];
