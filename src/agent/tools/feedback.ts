import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { nextFollowup, type BuyerInterest } from "../../feedback/cadence.js";
import { enqueue } from "../../jobs/queue.js";
import type { AgentTool } from "./index.js";

const INTERESTS: BuyerInterest[] = ["hot", "warm", "fifty_fifty", "cold", "no_response"];

export const feedbackTools: AgentTool[] = [
  {
    definition: {
      name: "record_showing_feedback",
      description:
        "Record feedback from a REALTOR who showed one of our listings (use when talking to a showing agent — the internal note names the listing). Captures their buyer's interest level and schedules the right follow-up automatically: hot = 2 days, warm/fifty-fifty = 1 week then 1 month, cold = stop.",
      input_schema: {
        type: "object",
        properties: {
          buyer_interest: { type: "string", enum: INTERESTS },
          notes: {
            type: "string",
            description: "What they said: feedback on the property, buyer budget, timeline, objections",
          },
        },
        required: ["buyer_interest", "notes"],
      },
    },
    handler: async (ctx, input) => {
      const interest = String(input.buyer_interest) as BuyerInterest;
      if (!INTERESTS.includes(interest)) return `buyer_interest must be one of: ${INTERESTS.join(", ")}`;
      const d = db();

      const ls = await d.query.listingShowings.findFirst({
        where: eq(schema.listingShowings.agentLeadId, ctx.lead.id),
        orderBy: (t, { desc }) => desc(t.createdAt),
      });
      if (!ls) return "No listing showing is linked to this contact.";

      const when = nextFollowup(interest, ls.cadenceStage);
      await d
        .update(schema.listingShowings)
        .set({
          buyerInterest: interest,
          feedbackNotes: [ls.feedbackNotes, String(input.notes)].filter(Boolean).join("\n"),
          nextFollowupAt: when,
          followupStatus: when ? "active" : "closed",
          updatedAt: new Date(),
        })
        .where(eq(schema.listingShowings.id, ls.id));

      if (when) {
        await enqueue({
          type: "feedback-followup",
          payload: { listingShowingId: ls.id },
          runAt: when,
          dedupeKey: `feedback-followup:${ls.id}`,
        });
        return `Feedback recorded (${interest}). Next follow-up scheduled for ${when.toISOString().slice(0, 10)}.`;
      }
      return `Feedback recorded (${interest}). No further follow-ups — pipeline closed for this buyer.`;
    },
  },
];
