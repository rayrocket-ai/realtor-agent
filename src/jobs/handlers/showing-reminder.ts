import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { sendToLead } from "../../channels/outbound.js";
import type { JobHandler } from "./index.js";

export const showingReminderHandler: JobHandler = async (payload) => {
  const showingId = String(payload.showingId ?? "");
  const label = String(payload.label ?? "");
  const d = db();

  const showing = await d.query.showings.findFirst({ where: eq(schema.showings.id, showingId) });
  if (!showing || showing.status !== "confirmed") return; // cancelled/rescheduled — skip silently
  if (showing.startsAt.getTime() < Date.now()) return; // already started

  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, showing.leadId) });
  if (!lead || lead.paused) return;

  const c = config();
  const when = new Intl.DateTimeFormat("en-CA", {
    timeZone: c.TZ,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(showing.startsAt);

  const text =
    label === "24h"
      ? `Hi${lead.name ? ` ${lead.name.split(" ")[0]}` : ""}! Quick reminder: your showing at ${showing.propertyAddress} is tomorrow (${when}). Reply here if you need to reschedule. — ${c.REALTOR_NAME}'s assistant`
      : `Reminder: your showing at ${showing.propertyAddress} is coming up at ${when} (in about 2 hours). See you there! — ${c.REALTOR_NAME}'s assistant`;

  await sendToLead(lead, text);
};
