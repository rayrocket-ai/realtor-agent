import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate } from "./inbound.js";

const update = (over: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 42,
    from: { id: 777, is_bot: false, first_name: "Maya", last_name: "Chen", username: "mayachen" },
    chat: { id: 777, type: "private" },
    date: 1751800000,
    text: "hi, is the condo still available?",
    ...over,
  },
});

describe("normalizeTelegramUpdate", () => {
  it("parses a private text message", () => {
    const out = normalizeTelegramUpdate(update());
    expect(out).toEqual({
      chatId: "777",
      messageId: "42",
      name: "Maya Chen",
      username: "mayachen",
      text: "hi, is the condo still available?",
    });
  });

  it("ignores group chats", () => {
    expect(normalizeTelegramUpdate(update({ chat: { id: -100, type: "group" } }))).toBeNull();
  });

  it("ignores bots, non-text, and non-message updates", () => {
    expect(
      normalizeTelegramUpdate(update({ from: { id: 1, is_bot: true, first_name: "B" } })),
    ).toBeNull();
    expect(normalizeTelegramUpdate(update({ text: undefined, photo: [{}] }))).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 2, edited_message: {} })).toBeNull();
    expect(normalizeTelegramUpdate(null)).toBeNull();
  });

  it("handles missing last name / username", () => {
    const out = normalizeTelegramUpdate(update({ from: { id: 777, is_bot: false, first_name: "Sam" } }));
    expect(out!.name).toBe("Sam");
    expect(out!.username).toBeNull();
  });
});
