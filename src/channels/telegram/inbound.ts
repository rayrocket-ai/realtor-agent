/** Normalizes a Telegram Bot API webhook update into the ingestion shape. */
export interface NormalizedTelegram {
  chatId: string;
  messageId: string;
  name: string | null;
  username: string | null;
  text: string;
}

type AnyObj = Record<string, unknown>;

export function normalizeTelegramUpdate(payload: unknown): NormalizedTelegram | null {
  if (!payload || typeof payload !== "object") return null;
  const update = payload as AnyObj;
  const msg = update.message as AnyObj | undefined;
  if (!msg || typeof msg !== "object") return null; // edited_message, callbacks, etc. — ignore

  const text = typeof msg.text === "string" ? msg.text : null;
  if (!text) return null; // photos/stickers/voice — the agent only handles text for now

  const chat = (msg.chat ?? {}) as AnyObj;
  const from = (msg.from ?? {}) as AnyObj;
  if (chat.type !== "private") return null; // only 1:1 lead chats, never groups
  if (from.is_bot === true) return null;

  const chatId = chat.id != null ? String(chat.id) : null;
  const messageId = msg.message_id != null ? String(msg.message_id) : null;
  if (!chatId || !messageId) return null;

  const first = typeof from.first_name === "string" ? from.first_name : "";
  const last = typeof from.last_name === "string" ? from.last_name : "";
  const name = `${first} ${last}`.trim() || null;

  return {
    chatId,
    messageId,
    name,
    username: typeof from.username === "string" ? from.username : null,
    text,
  };
}
