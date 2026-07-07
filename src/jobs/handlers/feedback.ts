import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { runAgentTurn } from "../../agent/loop.js";
import { nextFollowup, type BuyerInterest } from "../../feedback/cadence.js";
import { enqueue } from "../queue.js";
import type { JobHandler } from "./index.js";

async function loadShowingContext(listingShowingId: string) {
  const d = db();
  const ls = await d.query.listingShowings.findFirst({
    where: eq(schema.listingShowings.id, listingShowingId),
  });
  if (!ls?.agentLeadId) return null;
  const listing = await d.query.listings.findFirst({
    where: eq(schema.listings.id, ls.listingId),
  });
  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, ls.agentLeadId) });
  if (!listing || !lead || lead.paused) return null;
  return { ls, listing, lead };
}

/** First touch after a showing on one of Ray's listings: ask the agent for feedback. */
export const feedbackRequestHandler: JobHandler = async (payload) => {
  const ctx = await loadShowingContext(String(payload.listingShowingId ?? ""));
  if (!ctx || ctx.ls.followupStatus !== "active") return;
  const d = db();
  await d.insert(schema.messages).values({
    leadId: ctx.lead.id,
    channel: "gmail",
    direction: "internal_note",
    body:
      `This contact is a REALTOR who showed our listing at ${ctx.listing.propertyAddress}` +
      `${ctx.ls.startsAt ? ` on ${ctx.ls.startsAt.toDateString()}` : ""}. ` +
      `Write a short collegial note: thank them for showing, ask for their and their buyer's feedback, ` +
      `and gently probe buyer budget/timeline. When they answer, use record_showing_feedback.`,
  });
  await runAgentTurn(ctx.lead.id, "feedback-request");
};

/** Scheduled re-touch based on the cadence (hot=2d, warm=1w/1m/3m...). */
export const feedbackFollowupHandler: JobHandler = async (payload) => {
  const ctx = await loadShowingContext(String(payload.listingShowingId ?? ""));
  if (!ctx || ctx.ls.followupStatus !== "active") return;
  const d = db();

  const interest = (ctx.ls.buyerInterest ?? "no_response") as BuyerInterest;
  const newStage = ctx.ls.cadenceStage + 1;
  const after = nextFollowup(interest, newStage);

  await d
    .update(schema.listingShowings)
    .set({
      cadenceStage: newStage,
      nextFollowupAt: after,
      followupStatus: after ? "active" : "closed",
      updatedAt: new Date(),
    })
    .where(eq(schema.listingShowings.id, ctx.ls.id));

  await d.insert(schema.messages).values({
    leadId: ctx.lead.id,
    channel: "gmail",
    direction: "internal_note",
    body:
      `Scheduled follow-up (stage ${newStage}, buyer was "${interest}") about our listing at ` +
      `${ctx.listing.propertyAddress}. Check in naturally: is their buyer still interested? Anything changed? ` +
      `Update with record_showing_feedback if you learn something new.`,
  });
  await runAgentTurn(ctx.lead.id, "feedback-followup");

  if (after) {
    await enqueue({
      type: "feedback-followup",
      payload: { listingShowingId: ctx.ls.id },
      runAt: after,
      dedupeKey: `feedback-followup:${ctx.ls.id}`,
    });
  }
};
