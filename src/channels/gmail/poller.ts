import { eq } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";
import { gmailClient } from "../google.js";
import { config } from "../../config.js";
import { db, schema } from "../../db/client.js";
import { ingestInbound } from "../ingest.js";
import { handleOfferReply } from "../../offers/approval.js";

const HISTORY_KEY = "gmail_history_id";
const POLL_INTERVAL_MS = 45_000;

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startGmailPoller(): void {
  if (!config().gmailEnabled) {
    console.log("[gmail] not configured, poller disabled");
    return;
  }
  timer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  void pollOnce();
  console.log("[gmail] poller started (every %ds)", POLL_INTERVAL_MS / 1000);
}

export function stopGmailPoller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const gmail = gmailClient();
    const stored = await getStoredHistoryId();
    if (!stored) {
      await fullResync(gmail);
      return;
    }
    try {
      await incrementalSync(gmail, stored);
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 404) {
        // historyId too old — Gmail expired it; do a bounded resync.
        console.warn("[gmail] historyId expired, running full resync");
        await fullResync(gmail);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("[gmail] poll error:", err);
  } finally {
    running = false;
  }
}

async function getStoredHistoryId(): Promise<string | null> {
  const row = await db().query.appState.findFirst({ where: eq(schema.appState.key, HISTORY_KEY) });
  return (row?.value as string | undefined) ?? null;
}

async function storeHistoryId(id: string): Promise<void> {
  await db()
    .insert(schema.appState)
    .values({ key: HISTORY_KEY, value: id })
    .onConflictDoUpdate({ target: schema.appState.key, set: { value: id, updatedAt: new Date() } });
}

async function incrementalSync(gmail: gmail_v1.Gmail, startHistoryId: string): Promise<void> {
  let pageToken: string | undefined;
  let latest = startHistoryId;
  const messageIds = new Set<string>();

  do {
    const res = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        const id = added.message?.id;
        const labels = added.message?.labelIds ?? [];
        if (id && !labels.includes("DRAFT")) messageIds.add(id);
      }
    }
    if (res.data.historyId) latest = res.data.historyId;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  for (const id of messageIds) {
    await processMessage(gmail, id).catch((err) =>
      console.error("[gmail] failed to process message %s:", id, err),
    );
  }
  await storeHistoryId(latest);
}

/** Bounded resync: recent unread inbox mail; used on first run and expired historyId. */
async function fullResync(gmail: gmail_v1.Gmail): Promise<void> {
  const profile = await gmail.users.getProfile({ userId: "me" });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox is:unread newer_than:2d",
    maxResults: 50,
  });
  for (const m of res.data.messages ?? []) {
    if (m.id) {
      await processMessage(gmail, m.id).catch((err) =>
        console.error("[gmail] failed to process message %s:", m.id, err),
      );
    }
  }
  if (profile.data.historyId) await storeHistoryId(String(profile.data.historyId));
}

async function processMessage(gmail: gmail_v1.Gmail, messageId: string): Promise<void> {
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const msg = res.data;
  const c = config();

  const headers = new Map(
    (msg.payload?.headers ?? []).map((h) => [h.name?.toLowerCase() ?? "", h.value ?? ""]),
  );
  const from = headers.get("from") ?? "";
  const subject = headers.get("subject") ?? "";
  const rfcMessageId = headers.get("message-id") ?? null;
  const { email: fromEmail, name: fromName } = parseAddress(from);
  if (!fromEmail) return;

  const labels = msg.labelIds ?? [];
  const body = extractPlainText(msg.payload) || (msg.snippet ?? "");
  const isFromSelf =
    fromEmail.toLowerCase() === c.GMAIL_ADDRESS.toLowerCase() || labels.includes("SENT");

  // Realtor replying to an offer-approval notification: "[OFFER-xxxxxxxx]" in subject.
  if (isFromSelf && /\[OFFER-[0-9a-f]{8}\]/i.test(subject)) {
    await handleOfferReply(subject, body);
    return;
  }

  if (isFromSelf) {
    // Realtor manually emailed on a lead thread → record + pause the agent for that lead.
    const to = parseAddress(headers.get("to") ?? "").email;
    if (to && to.toLowerCase() !== c.GMAIL_ADDRESS.toLowerCase()) {
      await ingestInbound({
        channel: "gmail",
        externalId: to,
        threadRef: msg.threadId ?? null,
        externalMsgId: msg.id ?? null,
        body,
        meta: { subject, direction: "realtor_manual" },
        fromRealtor: true,
      });
    }
    return;
  }

  if (isNoise(fromEmail, headers)) return;

  // Label mode: only handle threads carrying the AI-Handle label.
  if (c.GMAIL_MODE === "label") {
    const labelId = await resolveLabelId(gmail, c.GMAIL_LABEL);
    const threadLabels = await getThreadLabels(gmail, msg.threadId ?? "");
    if (!labelId || !threadLabels.has(labelId)) return;
  }

  await ingestInbound({
    channel: "gmail",
    externalId: fromEmail,
    threadRef: msg.threadId ?? null,
    externalMsgId: msg.id ?? null,
    name: fromName,
    email: fromEmail,
    body,
    meta: { subject, rfcMessageId, gmailThreadId: msg.threadId },
  });
}

function isNoise(fromEmail: string, headers: Map<string, string>): boolean {
  if (/no-?reply|notifications?@|mailer-daemon|donotreply/i.test(fromEmail)) return true;
  if (headers.has("list-unsubscribe") || headers.has("list-id")) return true;
  const precedence = headers.get("precedence") ?? "";
  if (/bulk|list|junk/i.test(precedence)) return true;
  if (headers.get("auto-submitted") && headers.get("auto-submitted") !== "no") return true;
  return false;
}

export function parseAddress(raw: string): { email: string | null; name: string | null } {
  const angled = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angled) {
    return { name: angled[1]?.trim() || null, email: angled[2]?.trim().toLowerCase() ?? null };
  }
  const bare = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare)) return { name: null, email: bare.toLowerCase() };
  return { name: null, email: null };
}

export function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined | null): string {
  return findPart(payload, "text/plain") || htmlToText(findPart(payload, "text/html"));
}

function findPart(part: gmail_v1.Schema$MessagePart | undefined | null, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const text = findPart(child, mime);
    if (text) return text;
  }
  return "";
}

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let cachedLabelId: string | null | undefined;
async function resolveLabelId(gmail: gmail_v1.Gmail, name: string): Promise<string | null> {
  if (cachedLabelId !== undefined) return cachedLabelId;
  const res = await gmail.users.labels.list({ userId: "me" });
  cachedLabelId =
    res.data.labels?.find((l) => l.name?.toLowerCase() === name.toLowerCase())?.id ?? null;
  if (!cachedLabelId) {
    console.warn(`[gmail] label "${name}" not found — create it in Gmail and apply it to lead threads`);
  }
  return cachedLabelId;
}

async function getThreadLabels(gmail: gmail_v1.Gmail, threadId: string): Promise<Set<string>> {
  if (!threadId) return new Set();
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "minimal" });
  const all = new Set<string>();
  for (const m of res.data.messages ?? []) for (const l of m.labelIds ?? []) all.add(l);
  return all;
}
