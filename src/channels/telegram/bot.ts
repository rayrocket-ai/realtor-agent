import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db, schema } from "../../db/client.js";
import { createBookingRequest } from "../../booking/service.js";
import { parseBookingMessage, BookingMessageError } from "./parse.js";
import { getMe, getUpdates, sendMessage, type TgMessage, type TgUpdate } from "./client.js";

/**
 * Telegram control bot: message it an address + a time and it books the showing
 * on BrokerBay immediately, then reports the result back in the chat.
 *
 * Long-polling (getUpdates) — no public webhook, works behind any firewall.
 * Only chat IDs in TELEGRAM_ALLOWED_CHAT_IDS may book; /start tells an unknown
 * chat its own ID so it can be added.
 */

const OFFSET_KEY = "telegram_update_offset";

let running = false;
let botUsername: string | null = null;

async function loadOffset(): Promise<number> {
  const row = await db().query.appState.findFirst({ where: eq(schema.appState.key, OFFSET_KEY) });
  return typeof row?.value === "number" ? row.value : 0;
}

async function saveOffset(offset: number): Promise<void> {
  await db()
    .insert(schema.appState)
    .values({ key: OFFSET_KEY, value: offset })
    .onConflictDoUpdate({ target: schema.appState.key, set: { value: offset, updatedAt: new Date() } });
}

function isAllowed(chatId: number): boolean {
  const allow = config().telegramAllowedChatIds;
  return allow.length > 0 && allow.includes(String(chatId));
}

const HELP =
  "Send me a property address and a time and I'll book the showing on BrokerBay.\n\n" +
  "Examples:\n" +
  "• 16 Curry Cres tomorrow 5pm\n" +
  "• 36 Example Ave, Toronto sat 1:30pm\n" +
  "• 12 King St W 2026-07-08 14:00 for 45 min\n" +
  "• add “dry run” to stop before the final submit\n\n" +
  "Commands: /help, /whoami";

/** Handle one inbound message. Exported for tests. */
export async function handleMessage(msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  if (!text) return;

  const lower = text.toLowerCase();
  if (lower === "/whoami" || lower === "/id") {
    await sendMessage(chatId, `This chat's ID is ${chatId}.`);
    return;
  }
  if (lower === "/start" || lower === "/help") {
    if (!isAllowed(chatId)) {
      await sendMessage(
        chatId,
        `👋 I'm the showing-booking bot.\n\nThis chat isn't authorized yet. Add this to the server's .env and redeploy:\n\nTELEGRAM_ALLOWED_CHAT_IDS=${chatId}\n\n(If some IDs are already set, append it comma-separated.)`,
      );
      return;
    }
    await sendMessage(chatId, HELP);
    return;
  }

  // Ignore other slash-commands quietly.
  if (lower.startsWith("/")) return;

  if (!isAllowed(chatId)) {
    await sendMessage(
      chatId,
      `This chat isn't authorized to book. Send /whoami and add the ID to TELEGRAM_ALLOWED_CHAT_IDS on the server.`,
    );
    return;
  }

  const c = config();
  let parsed;
  try {
    parsed = parseBookingMessage(text, { tz: c.TZ });
  } catch (err) {
    if (err instanceof BookingMessageError) {
      await sendMessage(chatId, `⚠️ ${err.message}`);
      return;
    }
    throw err;
  }

  if (parsed.start.getTime() <= Date.now()) {
    await sendMessage(chatId, `⚠️ That time (${parsed.echo}) is in the past — give me a future time.`);
    return;
  }
  if (!c.bookingEnabled) {
    await sendMessage(chatId, "⚠️ Booking isn't configured on the server yet (REALM_USERNAME / REALM_PASSWORD).");
    return;
  }

  const durationMin = parsed.durationMin ?? c.BOOKING_DEFAULT_DURATION_MIN;
  const booking = await createBookingRequest({
    address: parsed.address,
    requestedStart: parsed.start,
    durationMin,
    source: "telegram",
    dryRun: parsed.dryRun || undefined,
    telegramChatId: String(chatId),
  });

  await sendMessage(
    chatId,
    `📅 On it — booking ${parsed.address} for ${parsed.echo} (${durationMin} min)${parsed.dryRun ? " — DRY RUN, I'll stop before submitting" : ""}.\n` +
      `I'll message you here as soon as it's done.`,
  );
  console.log(`[telegram] queued booking ${booking.id.slice(0, 8)} for chat ${chatId}`);
}

async function pollLoop(): Promise<void> {
  let offset = await loadOffset();
  while (running) {
    let updates: TgUpdate[] = [];
    try {
      updates = await getUpdates(offset, 30);
    } catch (err) {
      if (running) {
        console.error("[telegram] getUpdates error:", (err as Error).message);
        await new Promise((r) => setTimeout(r, 3000));
      }
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message) {
        try {
          await handleMessage(u.message);
        } catch (err) {
          console.error("[telegram] handler error:", (err as Error).stack ?? err);
          await sendMessage(u.message.chat.id, "⚠️ Something went wrong handling that. Try again in a moment.");
        }
      }
    }
    if (updates.length) await saveOffset(offset).catch(() => undefined);
  }
}

export function startTelegramBot(): void {
  if (!config().telegramEnabled) return;
  if (running) return;
  running = true;
  void getMe().then((me) => {
    botUsername = me?.username ?? null;
    const allow = config().telegramAllowedChatIds;
    console.log(
      `[telegram] bot started${botUsername ? ` as @${botUsername}` : ""}` +
        `${allow.length ? `, ${allow.length} chat(s) allowed` : " — no chats allowlisted yet (send /whoami to the bot)"}`,
    );
  });
  void pollLoop();
}

export function stopTelegramBot(): void {
  running = false;
}
