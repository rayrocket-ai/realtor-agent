import fs from "node:fs";
import { config } from "../config.js";
import { otpFilePath } from "./browser.js";

/**
 * Get the REALM one-time verification code when the login flow asks for one.
 * Two sources, polled together for up to ~3 minutes:
 *   1. A code dropped manually — the dashboard's "verification code" box or
 *      `echo 123456 > data/booking/otp.txt` on the server.
 *   2. The realtor's Gmail (when connected): a recent message that mentions
 *      REALM_OTP_SENDER (e.g. carrier-forwarded SMS or an emailed code).
 */

/** Extract a 4–8 digit one-time code from message text. Prefers digits near "code". */
export function extractOtpCode(text: string): string | null {
  const near = /\bcode\b[^0-9]{0,40}(\d{4,8})\b/i.exec(text) ?? /\b(\d{4,8})\b[^0-9]{0,40}\bcode\b/i.exec(text);
  if (near) return near[1]!;
  const any = /\b(\d{6})\b/.exec(text); // 6 digits is the overwhelmingly common OTP length
  return any ? any[1]! : null;
}

function readOtpFile(): string | null {
  const p = otpFilePath();
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    fs.unlinkSync(p); // single use
    const code = extractOtpCode(raw) ?? (/^\d{4,8}$/.test(raw.trim()) ? raw.trim() : null);
    return code;
  } catch {
    return null;
  }
}

async function readOtpFromGmail(since: Date): Promise<string | null> {
  const c = config();
  if (!c.gmailEnabled || !c.REALM_OTP_SENDER) return null;
  try {
    const { gmailClient } = await import("../channels/google.js");
    const gmail = gmailClient();
    const list = await gmail.users.messages.list({
      userId: "me",
      q: `after:${Math.floor(since.getTime() / 1000)}`,
      maxResults: 15,
    });
    const senderDigits = c.REALM_OTP_SENDER.replace(/\D/g, "");
    const senderLower = c.REALM_OTP_SENDER.toLowerCase();
    for (const m of list.data.messages ?? []) {
      const msg = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
      const headers = msg.data.payload?.headers ?? [];
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
      const snippet = msg.data.snippet ?? "";
      const haystack = `${from}\n${subject}\n${snippet}`;
      const mentionsSender =
        haystack.toLowerCase().includes(senderLower) ||
        (senderDigits.length >= 7 && haystack.replace(/\D/g, "").includes(senderDigits));
      if (!mentionsSender) continue;
      const code = extractOtpCode(`${subject}\n${snippet}`);
      if (code) return code;
    }
  } catch (err) {
    console.warn("[booking] gmail OTP lookup failed:", (err as Error).message);
  }
  return null;
}

async function notifyWaiting(): Promise<void> {
  try {
    const { enqueue } = await import("../jobs/queue.js");
    await enqueue({
      type: "notify-realtor",
      payload: {
        subject: "[BOOKING] REALM is asking for a verification code",
        body:
          "REALM sent a one-time code during a booking sign-in.\n\n" +
          `Paste it in the box at ${config().APP_BASE_URL}/admin/bookings within the next ~5 minutes ` +
          "and the booking continues by itself. If it times out, just retry the booking.",
      },
      dedupeKey: "booking-otp-wait",
    });
  } catch {
    // No DB (e.g. standalone login CLI) — the console message below still shows.
  }
}

export async function waitForOtp(since: Date, timeoutMs = 300_000): Promise<string | null> {
  console.log(`[booking] REALM asked for a verification code — watching Gmail and ${otpFilePath()}`);
  await notifyWaiting();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fromFile = readOtpFile();
    if (fromFile) return fromFile;
    const fromGmail = await readOtpFromGmail(since);
    if (fromGmail) return fromGmail;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}
