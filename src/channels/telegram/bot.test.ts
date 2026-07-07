import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Exercises the bot's dispatch logic (allowlist, commands, booking creation)
 * with the Telegram client and booking service faked out.
 */

const sent: Array<{ chatId: number | string; text: string }> = [];
const created: Array<Record<string, unknown>> = [];

vi.mock("./client.js", () => ({
  sendMessage: vi.fn(async (chatId: number | string, text: string) => {
    sent.push({ chatId, text });
  }),
  getUpdates: vi.fn(async () => []),
  getMe: vi.fn(async () => ({ id: 1, username: "test_bot" })),
}));

vi.mock("../../booking/service.js", () => ({
  createBookingRequest: vi.fn(async (input: Record<string, unknown>) => {
    created.push(input);
    return { id: "00000000-0000-0000-0000-000000000001", ...input };
  }),
}));

const toursCreated: Array<Record<string, unknown>> = [];
vi.mock("../../booking/tours.js", () => ({
  createTourRequest: vi.fn(async (input: Record<string, unknown>) => {
    toursCreated.push(input);
    return { id: "00000000-0000-0000-0000-00000000t001", ...input };
  }),
}));

let allowed: string[] = [];
vi.mock("../../config.js", () => ({
  config: () => ({
    TZ: "America/Toronto",
    bookingEnabled: true,
    BOOKING_DEFAULT_DURATION_MIN: 30,
    telegramEnabled: true,
    telegramAllowedChatIds: allowed,
  }),
}));

vi.mock("../../db/client.js", async () => {
  const { schema } = await vi.importActual<typeof import("../../db/client.js")>("../../db/client.js");
  return {
    db: () => ({
      query: {
        appState: { findFirst: async () => undefined },
        mlsBookings: { findMany: async () => [] },
        tours: { findMany: async () => [] },
      },
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => undefined,
    }),
    schema,
  };
});

import { handleMessage } from "./bot.js";
import type { TgMessage } from "./client.js";

const handle = handleMessage;

function msg(chatId: number, text: string): TgMessage {
  return { message_id: 1, chat: { id: chatId, type: "private" }, date: 0, text };
}

describe("telegram bot dispatch", () => {
  beforeEach(() => {
    sent.length = 0;
    created.length = 0;
    toursCreated.length = 0;
    allowed = [];
  });

  it("tells an unknown chat its ID on /whoami", async () => {
    await handle(msg(555, "/whoami"));
    expect(sent.at(-1)!.text).toContain("555");
    expect(created).toHaveLength(0);
  });

  it("refuses to book from a non-allowlisted chat", async () => {
    await handle(msg(999, "16 Curry Cres tomorrow 5pm"));
    expect(created).toHaveLength(0);
    expect(sent.at(-1)!.text.toLowerCase()).toContain("authorized");
  });

  it("books immediately for an allowlisted chat", async () => {
    allowed = ["123"];
    await handle(msg(123, "16 Curry Cres 2099-07-08 14:00"));
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("telegram");
    expect(created[0]!.telegramChatId).toBe("123");
    expect(sent.at(-1)!.text).toContain("On it");
  });

  it("books a single listing by MLS number", async () => {
    allowed = ["123"];
    await handle(msg(123, "W13503106 2099-07-08 18:00"));
    expect(created).toHaveLength(1);
    expect(created[0]!.address).toBe("W13503106");
    expect(toursCreated).toHaveLength(0);
  });

  it("creates a tour for multiple listings with one start time", async () => {
    allowed = ["123"];
    await handle(msg(123, "W13503106 C5877233 2099-07-08 18:00"));
    expect(created).toHaveLength(0); // stops are created by the planner, not the bot
    expect(toursCreated).toHaveLength(1);
    expect(toursCreated[0]!.refs).toEqual(["W13503106", "C5877233"]);
    expect(toursCreated[0]!.telegramChatId).toBe("123");
    expect(sent.at(-1)!.text).toContain("tour");
  });

  it("replies to /status even with no bookings", async () => {
    allowed = ["123"];
    await handle(msg(123, "/status"));
    expect(sent.at(-1)!.text).toContain("No bookings yet");
  });

  it("cancel with nothing pending says so", async () => {
    allowed = ["123"];
    await handle(msg(123, "cancel"));
    expect(sent.at(-1)!.text).toContain("Nothing was still pending");
  });
});
