import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { resolveLead } from "../../channels/ingest.js";
import { db, schema } from "../../db/client.js";
import { enqueue } from "../../jobs/queue.js";
import { eq } from "drizzle-orm";
import {
  triageFrontDeskCall,
  frontDeskNotification,
  type FrontDeskTriage,
} from "../../voice/front-desk.js";
import { listingForModel } from "../../listings/field-policy.js";
import { searchListingsByAddress } from "../../listings/reso.js";

interface VapiToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

interface VapiServerMessage {
  type?: string;
  call?: { id?: string; customer?: { number?: string } };
  artifact?: { transcript?: string };
  transcript?: string;
  analysis?: Record<string, unknown>;
  toolCallList?: VapiToolCall[];
  toolWithToolCallList?: { toolCall?: VapiToolCall }[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function argsObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function safeEqSecret(a: string, b: string): boolean {
  // Constant-time-ish compare without importing crypto for short secrets.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Push the confirmed front-desk lead into Lofty CRM. Returns the Lofty leadId (string) or null when disabled. */
async function pushToLofty(triage: FrontDeskTriage): Promise<string | null> {
  const c = config();
  if (!c.LOFTY_API_KEY) return null;
  const nameParts = (triage.callerName ?? "Unknown Caller").trim().split(/\s+/);
  const payload: Record<string, unknown> = {
    firstName: nameParts[0],
    lastName: nameParts.slice(1).join(" ") || "(phone lead)",
    source: "AI Front Desk (Phone)",
    tags: ["AI Front Desk", `Urgency ${triage.urgency.toUpperCase()}`, triage.category.replaceAll("_", " ")],
  };
  if (triage.phone) payload.phones = [triage.phone];
  if (triage.email) payload.emails = [triage.email];
  if (triage.preApproved != null) payload.preQual = triage.preApproved ? "Yes" : "No";
  const response = await fetch("https://api.lofty.com/v1.0/leads", {
    method: "POST",
    headers: {
      authorization: `token ${c.LOFTY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Lofty HTTP ${response.status}: ${text.slice(0, 300)}`);
  // leadId is an int64 — extract as a string to avoid JS number precision loss.
  return text.match(/"leadId"\s*:\s*"?(\d+)"?/)?.[1] ?? null;
}

/** Store the confirmed front-desk handoff in the CRM and alert Ray when needed. */
async function storeFrontDeskLead(input: {
  callId: string;
  triage: FrontDeskTriage;
  summary: string;
  source: string;
}): Promise<{ leadId: string; stored: boolean }> {
  const c = config();
  const { triage } = input;
  const lead = await resolveLead({
    channel: "voice",
    externalId: triage.phone ?? `vapi-call:${input.callId}`,
    threadRef: input.callId,
    name: triage.callerName,
    email: triage.email,
    phone: triage.phone,
    body: input.summary,
  });
  const inserted = await db().insert(schema.messages).values({
    leadId: lead.id,
    channel: "voice",
    direction: "inbound",
    body: input.summary,
    externalMsgId: `${input.source}:${input.callId}`,
    meta: {
      source: input.source,
      urgency: triage.urgency,
      callerType: triage.category,
    },
  }).onConflictDoNothing({ target: schema.messages.externalMsgId }).returning({ id: schema.messages.id });
  if (inserted.length) {
    await db().update(schema.leads).set({
      name: lead.name || triage.callerName,
      email: lead.email || triage.email || null,
      phone: lead.phone || triage.phone,
      stage: lead.stage === "new" ? "engaged" : lead.stage,
      notes: [lead.notes, input.summary].filter(Boolean).join("\n\n"),
      updatedAt: new Date(),
    }).where(eq(schema.leads.id, lead.id));
    if (triage.urgency !== "green") {
      await enqueue({
        type: "notify-realtor",
        payload: {
          subject: `[${triage.urgency.toUpperCase()}] Voice front desk — ${triage.callerName ?? triage.category.replaceAll("_", " ")}`,
          body: `${input.summary}\n\nOpen: ${c.APP_BASE_URL}/admin/leads/${lead.id}`,
        },
        dedupeKey: `${input.source}:${input.callId}`,
      });
    }
  }
  return { leadId: lead.id, stored: inserted.length > 0 };
}

export async function voiceVapiRoutes(app: FastifyInstance): Promise<void> {
  // Vapi sends all server events (tool calls, end-of-call report, status) here.
  app.post("/api/voice/vapi", async (req, reply) => {
    const c = config();
    if (!c.VAPI_WEBHOOK_SECRET) {
      return reply.status(404).send({ ok: false, error: "vapi intake is not configured" });
    }
    const provided = String(req.headers["x-vapi-secret"] ?? "");
    if (!safeEqSecret(provided, c.VAPI_WEBHOOK_SECRET)) {
      req.log.warn("vapi webhook: secret mismatch");
      return reply.status(401).send({ ok: false, error: "invalid secret" });
    }

    const body = (req.body ?? {}) as { message?: VapiServerMessage };
    const message = body.message ?? {};
    const callId = message.call?.id ?? "unknown";

    // 1. Mid-call tool invocation from the assistant.
    if (message.type === "tool-calls") {
      const toolCalls: VapiToolCall[] = message.toolCallList
        ?? (message.toolWithToolCallList ?? []).map((item) => item.toolCall).filter((t): t is VapiToolCall => Boolean(t));
      const results: { toolCallId: string; result: string }[] = [];
      for (const toolCall of toolCalls) {
        const name = toolCall.function?.name ?? "";
        const args = argsObject(toolCall.function?.arguments);

        if (name === "lookup_listing_by_address") {
          if (!c.mlsEnabled) {
            results.push({ toolCallId: toolCall.id, result: "The live listing lookup is not available right now. Take the caller's address and offer a callback from Ray." });
            continue;
          }
          const address = asString(args.address) ?? "";
          const city = asString(args.city) ?? "";
          try {
            const result = await searchListingsByAddress(address, city || undefined, 8);
            const exactRows = result.listings.filter((listing) =>
              simple(listing.streetNumber ?? "") === simple(result.parsed.streetNumber ?? "") &&
              simple(listing.streetName ?? "") === simple(result.parsed.streetName) &&
              (!result.parsed.city || simple(listing.city ?? "") === simple(result.parsed.city))
            );
            const selected = (exactRows.length ? exactRows : result.listings).slice(0, 3).map((raw) => {
              const listing = listingForModel(raw);
              const isCurrent = listing.status === "Active";
              return {
                exact_address_match: exactRows.includes(raw),
                address: listing.address,
                city: listing.city,
                mls_number: listing.mlsNumber,
                standard_status: listing.status,
                transaction_type: listing.transactionType,
                list_price: isCurrent ? listing.listPrice : null,
                bedrooms: listing.bedrooms,
                bathrooms: listing.bathrooms,
                property_type: listing.propertyType,
                public_remarks: isCurrent ? listing.publicRemarks : null,
              };
            });
            req.log.info({ source: "vapi_front_desk", address, exact: result.exact, resultCount: selected.length }, "voice MLS lookup");
            results.push({
              toolCallId: toolCall.id,
              result: JSON.stringify({
                ok: true,
                source: "PropTx RESO API (live)",
                exact_address_match: exactRows.length > 0,
                matches: selected,
                disclosure_note: "Current public listing facts may be discussed. Historical sold/leased prices require Ray. Never invent facts not present here.",
              }),
            });
          } catch (err) {
            req.log.error({ err, callId, address }, "vapi MLS lookup failed");
            results.push({ toolCallId: toolCall.id, result: "The live listing lookup failed. Apologize briefly, take the address down, and offer a callback from Ray." });
          }
          continue;
        }

        if (name !== "capture_front_desk_lead") {
          results.push({ toolCallId: toolCall.id, result: `Unknown tool: ${name}` });
          continue;
        }
        const triage: FrontDeskTriage = {
          urgency: args.urgency === "red" || args.urgency === "green" ? args.urgency : "yellow",
          category: ["hot_lead", "existing_client", "time_sensitive", "vendor_admin", "personal", "spam"].includes(String(args.call_category))
            ? args.call_category as FrontDeskTriage["category"]
            : "unknown",
          callerName: asString(args.caller_name),
          phone: asString(args.phone) ?? message.call?.customer?.number ?? null,
          email: asString(args.email),
          intent: asString(args.intent) ?? "See call notes.",
          property: asString(args.property),
          timeline: asString(args.timeline),
          preApproved: typeof args.pre_approved === "boolean" ? args.pre_approved : null,
          reason: "Captured live on the call by the front-desk assistant.",
        };
        const { body: summary } = frontDeskNotification(triage, asString(args.notes) ?? "");
        try {
          const { leadId } = await storeFrontDeskLead({
            callId,
            triage,
            summary,
            source: "vapi_front_desk_tool",
          });
          results.push({
            toolCallId: toolCall.id,
            result: triage.urgency === "red"
              ? `Saved (lead ${leadId}). The urgent message was stored and Ray was alerted.`
              : `Saved (lead ${leadId}). The caller details and message were stored for Ray.`,
          });
        } catch (err) {
          req.log.error({ err, callId }, "vapi capture_front_desk_lead failed");
          results.push({ toolCallId: toolCall.id, result: "Save failed. Apologize and assure the caller Ray will still get the message." });
        }
      }
      return reply.send({ results });
    }

    // 2. End-of-call report: transcript + structured analysis -> triage + notify.
    if (message.type === "end-of-call-report") {
      const transcript = message.artifact?.transcript ?? message.transcript ?? "";
      const analysis = (message.analysis ?? {}) as Record<string, unknown>;
      const structured = (analysis.structuredData && typeof analysis.structuredData === "object")
        ? analysis.structuredData as Record<string, unknown>
        : {};
      const triage = triageFrontDeskCall({
        analysis: { ...analysis, data_collection_results: structured },
        transcriptText: transcript,
        fallbackPhone: message.call?.customer?.number ?? null,
      });
      const summaryText = typeof analysis.summary === "string" ? analysis.summary : "";
      const { body: summary } = frontDeskNotification(triage, summaryText);
      try {
        const { stored } = await storeFrontDeskLead({
          callId,
          triage,
          summary,
          source: "vapi_front_desk_eoc",
        });
        // One clean Lofty lead per call (end-of-call has the final structured data).
        let loftyLeadId: string | null = null;
        if (stored && triage.urgency !== "green" && triage.callerName) {
          try {
            loftyLeadId = await pushToLofty(triage);
            req.log.info({ callId, loftyLeadId }, "pushed front-desk lead to Lofty");
          } catch (err) {
            req.log.error({ err, callId }, "Lofty lead push failed");
          }
        }
        return reply.send({ ok: true, stored, urgency: triage.urgency, loftyLeadId });
      } catch (err) {
        req.log.error({ err, callId }, "vapi end-of-call handling failed");
        return reply.status(500).send({ ok: false, error: "end-of-call handling failed" });
      }
    }

    // 3. Everything else (status-update, speech-update, hang): acknowledge.
    return reply.send({ ok: true, ignored: message.type ?? "unknown" });
  });
}

function simple(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
