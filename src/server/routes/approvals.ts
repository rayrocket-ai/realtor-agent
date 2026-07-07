import type { FastifyInstance } from "fastify";
import { findOfferByToken, approveOffer, rejectOffer } from "../../offers/approval.js";
import {
  findPendingByToken,
  approvePendingMessage,
  rejectPendingMessage,
} from "../../approvals/messages.js";

const page = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1a1a}
  pre{white-space:pre-wrap;background:#f5f5f4;padding:16px;border-radius:8px;font-size:14px}
  .btn{display:inline-block;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;border:none;font-size:16px;cursor:pointer}
  .approve{background:#16a34a;color:#fff}.reject{background:#dc2626;color:#fff}
  textarea{width:100%;min-height:100px;font-size:16px;padding:8px}
  .muted{color:#6b7280;font-size:14px}
</style></head><body>${body}</body></html>`;

/**
 * Token-authenticated approve/reject pages. GET shows a confirmation page;
 * POST performs the action — so email scanners that prefetch links can't
 * accidentally approve an offer.
 */
export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string } }>("/approve/:token", async (req, reply) => {
    const offer = await findOfferByToken(req.params.token);
    reply.type("text/html");
    if (!offer) return page("Offer not found", `<h2>Link expired or already used</h2><p class="muted">This offer is no longer pending approval.</p>`);
    return page(
      "Approve offer",
      `<h2>Approve &amp; send this offer?</h2>
       <pre>${escapeHtml(offer.summaryMd)}</pre>
       <p><strong>Will be emailed to:</strong> ${escapeHtml(offer.recipientEmail ?? "(no recipient set — use the dashboard)")}</p>
       <form method="post" action="/approve/${encodeURIComponent(req.params.token)}">
         <button class="btn approve" type="submit">Yes — send the offer email</button>
       </form>`,
    );
  });

  app.post<{ Params: { token: string } }>("/approve/:token", async (req, reply) => {
    const offer = await findOfferByToken(req.params.token);
    reply.type("text/html");
    if (!offer) return page("Offer not found", `<h2>Link expired or already used</h2>`);
    const res = await approveOffer(offer.id, "link");
    return res.ok
      ? page("Sent", `<h2>✅ Offer approved and sent</h2><p>The offer email for <strong>${escapeHtml(offer.propertyAddress)}</strong> is on its way to ${escapeHtml(offer.recipientEmail ?? "")}.</p>`)
      : page("Failed", `<h2>⚠️ Could not send</h2><p>${escapeHtml(res.error ?? "Unknown error")}</p>`);
  });

  app.get<{ Params: { token: string } }>("/reject/:token", async (req, reply) => {
    const offer = await findOfferByToken(req.params.token);
    reply.type("text/html");
    if (!offer) return page("Offer not found", `<h2>Link expired or already used</h2>`);
    return page(
      "Reject offer",
      `<h2>Reject this offer draft</h2>
       <pre>${escapeHtml(offer.summaryMd)}</pre>
       <form method="post" action="/reject/${encodeURIComponent(req.params.token)}">
         <p><label>Feedback for the assistant (what should change?):<br>
         <textarea name="feedback" placeholder="e.g. Price too low, go to 875k. Drop the inspection condition."></textarea></label></p>
         <button class="btn reject" type="submit">Reject draft</button>
       </form>`,
    );
  });

  app.post<{ Params: { token: string }; Body: { feedback?: string } }>(
    "/reject/:token",
    async (req, reply) => {
      const offer = await findOfferByToken(req.params.token);
      reply.type("text/html");
      if (!offer) return page("Offer not found", `<h2>Link expired or already used</h2>`);
      const res = await rejectOffer(offer.id, "link", req.body?.feedback ?? "");
      return res.ok
        ? page("Rejected", `<h2>Draft rejected</h2><p>The assistant will revise based on your feedback.</p>`)
        : page("Failed", `<h2>⚠️ ${escapeHtml(res.error ?? "Unknown error")}</h2>`);
    },
  );
}

/** Draft-reply approval pages ([MSG-...] flow) — same token pattern as offers. */
export async function messageApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string } }>("/msg/approve/:token", async (req, reply) => {
    const pm = await findPendingByToken(req.params.token);
    reply.type("text/html");
    if (!pm) return page("Draft not found", `<h2>Link expired or already handled</h2>`);
    return page(
      "Send draft",
      `<h2>Send this reply?</h2>
       <pre>${escapeHtml(pm.draftText)}</pre>
       <form method="post" action="/msg/approve/${encodeURIComponent(req.params.token)}">
         <p><label>Edit before sending (optional — your edits teach the assistant):<br>
         <textarea name="edited">${escapeHtml(pm.draftText)}</textarea></label></p>
         <button class="btn approve" type="submit">Send</button>
       </form>`,
    );
  });

  app.post<{ Params: { token: string }; Body: { edited?: string } }>(
    "/msg/approve/:token",
    async (req, reply) => {
      const pm = await findPendingByToken(req.params.token);
      reply.type("text/html");
      if (!pm) return page("Draft not found", `<h2>Link expired or already handled</h2>`);
      const edited = (req.body?.edited ?? "").trim();
      const res = await approvePendingMessage(
        pm.id,
        "link",
        edited && edited !== pm.draftText ? edited : undefined,
      );
      return res.ok
        ? page("Sent", `<h2>✅ Reply sent</h2>${edited && edited !== pm.draftText ? "<p class='muted'>Your edits were recorded — the assistant learns from them overnight.</p>" : ""}`)
        : page("Failed", `<h2>⚠️ ${escapeHtml(res.error ?? "Unknown error")}</h2>`);
    },
  );

  app.get<{ Params: { token: string } }>("/msg/reject/:token", async (req, reply) => {
    const pm = await findPendingByToken(req.params.token);
    reply.type("text/html");
    if (!pm) return page("Draft not found", `<h2>Link expired or already handled</h2>`);
    return page(
      "Discard draft",
      `<h2>Discard this draft</h2>
       <pre>${escapeHtml(pm.draftText)}</pre>
       <form method="post" action="/msg/reject/${encodeURIComponent(req.params.token)}">
         <p><label>Why? (the assistant writes a new draft using this):<br>
         <textarea name="reason" placeholder="e.g. Too pushy. Don't mention price yet."></textarea></label></p>
         <button class="btn reject" type="submit">Discard</button>
       </form>`,
    );
  });

  app.post<{ Params: { token: string }; Body: { reason?: string } }>(
    "/msg/reject/:token",
    async (req, reply) => {
      const pm = await findPendingByToken(req.params.token);
      reply.type("text/html");
      if (!pm) return page("Draft not found", `<h2>Link expired or already handled</h2>`);
      const res = await rejectPendingMessage(pm.id, "link", req.body?.reason ?? "");
      return res.ok
        ? page("Discarded", `<h2>Draft discarded</h2><p class="muted">${req.body?.reason ? "A new draft will be written with your feedback." : "No reply will be sent."}</p>`)
        : page("Failed", `<h2>⚠️ ${escapeHtml(res.error ?? "Unknown error")}</h2>`);
    },
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
