import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { enqueue } from "../jobs/queue.js";
import { sendToLead } from "../channels/outbound.js";
import { generateToken, hashToken } from "../offers/approval.js";
import type { Lead, PendingMessage } from "../db/schema.js";

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

export function msgShortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Effective approval mode: app_state override (dashboard toggle) wins over env. */
export async function approvalMode(): Promise<"all" | "off"> {
  const row = await db().query.appState.findFirst({
    where: eq(schema.appState.key, "approval_mode"),
  });
  const v = row?.value as string | undefined;
  if (v === "all" || v === "off") return v;
  return config().APPROVAL_MODE;
}

export async function setApprovalMode(mode: "all" | "off"): Promise<void> {
  await db()
    .insert(schema.appState)
    .values({ key: "approval_mode", value: mode })
    .onConflictDoUpdate({
      target: schema.appState.key,
      set: { value: mode, updatedAt: new Date() },
    });
}

export async function approvalRequired(lead: Lead): Promise<boolean> {
  if (lead.autoApprove) return false;
  return (await approvalMode()) === "all";
}

/**
 * Queue a drafted reply for the realtor's review and notify them.
 * Returns the pending message id.
 */
export async function queueDraft(lead: Lead, channel: string, draftText: string): Promise<string> {
  const c = config();
  const token = generateToken();
  const [row] = await db()
    .insert(schema.pendingMessages)
    .values({
      leadId: lead.id,
      channel,
      draftText,
      approvalTokenHash: hashToken(token),
      tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    })
    .returning();

  const short = msgShortId(row!.id);
  await enqueue({
    type: "notify-realtor",
    payload: {
      subject: `[MSG-${short}] Draft reply to ${lead.name ?? lead.email ?? lead.phone ?? "lead"} (${channel})`,
      body:
        `The assistant drafted this reply:\n\n` +
        `------------------------------\n${draftText}\n------------------------------\n\n` +
        `SEND AS-IS: ${c.APP_BASE_URL}/msg/approve/${token}\n` +
        `DISCARD: ${c.APP_BASE_URL}/msg/reject/${token}\n` +
        `Edit on dashboard: ${c.APP_BASE_URL}/admin/approvals\n\n` +
        `Or reply to this email: "approve" sends it as-is; "reject" (optionally with a reason) discards it;\n` +
        `anything else you write becomes the message and is sent instead — your edits teach the assistant.\n\n` +
        `Timeline: ${c.APP_BASE_URL}/admin/leads/${lead.id}`,
    },
  });
  return row!.id;
}

export async function findPendingByToken(token: string): Promise<PendingMessage | null> {
  const row = await db().query.pendingMessages.findFirst({
    where: and(
      eq(schema.pendingMessages.approvalTokenHash, hashToken(token)),
      eq(schema.pendingMessages.status, "pending"),
    ),
  });
  if (!row) return null;
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() < Date.now()) {
    await db()
      .update(schema.pendingMessages)
      .set({ status: "expired" })
      .where(eq(schema.pendingMessages.id, row.id));
    return null;
  }
  return row;
}

/**
 * Approve (optionally with edits) and send. Edits are recorded as agent
 * feedback so the nightly distiller can turn them into lessons.
 */
export async function approvePendingMessage(
  id: string,
  via: "link" | "email_reply" | "dashboard",
  editedText?: string,
): Promise<{ ok: boolean; error?: string }> {
  const d = db();
  const claimed = await d
    .update(schema.pendingMessages)
    .set({
      status: "approved",
      decidedAt: new Date(),
      decidedVia: via,
      approvalTokenHash: null,
    })
    .where(and(eq(schema.pendingMessages.id, id), eq(schema.pendingMessages.status, "pending")))
    .returning();
  const pm = claimed[0];
  if (!pm) return { ok: false, error: "Draft already decided or expired." };

  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, pm.leadId) });
  if (!lead) return { ok: false, error: "Lead no longer exists." };

  const finalText = (editedText ?? "").trim() || pm.draftText;
  try {
    await sendToLead(lead, finalText);
  } catch (err) {
    await d
      .update(schema.pendingMessages)
      .set({ status: "pending", decidedAt: null, decidedVia: null })
      .where(eq(schema.pendingMessages.id, pm.id));
    return { ok: false, error: `Send failed: ${(err as Error).message}` };
  }

  await d
    .update(schema.pendingMessages)
    .set({ sentText: finalText })
    .where(eq(schema.pendingMessages.id, pm.id));

  if (finalText !== pm.draftText) {
    await d.insert(schema.agentFeedback).values({
      leadId: pm.leadId,
      draftText: pm.draftText,
      sentText: finalText,
    });
  }
  return { ok: true };
}

export async function rejectPendingMessage(
  id: string,
  via: "link" | "email_reply" | "dashboard",
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const d = db();
  const claimed = await d
    .update(schema.pendingMessages)
    .set({
      status: "rejected",
      decidedAt: new Date(),
      decidedVia: via,
      approvalTokenHash: null,
    })
    .where(and(eq(schema.pendingMessages.id, id), eq(schema.pendingMessages.status, "pending")))
    .returning();
  const pm = claimed[0];
  if (!pm) return { ok: false, error: "Draft already decided or expired." };

  if (reason.trim()) {
    await d.insert(schema.messages).values({
      leadId: pm.leadId,
      channel: pm.channel,
      direction: "internal_note",
      body: `Draft rejected by ${config().REALTOR_NAME}: ${reason.trim()}. Write a better reply.`,
    });
    await d.insert(schema.lessons).values({
      lesson: reason.trim().slice(0, 300),
      sourceType: "correction",
      category: "corrections",
    });
    await enqueue({
      type: "agent-turn",
      payload: { leadId: pm.leadId, reason: "draft_rejected" },
      dedupeKey: `agent-turn:${pm.leadId}`,
    });
  }
  return { ok: true };
}

/** Handle the realtor replying to a "[MSG-xxxxxxxx]" notification email. */
export async function handleDraftReply(subject: string, body: string): Promise<boolean> {
  const m = subject.match(/\[MSG-([0-9a-f]{8})\]/i);
  if (!m) return false;
  const short = m[1]!.toLowerCase();

  const pending = await db().query.pendingMessages.findMany({
    where: eq(schema.pendingMessages.status, "pending"),
  });
  const pm = pending.find((p) => msgShortId(p.id) === short);
  if (!pm) return true; // it was for us, but already decided — swallow

  // Take everything before the quoted reply as the realtor's text.
  const cleaned = body
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(">"))
    .join("\n")
    .split(/\r?\nOn .* wrote:\r?\n?/)[0]!
    .trim();
  const first = cleaned.toLowerCase();

  if (/^(approve|approved|yes|send|send it|ok|👍)\s*$/.test(first)) {
    await approvePendingMessage(pm.id, "email_reply");
  } else if (/^(reject|rejected|no|discard)\b/.test(first)) {
    const reason = cleaned.replace(/^(reject|rejected|no|discard)\b[:,\s]*/i, "");
    await rejectPendingMessage(pm.id, "email_reply", reason);
  } else if (cleaned.length > 0) {
    // Edited text — send the realtor's version and learn from the diff.
    await approvePendingMessage(pm.id, "email_reply", cleaned);
  }
  return true;
}
