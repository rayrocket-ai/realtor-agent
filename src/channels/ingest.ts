import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { enqueue } from "../jobs/queue.js";
import type { Lead } from "../db/schema.js";

const AGENT_TURN_DEBOUNCE_MS = 60_000;
const HUMAN_TAKEOVER_PAUSE_MS = 4 * 60 * 60 * 1000; // 4h

export interface InboundMessage {
  channel: string; // gmail|whatsapp|instagram|telegram
  externalId: string; // sender email address or boosend contact id
  threadRef?: string | null;
  externalMsgId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  body: string;
  meta?: Record<string, unknown>;
  /** Message written by the realtor themselves (own Gmail send / Boosend console reply). */
  fromRealtor?: boolean;
}

/** Find or create the lead for a channel identity. */
export async function resolveLead(msg: InboundMessage): Promise<Lead> {
  const d = db();
  const identity = await d.query.channelIdentities.findFirst({
    where: and(
      eq(schema.channelIdentities.channel, msg.channel),
      eq(schema.channelIdentities.externalId, msg.externalId),
    ),
  });

  if (identity) {
    if (msg.threadRef && identity.threadRef !== msg.threadRef) {
      await d
        .update(schema.channelIdentities)
        .set({ threadRef: msg.threadRef })
        .where(eq(schema.channelIdentities.id, identity.id));
    }
    const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, identity.leadId) });
    if (lead) return lead;
  }

  // Try to merge by email/phone before creating a fresh lead.
  let existing: Lead | undefined;
  if (msg.email) {
    existing = await d.query.leads.findFirst({ where: eq(schema.leads.email, msg.email) });
  }
  if (!existing && msg.phone) {
    existing = await d.query.leads.findFirst({ where: eq(schema.leads.phone, msg.phone) });
  }

  const lead =
    existing ??
    (
      await d
        .insert(schema.leads)
        .values({
          name: msg.name ?? null,
          email: msg.email ?? (msg.channel === "gmail" ? msg.externalId : null),
          phone: msg.phone ?? null,
        })
        .returning()
    )[0]!;

  await d
    .insert(schema.channelIdentities)
    .values({
      leadId: lead.id,
      channel: msg.channel,
      externalId: msg.externalId,
      threadRef: msg.threadRef ?? null,
    })
    .onConflictDoNothing();

  return lead;
}

export interface IngestResult {
  leadId: string;
  stored: boolean; // false when deduped by externalMsgId
}

/**
 * Store an inbound message on the unified timeline and schedule a debounced
 * agent turn. Realtor-authored messages pause the agent instead.
 */
export async function ingestInbound(msg: InboundMessage): Promise<IngestResult> {
  const d = db();
  const lead = await resolveLead(msg);

  const inserted = await d
    .insert(schema.messages)
    .values({
      leadId: lead.id,
      channel: msg.channel,
      direction: msg.fromRealtor ? "internal_note" : "inbound",
      body: msg.body,
      externalMsgId: msg.externalMsgId ?? null,
      meta: msg.meta ?? {},
    })
    .onConflictDoNothing({ target: schema.messages.externalMsgId })
    .returning({ id: schema.messages.id });

  if (inserted.length === 0) return { leadId: lead.id, stored: false };

  if (msg.fromRealtor) {
    // Human is talking on this thread — stand down for a while.
    await d
      .update(schema.leads)
      .set({ pausedUntil: new Date(Date.now() + HUMAN_TAKEOVER_PAUSE_MS), updatedAt: new Date() })
      .where(eq(schema.leads.id, lead.id));
    return { leadId: lead.id, stored: true };
  }

  // Update lightweight profile fields opportunistically.
  const patch: Partial<typeof schema.leads.$inferInsert> = { updatedAt: new Date() };
  if (!lead.name && msg.name) patch.name = msg.name;
  if (!lead.phone && msg.phone) patch.phone = msg.phone;
  if (!lead.email && msg.email) patch.email = msg.email;
  if (lead.stage === "new") patch.stage = "engaged";
  await d.update(schema.leads).set(patch).where(eq(schema.leads.id, lead.id));

  await enqueue({
    type: "agent-turn",
    payload: { leadId: lead.id },
    runAt: new Date(Date.now() + AGENT_TURN_DEBOUNCE_MS),
    dedupeKey: `agent-turn:${lead.id}`,
  });

  return { leadId: lead.id, stored: true };
}
