import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { sendEmail } from "./gmail/send.js";
import { sendBoosendMessage } from "./boosend/client.js";
import { sendTelegramMessage } from "./telegram/client.js";
import type { Lead } from "../db/schema.js";

/**
 * Send a message to a lead on their most recent inbound channel and record
 * it on the timeline. Used by the agent loop, reminders, and the dashboard's
 * manual-send box.
 */
export async function sendToLead(lead: Lead, text: string): Promise<void> {
  const d = db();
  const lastInbound = await d.query.messages.findFirst({
    where: and(eq(schema.messages.leadId, lead.id), eq(schema.messages.direction, "inbound")),
    orderBy: desc(schema.messages.createdAt),
  });
  let channel = lastInbound?.channel ?? "gmail";

  // The public lead form is not a messageable channel: fall back to email
  // when the lead left one, otherwise this lead can only be reached manually.
  if (channel === "webform") {
    if (!lead.email) {
      throw new Error(
        `Lead ${lead.id} came from the web form with no email — reach out by phone/WhatsApp instead.`,
      );
    }
    channel = "gmail";
    await d
      .insert(schema.channelIdentities)
      .values({ leadId: lead.id, channel: "gmail", externalId: lead.email })
      .onConflictDoNothing();
  }

  let identity = await d.query.channelIdentities.findFirst({
    where: and(
      eq(schema.channelIdentities.leadId, lead.id),
      eq(schema.channelIdentities.channel, channel),
    ),
  });
  if (!identity && lead.email) {
    await d
      .insert(schema.channelIdentities)
      .values({ leadId: lead.id, channel: "gmail", externalId: lead.email })
      .onConflictDoNothing();
    identity = await d.query.channelIdentities.findFirst({
      where: and(
        eq(schema.channelIdentities.leadId, lead.id),
        eq(schema.channelIdentities.channel, "gmail"),
      ),
    });
    if (identity) channel = "gmail";
  }
  if (!identity) {
    const identities = await d.query.channelIdentities.findMany({
      where: eq(schema.channelIdentities.leadId, lead.id),
    });
    identity = identities.find((candidate) => candidate.channel !== "webform");
    if (identity) channel = identity.channel;
  }
  if (!identity) throw new Error(`Lead ${lead.id} has no reachable channel identity`);

  let externalMsgId: string | null = null;
  const c = config();
  const dryRun =
    (channel === "gmail" && !c.gmailEnabled) ||
    (channel === "telegram" && !c.telegramEnabled) ||
    (channel !== "gmail" && channel !== "telegram" && !c.boosendEnabled);
  if (dryRun) {
    // Dev/test without channel credentials: record the message, skip the send.
    console.log(`[outbound:dry-run] (${channel}) -> ${identity.externalId}: ${text.slice(0, 200)}`);
  } else if (channel === "telegram") {
    const res = await sendTelegramMessage(identity.externalId, text);
    externalMsgId = res.id ? `tg:${identity.externalId}:${res.id}` : null;
  } else if (channel === "gmail") {
    const meta = (lastInbound?.meta ?? {}) as { subject?: string; rfcMessageId?: string };
    const subject = meta.subject
      ? meta.subject.startsWith("Re:")
        ? meta.subject
        : `Re: ${meta.subject}`
      : "Your real estate inquiry";
    externalMsgId = await sendEmail({
      to: identity.externalId,
      subject,
      body: text,
      threadId: identity.threadRef,
      inReplyTo: meta.rfcMessageId ?? null,
    });
  } else {
    const res = await sendBoosendMessage({
      channel,
      contactId: identity.externalId,
      conversationId: identity.threadRef,
      text,
    });
    externalMsgId = res.id;
  }

  await d.insert(schema.messages).values({
    leadId: lead.id,
    channel,
    direction: "outbound",
    body: text,
    externalMsgId,
  });
}

/**
 * Whether sendToLead has any channel it could deliver on. False for e.g.
 * phone-only web-form leads, who can only be contacted manually.
 */
export async function leadReachable(lead: Lead): Promise<boolean> {
  if (lead.email) return true;
  const identities = await db().query.channelIdentities.findMany({
    where: eq(schema.channelIdentities.leadId, lead.id),
  });
  return identities.some((i) => i.channel !== "webform");
}
