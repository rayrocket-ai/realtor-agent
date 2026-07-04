import { describe, expect, it } from "vitest";
import { normalizeBoosendWebhook } from "./inbound.js";

describe("normalizeBoosendWebhook", () => {
  it("parses a flat whatsapp payload", () => {
    const out = normalizeBoosendWebhook({
      event: "message.received",
      channel: "whatsapp",
      contact_id: "wa-123",
      conversation_id: "conv-9",
      message: { id: "m-1", text: "hi, is the condo still available?" },
      contact: { name: "Sam", phone: "+14165551234" },
    });
    expect(out).not.toBeNull();
    expect(out!.channel).toBe("whatsapp");
    expect(out!.contactId).toBe("wa-123");
    expect(out!.conversationId).toBe("conv-9");
    expect(out!.messageId).toBe("m-1");
    expect(out!.name).toBe("Sam");
    expect(out!.phone).toBe("+14165551234");
    expect(out!.text).toContain("condo");
    expect(out!.fromSelf).toBe(false);
  });

  it("parses an enveloped instagram payload", () => {
    const out = normalizeBoosendWebhook({
      event: "inbound_message",
      data: {
        platform: "instagram",
        contact: { id: "ig-7", username: "buyer_gal" },
        message: { message_id: "abc", body: "what's the price?" },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.channel).toBe("instagram");
    expect(out!.contactId).toBe("ig-7");
    expect(out!.text).toBe("what's the price?");
  });

  it("flags outbound (realtor console) messages as fromSelf", () => {
    const out = normalizeBoosendWebhook({
      channel: "whatsapp",
      contact_id: "wa-123",
      message: { id: "m-2", text: "I'll call you", direction: "outbound" },
    });
    expect(out!.fromSelf).toBe(true);
  });

  it("ignores delivery/status events and payloads without text", () => {
    expect(normalizeBoosendWebhook({ event: "message.delivery", contact_id: "x" })).toBeNull();
    expect(normalizeBoosendWebhook({ channel: "whatsapp", contact_id: "x", message: {} })).toBeNull();
    expect(normalizeBoosendWebhook(null)).toBeNull();
    expect(normalizeBoosendWebhook("junk")).toBeNull();
  });

  it("ignores messages with no contact id", () => {
    expect(normalizeBoosendWebhook({ channel: "whatsapp", message: { text: "hi" } })).toBeNull();
  });
});
