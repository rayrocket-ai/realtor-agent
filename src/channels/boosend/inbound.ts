/**
 * Normalizes an inbound Boosend webhook payload into the shape the ingestion
 * pipeline understands. Boosend payloads differ across channel types and
 * versions, so this is defensive: it looks for the common field names and
 * returns null when the event isn't an inbound text message.
 */
export interface NormalizedInbound {
  channel: "whatsapp" | "instagram" | "telegram";
  contactId: string;
  conversationId: string | null;
  messageId: string | null;
  name: string | null;
  phone: string | null;
  text: string;
  /** true when the message was sent by the workspace itself (realtor replied in Boosend). */
  fromSelf: boolean;
}

type AnyObj = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pick(obj: AnyObj, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function normalizeBoosendWebhook(payload: unknown): NormalizedInbound | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as AnyObj;

  // Unwrap common envelopes: {event, data} / {message} / flat.
  const data = (p.data && typeof p.data === "object" ? (p.data as AnyObj) : p) as AnyObj;
  const msg = (data.message && typeof data.message === "object" ? (data.message as AnyObj) : data) as AnyObj;
  const contact = (data.contact && typeof data.contact === "object" ? (data.contact as AnyObj) : {}) as AnyObj;

  const eventType = pick(p, ["event", "type"]) ?? pick(data, ["event", "type"]) ?? "";
  if (eventType && /(delivery|read|status|typing)/i.test(eventType)) return null;

  const rawChannel = (
    pick(data, ["channel", "platform", "source"]) ??
    pick(msg, ["channel", "platform"]) ??
    ""
  ).toLowerCase();
  const channel = rawChannel.includes("insta")
    ? "instagram"
    : rawChannel.includes("telegram")
      ? "telegram"
      : "whatsapp";

  const text =
    str(msg.text) ??
    str(msg.body) ??
    str((msg.text as AnyObj | undefined)?.body) ??
    str(msg.content) ??
    null;
  if (!text) return null;

  const contactId =
    pick(contact, ["id", "contact_id"]) ??
    pick(data, ["contact_id", "sender_id", "from"]) ??
    pick(msg, ["contact_id", "sender_id", "from"]);
  if (!contactId) return null;

  const direction = (pick(msg, ["direction"]) ?? pick(data, ["direction"]) ?? "inbound").toLowerCase();

  return {
    channel,
    contactId,
    conversationId: pick(data, ["conversation_id", "chat_id"]) ?? pick(msg, ["conversation_id", "chat_id"]),
    messageId: pick(msg, ["id", "message_id"]) ?? pick(data, ["message_id"]),
    name: pick(contact, ["name", "full_name", "username"]) ?? pick(data, ["sender_name"]),
    phone: pick(contact, ["phone", "phone_number"]) ?? pick(data, ["phone"]),
    text,
    fromSelf: direction === "outbound" || direction === "out",
  };
}
