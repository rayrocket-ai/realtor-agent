import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { runAgentTurn } from "../../agent/loop.js";
import { leadReachable } from "../../channels/outbound.js";
import { enqueue } from "../queue.js";
import type { JobHandler } from "./index.js";

export const followupHandler: JobHandler = async (payload) => {
  const leadId = String(payload.leadId ?? "");
  const reason = String(payload.reason ?? "scheduled follow-up");
  if (!leadId) throw new Error("followup job missing leadId");

  const d = db();
  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, leadId) });
  if (!lead || lead.paused || ["closed", "lost"].includes(lead.stage)) return;

  // No channel the agent could message on (e.g. a phone-only web-form lead):
  // turn the follow-up into a reminder email so the realtor nurtures manually.
  if (!(await leadReachable(lead))) {
    const prefs = (lead.preferences ?? {}) as Record<string, unknown>;
    const lastMsg = await d.query.messages.findFirst({
      where: eq(schema.messages.leadId, leadId),
      orderBy: desc(schema.messages.createdAt),
    });
    const c = config();
    const tags = [prefs.lead_score, prefs.intent].filter(Boolean).join(" ");
    await enqueue({
      type: "notify-realtor",
      payload: {
        subject: `Follow-up due: ${lead.name ?? lead.phone ?? "lead"}${tags ? ` (${tags})` : ""}`,
        body:
          `This lead has no email or messaging channel, so the AI can't reach them — time to follow up yourself.\n\n` +
          `Reason: ${reason}\n` +
          `Phone: ${lead.phone ?? "unknown"}\n` +
          (prefs.preferred_contact ? `Preferred contact: ${String(prefs.preferred_contact)}\n` : "") +
          (lastMsg ? `\nLast activity on their timeline:\n${lastMsg.body}\n` : "") +
          `\nOpen: ${c.APP_BASE_URL}/admin/leads/${leadId}`,
      },
    });
    await d
      .update(schema.leads)
      .set({ followupAt: null, updatedAt: new Date() })
      .where(eq(schema.leads.id, leadId));
    return;
  }

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
