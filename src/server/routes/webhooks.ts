import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { config } from "../../config.js";
import { normalizeBoosendWebhook } from "../../channels/boosend/inbound.js";
import { normalizeTelegramUpdate } from "../../channels/telegram/inbound.js";
import { ingestInbound, resolveLead } from "../../channels/ingest.js";
import { db, schema } from "../../db/client.js";
import { enqueue } from "../../jobs/queue.js";
import { eq } from "drizzle-orm";
import { z } from "zod";

const voiceIntakeSchema = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  caller_name: z.string().trim().min(1).max(160),
  callback_number: z.string().trim().min(7).max(40),
  email: z.string().trim().email().max(254).optional().or(z.literal("")),
  caller_type: z.enum(["buyer", "seller", "landlord", "tenant", "existing_client", "other_agent", "vendor", "general"]),
  reason_summary: z.string().trim().min(3).max(3000),
  property_or_area: z.string().trim().max(500).optional().default(""),
  timeline: z.string().trim().max(300).optional().default(""),
  urgency: z.enum(["red", "yellow", "green"]),
  best_callback_time: z.string().trim().max(300).optional().default(""),
  language: z.enum(["English", "Dari"]).default("English"),
});

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw body for HMAC verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 1024 * 1024 },
    (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post("/webhooks/boosend", async (req, reply) => {
    const c = config();
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? "";

    if (c.BOOSEND_WEBHOOK_SECRET) {
      const provided =
        (req.headers["x-boosend-signature"] as string | undefined) ??
        (req.headers["x-signature"] as string | undefined) ??
        (req.headers["x-webhook-secret"] as string | undefined) ??
        "";
      if (!verifySignature(rawBody, provided, c.BOOSEND_WEBHOOK_SECRET)) {
        req.log.warn("boosend webhook: signature verification failed");
        return reply.status(401).send({ error: "invalid signature" });
      }
    }

    const normalized = normalizeBoosendWebhook(req.body);
    if (!normalized) {
      // Not an inbound text message — log a sample so the payload shape can be
      // inspected during setup, then ack so Boosend doesn't retry.
      req.log.info({ payload: req.body }, "boosend webhook: ignored (not an inbound text message)");
      return reply.send({ ok: true, ignored: true });
    }

    const result = await ingestInbound({
      channel: normalized.channel,
      externalId: normalized.contactId,
      threadRef: normalized.conversationId,
      externalMsgId: normalized.messageId ? `boosend:${normalized.messageId}` : null,
      name: normalized.name,
      phone: normalized.phone,
      body: normalized.text,
      fromRealtor: normalized.fromSelf,
      meta: { source: "boosend" },
    });

    return reply.send({ ok: true, leadId: result.leadId, stored: result.stored });
  });

  app.post("/webhooks/telegram", async (req, reply) => {
    const c = config();
    if (!c.telegramEnabled) return reply.status(404).send({ error: "telegram not configured" });

    // Telegram echoes the secret_token from setWebhook in this header on every delivery.
    const provided = (req.headers["x-telegram-bot-api-secret-token"] as string | undefined) ?? "";
    if (c.TELEGRAM_WEBHOOK_SECRET && !safeEq(provided, c.TELEGRAM_WEBHOOK_SECRET)) {
      req.log.warn("telegram webhook: secret token mismatch");
      return reply.status(401).send({ error: "invalid secret" });
    }

    const normalized = normalizeTelegramUpdate(req.body);
    if (!normalized) return reply.send({ ok: true, ignored: true });

    const result = await ingestInbound({
      channel: "telegram",
      externalId: normalized.chatId,
      threadRef: normalized.chatId,
      externalMsgId: `tg:${normalized.chatId}:${normalized.messageId}`,
      name: normalized.name,
      body: normalized.text,
      meta: { source: "telegram", username: normalized.username },
    });

    return reply.send({ ok: true, leadId: result.leadId, stored: result.stored });
  });

  // ElevenLabs calls this tool once the caller's identity, reason, and callback
  // details have been confirmed. It writes a durable CRM timeline entry and
  // alerts Ray; it never initiates outreach or claims an appointment was made.
  app.post("/webhooks/elevenlabs/capture-lead", async (req, reply) => {
    const c = config();
    if (!c.ELEVENLABS_WEBHOOK_SECRET) {
      return reply.status(404).send({ ok: false, error: "voice intake is not configured" });
    }
    const provided = String(req.headers["x-voice-webhook-secret"] ?? "");
    if (!safeEq(provided, c.ELEVENLABS_WEBHOOK_SECRET)) {
      return reply.status(401).send({ ok: false, error: "invalid secret" });
    }
    const parsed = voiceIntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: parsed.error.issues[0]?.message ?? "invalid voice intake",
      });
    }
    const input = parsed.data;
    const summary = [
      `Voice front desk — ${input.urgency.toUpperCase()} ${input.caller_type.replaceAll("_", " ")}`,
      `Caller: ${input.caller_name}`,
      `Callback: ${input.callback_number}`,
      input.email ? `Email: ${input.email}` : "",
      `Reason: ${input.reason_summary}`,
      input.property_or_area ? `Property/area: ${input.property_or_area}` : "",
      input.timeline ? `Timeline: ${input.timeline}` : "",
      input.best_callback_time ? `Best callback time: ${input.best_callback_time}` : "",
      `Language: ${input.language}`,
    ].filter(Boolean).join("\n");
    const lead = await resolveLead({
      channel: "voice",
      externalId: input.callback_number,
      threadRef: input.conversation_id,
      name: input.caller_name,
      email: input.email || null,
      phone: input.callback_number,
      body: summary,
    });
    const inserted = await db().insert(schema.messages).values({
      leadId: lead.id,
      channel: "voice",
      direction: "inbound",
      body: summary,
      externalMsgId: `elevenlabs:${input.conversation_id}`,
      meta: {
        source: "elevenlabs_front_desk",
        urgency: input.urgency,
        callerType: input.caller_type,
        language: input.language,
      },
    }).onConflictDoNothing({ target: schema.messages.externalMsgId }).returning({ id: schema.messages.id });
    if (inserted.length) {
      await db().update(schema.leads).set({
        name: lead.name || input.caller_name,
        email: lead.email || input.email || null,
        phone: lead.phone || input.callback_number,
        stage: lead.stage === "new" ? "engaged" : lead.stage,
        notes: [lead.notes, summary].filter(Boolean).join("\n\n"),
        updatedAt: new Date(),
      }).where(eq(schema.leads.id, lead.id));
      if (input.urgency !== "green") {
        await enqueue({
          type: "notify-realtor",
          payload: {
            subject: `[${input.urgency.toUpperCase()}] Voice front desk — ${input.caller_name}`,
            body: `${summary}\n\nOpen: ${c.APP_BASE_URL}/admin/leads/${lead.id}`,
          },
          dedupeKey: `voice-intake:${input.conversation_id}`,
        });
      }
    }
    return reply.send({
      ok: true,
      stored: inserted.length > 0,
      lead_id: lead.id,
      message: input.urgency === "red"
        ? "The urgent message was saved and Ray was alerted."
        : "The caller details and message were saved for Ray.",
    });
  });
}

/** Accepts either a shared-secret header or an HMAC-SHA256 hex/base64 signature of the body. */
export function verifySignature(rawBody: string, provided: string, secret: string): boolean {
  if (!provided) return false;
  const cleaned = provided.replace(/^sha256=/, "");
  if (safeEq(cleaned, secret)) return true; // plain shared-secret header
  const hmacHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const hmacB64 = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEq(cleaned, hmacHex) || safeEq(cleaned, hmacB64);
}

function safeEq(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
