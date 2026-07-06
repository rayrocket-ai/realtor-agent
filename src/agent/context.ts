import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import type { Lead, Offer, Showing } from "../db/schema.js";

const TIMELINE_LIMIT = 40;

export interface AgentContext {
  lead: Lead;
  showings: Showing[];
  offers: Offer[];
  transcript: string;
}

export async function buildContext(leadId: string): Promise<AgentContext | null> {
  const d = db();
  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, leadId) });
  if (!lead) return null;

  const [msgs, showings, offers] = await Promise.all([
    d.query.messages.findMany({
      where: eq(schema.messages.leadId, leadId),
      orderBy: desc(schema.messages.createdAt),
      limit: TIMELINE_LIMIT,
    }),
    d.query.showings.findMany({
      where: and(
        eq(schema.showings.leadId, leadId),
        inArray(schema.showings.status, ["proposed", "confirmed"]),
      ),
    }),
    d.query.offers.findMany({ where: eq(schema.offers.leadId, leadId) }),
  ]);

  const c = config();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: c.TZ,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const lines = msgs
    .reverse()
    .map((m) => {
      const who =
        m.direction === "inbound"
          ? "LEAD"
          : m.direction === "outbound"
            ? "YOU"
            : "[internal note]";
      return `[${fmt.format(m.createdAt)}] [${m.channel}] ${who}: ${m.body.slice(0, 2000)}`;
    })
    .join("\n");

  return { lead, showings, offers, transcript: lines };
}

export function renderLeadBrief(ctx: AgentContext): string {
  const c = config();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: c.TZ,
    dateStyle: "full",
    timeStyle: "short",
  });
  const l = ctx.lead;
  const parts = [
    `Current date/time: ${fmt.format(new Date())} (${c.TZ})`,
    "",
    "## Lead profile",
    `- Name: ${l.name ?? "unknown"}`,
    `- Email: ${l.email ?? "unknown"}`,
    `- Phone: ${l.phone ?? "unknown"}`,
    `- Stage: ${l.stage}`,
    `- Preferences: ${JSON.stringify(l.preferences ?? {})}`,
    l.notes ? `- Notes: ${l.notes}` : null,
  ];

  if (ctx.showings.length) {
    parts.push("", "## Upcoming showings");
    for (const s of ctx.showings) {
      parts.push(`- ${s.propertyAddress} at ${fmt.format(s.startsAt)} (${s.status}, id: ${s.id})`);
    }
  }
  if (ctx.offers.length) {
    parts.push("", "## Offers");
    for (const o of ctx.offers) {
      parts.push(`- ${o.propertyAddress}: ${o.status}${o.rejectionFeedback ? ` — feedback: ${o.rejectionFeedback}` : ""}`);
    }
  }

  parts.push("", "## Conversation so far", ctx.transcript || "(no messages yet)");
  parts.push(
    "",
    "Reply to the lead now. Use tools as needed first; your final plain-text message is what gets sent.",
  );
  return parts.filter((p): p is string => p !== null).join("\n");
}
