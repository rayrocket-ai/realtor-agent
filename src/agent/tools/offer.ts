import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { enqueue } from "../../jobs/queue.js";
import { renderOfferSummary, offerShortId, type OfferTerms } from "../../offers/template.js";
import { issueApprovalToken } from "../../offers/approval.js";
import type { AgentTool } from "./index.js";

export const offerTools: AgentTool[] = [
  {
    definition: {
      name: "draft_offer",
      description:
        "Draft an offer (Ontario Agreement of Purchase and Sale / OREA Form 100 terms sheet) for the realtor to review and approve. NOTHING is sent to anyone by this tool — it only creates a draft and notifies the realtor, who must personally approve before the offer email goes out. Collect all terms from the buyer before calling.",
      input_schema: {
        type: "object",
        properties: {
          property_address: { type: "string" },
          mls_number: { type: "string" },
          price: { type: "number", description: "Offer price in CAD" },
          deposit: { type: "number", description: "Deposit in CAD" },
          irrevocable_date: {
            type: "string",
            description: "When the offer expires if not accepted, e.g. '2026-07-06 11:59 PM'",
          },
          completion_date: { type: "string", description: "Closing date, e.g. '2026-09-15'" },
          conditions: {
            type: "array",
            items: { type: "string" },
            description:
              "Conditions, e.g. ['financing (5 business days)', 'home inspection (5 business days)', 'status certificate review']. Empty array = firm offer.",
          },
          inclusions: { type: "string", description: "Chattels included, e.g. 'fridge, stove, washer, dryer'" },
          exclusions: { type: "string" },
          notes: { type: "string" },
          listing_agent_email: {
            type: "string",
            description: "Email of the listing agent / recipient, if known",
          },
        },
        required: ["property_address", "price", "deposit", "irrevocable_date", "completion_date", "conditions"],
      },
    },
    handler: async (ctx, input) => {
      const c = config();
      const terms: OfferTerms = {
        price: Number(input.price),
        deposit: Number(input.deposit),
        irrevocableDate: String(input.irrevocable_date),
        completionDate: String(input.completion_date),
        conditions: Array.isArray(input.conditions) ? input.conditions.map(String) : [],
        inclusions: input.inclusions ? String(input.inclusions) : undefined,
        exclusions: input.exclusions ? String(input.exclusions) : undefined,
        notes: input.notes ? String(input.notes) : undefined,
      };
      if (!Number.isFinite(terms.price) || terms.price <= 0) return "Invalid price.";
      if (!Number.isFinite(terms.deposit) || terms.deposit <= 0) return "Invalid deposit.";

      const address = String(input.property_address);
      const buyerName = ctx.lead.name ?? "Buyer";
      const summary = renderOfferSummary({
        buyerName,
        propertyAddress: address,
        mlsNumber: input.mls_number ? String(input.mls_number) : null,
        terms,
      });

      const emailBody =
        `Hello,\n\n` +
        `Please find below the terms of an offer on ${address}${input.mls_number ? ` (MLS ${input.mls_number})` : ""} on behalf of my buyer client:\n\n` +
        `Purchase price: $${terms.price.toLocaleString("en-CA")}\n` +
        `Deposit: $${terms.deposit.toLocaleString("en-CA")} upon acceptance\n` +
        `Irrevocable until: ${terms.irrevocableDate}\n` +
        `Completion date: ${terms.completionDate}\n` +
        `Conditions: ${terms.conditions.length ? terms.conditions.join("; ") : "None — firm offer"}\n` +
        (terms.inclusions ? `Inclusions: ${terms.inclusions}\n` : "") +
        `\nThe signed OREA Form 100 will follow. Please confirm receipt.\n\n` +
        `Best regards,\n${c.REALTOR_NAME}\n${c.REALTOR_BROKERAGE}\n${c.REALTOR_PHONE}`;

      const [offer] = await db()
        .insert(schema.offers)
        .values({
          leadId: ctx.lead.id,
          propertyAddress: address,
          mlsNumber: input.mls_number ? String(input.mls_number) : null,
          terms: terms as unknown as Record<string, unknown>,
          summaryMd: summary,
          draftEmailSubject: `Offer — ${address}${input.mls_number ? ` (MLS ${input.mls_number})` : ""}`,
          draftEmailBody: emailBody,
          recipientEmail: input.listing_agent_email ? String(input.listing_agent_email) : null,
          status: "pending_approval",
        })
        .returning();

      const token = await issueApprovalToken(offer!.id);
      const shortId = offerShortId(offer!.id);
      const approveUrl = `${c.APP_BASE_URL}/approve/${token}`;
      const rejectUrl = `${c.APP_BASE_URL}/reject/${token}`;
      const dashUrl = `${c.APP_BASE_URL}/admin/offers`;

      await db()
        .update(schema.leads)
        .set({ stage: "offer_prep", updatedAt: new Date() })
        .where(eq(schema.leads.id, ctx.lead.id));

      await enqueue({
        type: "notify-realtor",
        payload: {
          subject: `[OFFER-${shortId}] Approve offer: ${address} — $${terms.price.toLocaleString("en-CA")}`,
          body:
            `${summary}\n\n` +
            `--- Draft email to ${offer!.recipientEmail ?? "(recipient not set — add on dashboard)"} ---\n\n` +
            `${emailBody}\n\n` +
            `--- Actions ---\n` +
            `APPROVE & SEND: ${approveUrl}\n` +
            `REJECT with feedback: ${rejectUrl}\n` +
            `Review/edit on dashboard: ${dashUrl}\n\n` +
            `Or just reply to this email: "approve" sends it; anything else is treated as rejection feedback.\n` +
            `This approval link expires in 72 hours. Nothing is sent until you approve.`,
        },
      });

      return (
        `Offer draft created (pending ${c.REALTOR_NAME}'s approval)${offer!.recipientEmail ? "" : " — note: listing agent email unknown, ask the lead or leave for the realtor to fill in"}. ` +
        `Tell the lead the offer is being prepared and ${c.REALTOR_NAME} will review and send the formal OREA Form 100 paperwork.`
      );
    },
  },
];
