import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { config } from "../../config.js";
import { normalizeBoosendWebhook } from "../../channels/boosend/inbound.js";
import { ingestInbound } from "../../channels/ingest.js";

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
