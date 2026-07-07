import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db, schema } from "../../db/client.js";
import { createBookingRequest } from "../../booking/service.js";
import { createTourRequest } from "../../booking/tours.js";
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
  "Send me addresses or MLS numbers and a time — I'll book the showings on BrokerBay.\n\n" +
  "One home:\n" +
  "• 16 Curry Cres tomorrow 5pm\n" +
  "• W13503106 tomorrow 6pm\n" +
  "• 12 King St W 2026-07-08 14:00 for 45 min\n\n" +
  "A tour (several homes, one start time — I order them by driving distance and book back-to-back):\n" +
  "• W13503106 C5877233 tomorrow 6pm\n" +
  "• one listing per line, time on the last line\n\n" +
  "Extras: add “dry run” to stop before submitting · “cancel” to cancel what's still pending\n" +
  "Commands: /status, /cancel, /help, /whoami";

function fmtLocal(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  running: "🔄",
  submitted: "📨",
  confirmed: "✅",
  needs_attention: "⚠️",
  failed: "❌",
  dry_run: "🧪",
  cancelled: "🚫",
};

async function sendStatus(chatId: number): Promise<void> {
  const rows = await db().query.mlsBookings.findMany({
    orderBy: desc(schema.mlsBookings.createdAt),
    limit: 8,
  });
  if (!rows.length) {
    await sendMessage(chatId, "No bookings yet. Send me an address and a time to make one.");
    return;
  }
  const lines = rows.map((b) => {
    const tour = b.tourId ? ` (tour stop ${b.tourStop})` : "";
    return `${STATUS_EMOJI[b.status] ?? "•"} ${b.matchedAddress ?? b.address}${tour}\n    ${fmtLocal(b.requestedStart)} · ${b.durationMin} min · ${b.status}`;
  });
  await sendMessage(chatId, `Recent bookings:\n\n${lines.join("\n")}`);
}

/**
 * Cancel everything still pending that this chat started: queued bookings and
 * un-planned tours. Running/submitted ones can't be safely stopped — reported.
 */
async function cancelPending(chatId: number): Promise<void> {
  const d = db();
  const chat = String(chatId);

  const pendingBookings = await d.query.mlsBookings.findMany({
    where: and(eq(schema.mlsBookings.notifyTelegramChatId, chat), eq(schema.mlsBookings.status, "pending")),
  });
  if (pendingBookings.length) {
    const ids = pendingBookings.map((b) => b.id);
    await d
      .update(schema.mlsBookings)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(inArray(schema.mlsBookings.id, ids));
    // Drop their queued jobs too so the worker never picks them up.
    await d.execute(sql`
      UPDATE jobs SET status = 'cancelled'
      WHERE status = 'pending' AND dedupe_key IN (${sql.join(ids.map((id) => sql`${`mls-booking:${id}`}`), sql`, `)})
    `);
  }

  const activeTours = await d.query.tours.findMany({
    where: and(eq(schema.tours.notifyTelegramChatId, chat), inArray(schema.tours.status, ["pending", "planning"])),
  });
  if (activeTours.length) {
    const ids = activeTours.map((t) => t.id);
    await d
      .update(schema.tours)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(inArray(schema.tours.id, ids));
    await d.execute(sql`
      UPDATE jobs SET status = 'cancelled'
      WHERE status = 'pending' AND dedupe_key IN (${sql.join(ids.map((id) => sql`${`tour-plan:${id}`}`), sql`, `)})
    `);
  }

  const busy = await d.query.mlsBookings.findMany({
    where: and(eq(schema.mlsBookings.notifyTelegramChatId, chat), inArray(schema.mlsBookings.status, ["running", "submitted"])),
    orderBy: desc(schema.mlsBookings.createdAt),
    limit: 5,
  });

  const parts: string[] = [];
  const cancelled = pendingBookings.length + activeTours.reduce((n, t) => n + t.refs.length, 0);
  if (cancelled > 0) parts.push(`🚫 Cancelled ${cancelled} pending showing${cancelled === 1 ? "" : "s"}.`);
  else parts.push("Nothing was still pending to cancel.");
  if (busy.length) {
    parts.push(
      `These were already in flight and need cancelling on BrokerBay (or the dashboard):\n` +
        busy.map((b) => `• ${b.matchedAddress ?? b.address} — ${fmtLocal(b.requestedStart)} (${b.status})`).join("\n"),
    );
  }
  await sendMessage(chatId, parts.join("\n\n"));
}

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

  if (!isAllowed(chatId)) {
    if (!lower.startsWith("/")) {
      await sendMessage(
        chatId,
        `This chat isn't authorized to book. Send /whoami and add the ID to TELEGRAM_ALLOWED_CHAT_IDS on the server.`,
      );
    }
    return;
  }

  if (lower === "/status" || lower === "status") {
    await sendStatus(chatId);
    return;
  }
  if (lower === "/cancel" || lower === "cancel") {
    await cancelPending(chatId);
    return;
  }
  // Ignore other slash-commands quietly.
  if (lower.startsWith("/")) return;

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

  if (parsed.refs.length > 1) {
    const tour = await createTourRequest({
      refs: parsed.refs,
      requestedStart: parsed.start,
      durationMin,
      source: "telegram",
      dryRun: parsed.dryRun || undefined,
      telegramChatId: String(chatId),
    });
    await sendMessage(
      chatId,
      `🗺 Planning a ${parsed.refs.length}-home tour starting ${parsed.echo} (${durationMin} min each)${parsed.dryRun ? " — DRY RUN" : ""}.\n` +
        `I'll order the homes by driving distance, send you the itinerary, then book each one. Reply “cancel” to stop it.`,
    );
    console.log(`[telegram] queued tour ${tour.id.slice(0, 8)} (${parsed.refs.length} stops) for chat ${chatId}`);
    return;
  }

  const booking = await createBookingRequest({
    address: parsed.refs[0]!,
    requestedStart: parsed.start,
    durationMin,
    source: "telegram",
    dryRun: parsed.dryRun || undefined,
    telegramChatId: String(chatId),
  });

  await sendMessage(
    chatId,
    `📅 On it — booking ${parsed.refs[0]} for ${parsed.echo} (${durationMin} min)${parsed.dryRun ? " — DRY RUN, I'll stop before submitting" : ""}.\n` +
      `I'll message you here as soon as it's done. Reply “cancel” if you need to stop it.`,
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
