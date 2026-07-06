import { config } from "../../config.js";

/** Minimal Telegram Bot API client (long-polling, no public webhook needed). */

const API = "https://api.telegram.org";

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: string;
  title?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const token = config().TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Long-poll for updates. Resolves (possibly empty) when the server replies. */
export async function getUpdates(offset: number, longPollSeconds = 30): Promise<TgUpdate[]> {
  return call<TgUpdate[]>(
    "getUpdates",
    { offset, timeout: longPollSeconds, allowed_updates: ["message"] },
    (longPollSeconds + 10) * 1000,
  );
}

/** Send a plain-text message. Best-effort — logs and swallows errors. */
export async function sendMessage(chatId: number | string, text: string): Promise<void> {
  try {
    await call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("[telegram] sendMessage failed:", (err as Error).message);
  }
}

/** Resolve the bot's own username (for nicer /start copy). */
export async function getMe(): Promise<TgUser | null> {
  try {
    return await call<TgUser>("getMe", {});
  } catch {
    return null;
  }
}
