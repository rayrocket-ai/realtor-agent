import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { sendEmail } from "../channels/gmail/send.js";
import { enqueue } from "../jobs/queue.js";
import { offerShortId } from "./template.js";
import type { Offer } from "../db/schema.js";

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72h

export function hashToken(token: string): string {
  return crypto.createHmac("sha256", config().APPROVAL_TOKEN_SECRET).update(token).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Attach a fresh single-use approval token to an offer; returns the raw token. */
export async function issueApprovalToken(offerId: string): Promise<string> {
  const token = generateToken();
  await db()
    .update(schema.offers)
    .set({
      approvalTokenHash: hashToken(token),
      tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      updatedAt: new Date(),
    })
    .where(eq(schema.offers.id, offerId));
  return token;
}

export async function findOfferByToken(token: string): Promise<Offer | null> {
  const offer = await db().query.offers.findFirst({
    where: and(
      eq(schema.offers.approvalTokenHash, hashToken(token)),
      eq(schema.offers.status, "pending_approval"),
    ),
  });
  if (!offer) return null;
  if (offer.tokenExpiresAt && offer.tokenExpiresAt.getTime() < Date.now()) {
    await db()
      .update(schema.offers)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(schema.offers.id, offer.id));
    return null;
  }
  return offer;
}

export interface ApproveEdits {
  subject?: string;
  body?: string;
  recipientEmail?: string;
}

/**
 * THE only code path that sends an offer email — always after a human
 * decision. The agent has no send tool.
 */
export async function approveOffer(
  offerId: string,
  via: "link" | "email_reply" | "dashboard",
  edits: ApproveEdits = {},
): Promise<{ ok: boolean; error?: string }> {
  const d = db();

  // Atomically flip pending_approval -> approved_sent so a token can't be used twice.
  const claimed = await d
    .update(schema.offers)
    .set({
      status: "approved_sent",
      decidedAt: new Date(),
      decidedVia: via,
      approvalTokenHash: null,
      draftEmailSubject: edits.subject !== undefined ? edits.subject : sql`draft_email_subject`,
      draftEmailBody: edits.body !== undefined ? edits.body : sql`draft_email_body`,
      recipientEmail: edits.recipientEmail !== undefined ? edits.recipientEmail : sql`recipient_email`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.offers.id, offerId), eq(schema.offers.status, "pending_approval")))
    .returning();

  const offer = claimed[0];
  if (!offer) return { ok: false, error: "Offer is not pending approval (already decided or expired)." };

  if (!offer.recipientEmail) {
    // Roll back so it can be fixed on the dashboard.
    await d
      .update(schema.offers)
      .set({ status: "pending_approval", decidedAt: null, decidedVia: null, updatedAt: new Date() })
      .where(eq(schema.offers.id, offer.id));
    return { ok: false, error: "No recipient email set — add the listing agent's email on the dashboard first." };
  }

  try {
    await sendEmail({
      to: offer.recipientEmail,
      subject: offer.draftEmailSubject || `Offer — ${offer.propertyAddress}`,
      body: offer.draftEmailBody,
    });
  } catch (err) {
    await d
      .update(schema.offers)
      .set({ status: "pending_approval", decidedAt: null, decidedVia: null, updatedAt: new Date() })
      .where(eq(schema.offers.id, offer.id));
    return { ok: false, error: `Sending failed: ${(err as Error).message}` };
  }

  await d
    .update(schema.leads)
    .set({ stage: "offer_sent", updatedAt: new Date() })
    .where(eq(schema.leads.id, offer.leadId));

  await d.insert(schema.messages).values({
    leadId: offer.leadId,
    channel: "gmail",
    direction: "internal_note",
    body: `Offer on ${offer.propertyAddress} approved (${via}) and emailed to ${offer.recipientEmail}.`,
  });

  // Let the lead know on their channel via the agent's next turn.
  await enqueue({
    type: "agent-turn",
    payload: { leadId: offer.leadId, reason: "offer_sent" },
    dedupeKey: `agent-turn:${offer.leadId}`,
  });

  return { ok: true };
}

export async function rejectOffer(
  offerId: string,
  via: "link" | "email_reply" | "dashboard",
  feedback: string,
): Promise<{ ok: boolean; error?: string }> {
  const d = db();
  const claimed = await d
    .update(schema.offers)
    .set({
      status: "rejected",
      decidedAt: new Date(),
      decidedVia: via,
      rejectionFeedback: feedback || null,
      approvalTokenHash: null,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.offers.id, offerId), eq(schema.offers.status, "pending_approval")))
    .returning();

  const offer = claimed[0];
  if (!offer) return { ok: false, error: "Offer is not pending approval." };

  await d.insert(schema.messages).values({
    leadId: offer.leadId,
    channel: "gmail",
    direction: "internal_note",
    body: `Offer on ${offer.propertyAddress} was rejected by ${config().REALTOR_NAME}${
      feedback ? ` with feedback: ${feedback}` : ""
    }. Revise the offer accordingly before drafting again.`,
  });

  await enqueue({
    type: "agent-turn",
    payload: { leadId: offer.leadId, reason: "offer_rejected" },
    dedupeKey: `agent-turn:${offer.leadId}`,
  });

  return { ok: true };
}

/** Handle the realtor replying to a "[OFFER-xxxxxxxx]" approval email. */
export async function handleOfferReply(subject: string, body: string): Promise<void> {
  const m = subject.match(/\[OFFER-([0-9a-f]{8})\]/i);
  if (!m) return;
  const shortId = m[1]!.toLowerCase();

  const pending = await db().query.offers.findMany({
    where: eq(schema.offers.status, "pending_approval"),
  });
  const offer = pending.find((o) => offerShortId(o.id) === shortId);
  if (!offer) return;

  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith(">"));
  const text = (firstLine ?? "").toLowerCase();

  if (/^(approve|approved|yes|send it|send|ok|👍)\b/.test(text)) {
    const res = await approveOffer(offer.id, "email_reply");
    if (!res.ok) console.error("[offers] email-reply approval failed:", res.error);
  } else if (text.length > 0) {
    await rejectOffer(offer.id, "email_reply", firstLine ?? "");
  }
}
