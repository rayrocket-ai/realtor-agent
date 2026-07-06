import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { enqueue } from "../../jobs/queue.js";
import type { AgentTool } from "./index.js";

export const escalateTools: AgentTool[] = [
  {
    definition: {
      name: "escalate_to_human",
      description:
        "Hand this conversation to the realtor. Pauses automatic replies for this lead and notifies the realtor immediately. Use for legal/financing questions, upset leads, requests to speak to the realtor, or anything you cannot safely handle.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you're escalating" },
          urgency: { type: "string", enum: ["low", "normal", "high"] },
        },
        required: ["reason"],
      },
    },
    handler: async (ctx, input) => {
      const c = config();
      await db()
        .update(schema.leads)
        .set({ paused: true, updatedAt: new Date() })
        .where(eq(schema.leads.id, ctx.lead.id));

      await db().insert(schema.messages).values({
        leadId: ctx.lead.id,
        channel: "gmail",
        direction: "internal_note",
        body: `Escalated to ${c.REALTOR_NAME} (${String(input.urgency ?? "normal")}): ${String(input.reason)}`,
      });

      await enqueue({
        type: "notify-realtor",
        payload: {
          subject: `[${String(input.urgency ?? "normal").toUpperCase()}] Lead needs you: ${ctx.lead.name ?? ctx.lead.email ?? ctx.lead.id}`,
          body:
            `${String(input.reason)}\n\n` +
            `Lead: ${ctx.lead.name ?? "unknown"} | ${ctx.lead.email ?? ""} ${ctx.lead.phone ?? ""}\n` +
            `Timeline: ${c.APP_BASE_URL}/admin/leads/${ctx.lead.id}\n\n` +
            `Automatic replies for this lead are paused until you unpause them on the dashboard.`,
        },
      });

      return "Escalated. Automatic replies for this lead are now paused. Let the lead know the realtor will reach out personally soon.";
    },
  },
];
