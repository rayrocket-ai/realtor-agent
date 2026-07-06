import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { runAgentTurn } from "../../agent/loop.js";
import type { JobHandler } from "./index.js";

export const followupHandler: JobHandler = async (payload) => {
  const leadId = String(payload.leadId ?? "");
  const reason = String(payload.reason ?? "scheduled follow-up");
  if (!leadId) throw new Error("followup job missing leadId");

  const d = db();
  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, leadId) });
  if (!lead || lead.paused || ["closed", "lost"].includes(lead.stage)) return;

  // Give the agent the follow-up reason as private context, then run a turn.
  await d.insert(schema.messages).values({
    leadId,
    channel: "gmail",
    direction: "internal_note",
    body: `Scheduled follow-up is due now. Reason: ${reason}. Write a natural, short check-in message to the lead.`,
  });
  await d
    .update(schema.leads)
    .set({ followupAt: null, updatedAt: new Date() })
    .where(eq(schema.leads.id, leadId));

  await runAgentTurn(leadId, "followup");
};
