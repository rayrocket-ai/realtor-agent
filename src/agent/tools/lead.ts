import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { enqueue } from "../../jobs/queue.js";
import type { AgentTool } from "./index.js";

const STAGES = ["new", "engaged", "showing_booked", "offer_prep", "offer_sent", "closed", "lost"];

export const leadTools: AgentTool[] = [
  {
    definition: {
      name: "update_lead",
      description:
        "Save or update the lead's profile: name, contact info, preferences (budget, areas, beds, baths, timeline, pre-approval), pipeline stage, or a free-form note. Call this whenever the lead shares new information.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          stage: { type: "string", enum: STAGES },
          preferences: {
            type: "object",
            description:
              "Partial preferences to merge, e.g. {\"budget_max\": 850000, \"areas\": [\"Etobicoke\"], \"beds\": 3, \"timeline\": \"3 months\", \"pre_approved\": true}",
          },
          note: { type: "string", description: "Free-form note to append" },
        },
      },
    },
    handler: async (ctx, input) => {
      const d = db();
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof input.name === "string") patch.name = input.name;
      if (typeof input.email === "string") patch.email = input.email.toLowerCase();
      if (typeof input.phone === "string") patch.phone = input.phone;
      if (typeof input.stage === "string" && STAGES.includes(input.stage)) patch.stage = input.stage;
      if (input.preferences && typeof input.preferences === "object") {
        patch.preferences = { ...(ctx.lead.preferences ?? {}), ...(input.preferences as object) };
      }
      if (typeof input.note === "string" && input.note) {
        patch.notes = [ctx.lead.notes, input.note].filter(Boolean).join("\n");
      }
      await d.update(schema.leads).set(patch).where(eq(schema.leads.id, ctx.lead.id));
      return "Lead profile updated.";
    },
  },
  {
    definition: {
      name: "set_followup",
      description:
        "Schedule a future follow-up with this lead. At that time you'll get a turn to write a check-in message. Use for 'circle back next week', post-showing feedback, cold-lead nurture, etc.",
      input_schema: {
        type: "object",
        properties: {
          when: { type: "string", description: "ISO 8601 datetime for the follow-up" },
          reason: { type: "string", description: "Why you're following up (you'll see this later)" },
        },
        required: ["when", "reason"],
      },
    },
    handler: async (ctx, input) => {
      const when = new Date(String(input.when));
      if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) {
        return "Invalid or past datetime for the follow-up.";
      }
      await db()
        .update(schema.leads)
        .set({ followupAt: when, updatedAt: new Date() })
        .where(eq(schema.leads.id, ctx.lead.id));
      await enqueue({
        type: "followup",
        payload: { leadId: ctx.lead.id, reason: String(input.reason) },
        runAt: when,
        dedupeKey: `followup:${ctx.lead.id}`,
      });
      return `Follow-up scheduled for ${when.toISOString()}: ${String(input.reason)}`;
    },
  },
];
