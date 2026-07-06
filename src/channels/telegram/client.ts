import { config } from "../../config.js";

const API = "https://api.telegram.org";

async function tg<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const c = config();
  if (!c.telegramEnabled) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");
  const res = await fetch(`${API}/bot${c.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${data.description ?? ""}`);
  }
  return data.result as T;
}

/** Send a plain-text message to a chat. Returns the Telegram message id. */
export async function sendTelegramMessage(chatId: string, text: string): Promise<{ id: string | null }> {
  const result = await tg<{ message_id?: number }>("sendMessage", {
    chat_id: chatId,
    text,
  });
  return { id: result.message_id != null ? String(result.message_id) : null };
}

/** Register this server as the bot's webhook (used by `npm run telegram:setup`). */
export async function setTelegramWebhook(url: string, secret: string): Promise<void> {
  await tg("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

export async function getTelegramBotInfo(): Promise<{ username?: string; first_name?: string }> {
  return tg<{ username?: string; first_name?: string }>("getMe", {});
}
