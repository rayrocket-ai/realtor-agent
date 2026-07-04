import { gmailClient } from "../google.js";
import { config } from "../../config.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MailOptions {
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
  inReplyTo?: string | null; // Message-ID header value of the message being replied to
  html?: boolean;
}

function buildRaw(opts: MailOptions): string {
  const c = config();
  const headers = [
    `From: ${c.REALTOR_NAME} <${c.GMAIL_ADDRESS}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    opts.html
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  return b64url(headers.join("\r\n") + "\r\n\r\n" + opts.body);
}

/** Send an email (optionally threaded). Returns the Gmail message id. */
export async function sendEmail(opts: MailOptions): Promise<string> {
  const res = await gmailClient().users.messages.send({
    userId: "me",
    requestBody: { raw: buildRaw(opts), threadId: opts.threadId ?? undefined },
  });
  return res.data.id ?? "";
}

/** Create a Gmail draft without sending. Returns the draft id. */
export async function createDraft(opts: MailOptions): Promise<string> {
  const res = await gmailClient().users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: buildRaw(opts), threadId: opts.threadId ?? undefined } },
  });
  return res.data.id ?? "";
}

/** Email the realtor themselves (approval requests, escalations, digests). */
export async function notifyRealtor(subject: string, body: string, html = false): Promise<string> {
  const c = config();
  return sendEmail({ to: c.REALTOR_EMAIL || c.GMAIL_ADDRESS, subject, body, html });
}
