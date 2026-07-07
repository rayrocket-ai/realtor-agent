import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { enqueue } from "../jobs/queue.js";
import type { BrokerBayEvent } from "../channels/brokerbay/parse.js";
import type { Lead, Listing } from "../db/schema.js";

const FEEDBACK_DELAY_MS = 4 * 60 * 60 * 1000; // ask 4h after the showing
const MATCH_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Loose address match: same street number + first street word. */
export function addressMatches(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na.includes(nb) || nb.includes(na)) return true;
  const pa = na.match(/^(\d+)\s+(\w+)/);
  const pb = nb.match(/^(\d+)\s+(\w+)/);
  return Boolean(pa && pb && pa[1] === pb[1] && pa[2] === pb[2]);
}

async function findListing(address: string): Promise<Listing | null> {
  const all = await db().query.listings.findMany({ where: eq(schema.listings.status, "active") });
  return all.find((l) => addressMatches(l.propertyAddress, address)) ?? null;
}

/** Get-or-create a lead record for an outside showing agent (so the normal conversation pipeline works). */
async function agentContactLead(ev: BrokerBayEvent, listing: Listing): Promise<Lead | null> {
  if (!ev.agentEmail && !ev.agentPhone) return null;
  const d = db();
  let lead: Lead | undefined;
  if (ev.agentEmail) {
    lead = await d.query.leads.findFirst({ where: eq(schema.leads.email, ev.agentEmail) });
  }
  if (!lead) {
    lead = (
      await d
        .insert(schema.leads)
        .values({
          name: ev.agentName,
          email: ev.agentEmail,
          phone: ev.agentPhone,
          stage: "engaged",
          preferences: { role: "showing_agent", listingAddress: listing.propertyAddress },
        })
        .returning()
    )[0]!;
    if (ev.agentEmail) {
      await d
        .insert(schema.channelIdentities)
        .values({ leadId: lead.id, channel: "gmail", externalId: ev.agentEmail })
        .onConflictDoNothing();
    }
  }
  return lead;
}

/**
 * Route a parsed BrokerBay email:
 * - showing ON one of Ray's listings → listing_showings + feedback pipeline
 * - otherwise → try to enrich a buyer-side showing (lockbox, status)
 */
export async function ingestBrokerBayEvent(ev: BrokerBayEvent): Promise<string> {
  if (!ev.address) return "ignored: no address parsed";
  const d = db();

  const listing = await findListing(ev.address);
  if (listing) {
    const lead = await agentContactLead(ev, listing);
    const status =
      ev.kind === "confirmed"
        ? "confirmed"
        : ev.kind === "declined"
          ? "declined"
          : ev.kind === "cancelled"
            ? "cancelled"
            : ev.kind === "requested"
              ? "requested"
              : "confirmed";

    const [row] = await d
      .insert(schema.listingShowings)
      .values({
        listingId: listing.id,
        agentName: ev.agentName,
        agentEmail: ev.agentEmail,
        agentPhone: ev.agentPhone,
        agentLeadId: lead?.id ?? null,
        startsAt: ev.startsAt,
        status,
      })
      .returning();

    if (status === "confirmed" && lead) {
      const base = ev.startsAt ? ev.startsAt.getTime() : Date.now();
      await enqueue({
        type: "feedback-request",
        payload: { listingShowingId: row!.id },
        runAt: new Date(Math.max(base + FEEDBACK_DELAY_MS, Date.now() + 60_000)),
        dedupeKey: `feedback-request:${row!.id}`,
      });
    }
    return `listing showing recorded (${status}) for ${listing.propertyAddress}`;
  }

  // Buyer side: enrich an existing showing with lockbox/instructions/status.
  const candidates = ev.startsAt
    ? await d.query.showings.findMany({
        where: and(
          gte(schema.showings.startsAt, new Date(ev.startsAt.getTime() - MATCH_WINDOW_MS)),
          lte(schema.showings.startsAt, new Date(ev.startsAt.getTime() + MATCH_WINDOW_MS)),
        ),
      })
    : await d.query.showings.findMany({ where: eq(schema.showings.status, "confirmed") });

  const target = candidates.find((s) => addressMatches(s.propertyAddress, ev.address!));
  if (!target) return "ignored: no matching showing or listing";

  await d
    .update(schema.showings)
    .set({
      lockboxCode: ev.lockboxCode ?? target.lockboxCode,
      instructions: ev.instructions ?? target.instructions,
      confirmationStatus:
        ev.kind === "confirmed"
          ? "confirmed"
          : ev.kind === "declined" || ev.kind === "cancelled"
            ? "declined"
            : target.confirmationStatus,
    })
    .where(eq(schema.showings.id, target.id));

  if (ev.kind === "declined" || ev.kind === "cancelled") {
    await enqueue({
      type: "agent-turn",
      payload: { leadId: target.leadId, reason: "showing_declined" },
      dedupeKey: `agent-turn:${target.leadId}`,
    });
    await d.insert(schema.messages).values({
      leadId: target.leadId,
      channel: "gmail",
      direction: "internal_note",
      body: `BrokerBay: the showing at ${target.propertyAddress} was ${ev.kind}. Let the lead know and offer to rebook.`,
    });
  }
  return `buyer showing enriched: ${target.propertyAddress} (${ev.kind})`;
}
