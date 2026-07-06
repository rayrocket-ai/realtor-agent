import { config } from "../../config.js";

/**
 * Thin adapter around Boosend's REST API. Boosend endpoint shapes vary by
 * account/version, so everything goes through this one function — if your
 * Boosend workspace uses a different send endpoint, this is the only place
 * to change.
 */
export async function sendBoosendMessage(opts: {
  channel: string; // whatsapp|instagram|telegram
  contactId: string;
  conversationId?: string | null;
  text: string;
}): Promise<{ id: string | null }> {
  const c = config();
  if (!c.boosendEnabled) throw new Error("Boosend is not configured (BOOSEND_API_KEY missing)");

  const res = await fetch(`${c.BOOSEND_API_BASE.replace(/\/$/, "")}/messages/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.BOOSEND_API_KEY}`,
    },
    body: JSON.stringify({
      channel: opts.channel,
      contact_id: opts.contactId,
      conversation_id: opts.conversationId ?? undefined,
      type: "text",
      text: opts.text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Boosend send failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; message_id?: string };
  return { id: data.id ?? data.message_id ?? null };
}
