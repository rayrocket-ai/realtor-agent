import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { approveOffer, rejectOffer } from "../../offers/approval.js";
import { sendToLead } from "../../channels/outbound.js";
import { escapeHtml as esc } from "./approvals.js";

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — realtor-agent</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1a1a1a}
  nav a{margin-right:16px;text-decoration:none;color:#2563eb;font-weight:600}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#e5e7eb}
  .pill.offer_sent,.pill.approved_sent{background:#dcfce7}.pill.pending_approval{background:#fef9c3}
  .pill.rejected,.pill.lost{background:#fee2e2}.pill.paused{background:#fee2e2}
  .msg{padding:8px 12px;border-radius:8px;margin:6px 0;max-width:80%;white-space:pre-wrap;font-size:14px}
  .inbound{background:#f3f4f6}.outbound{background:#dbeafe;margin-left:auto}.internal_note{background:#fef9c3;font-style:italic}
  .btn{display:inline-block;padding:6px 14px;border-radius:6px;border:none;font-weight:600;cursor:pointer;font-size:14px}
  .approve{background:#16a34a;color:#fff}.reject{background:#dc2626;color:#fff}.neutral{background:#e5e7eb}
  textarea,input[type=text],input[type=email]{width:100%;padding:6px;font-size:14px;box-sizing:border-box}
  pre{white-space:pre-wrap;background:#f5f5f4;padding:12px;border-radius:8px;font-size:13px}
  .muted{color:#6b7280;font-size:13px}
  form.inline{display:inline}
</style></head><body>
<nav><a href="/admin">Leads</a><a href="/admin/offers">Offers</a><a href="/admin/showings">Showings</a></nav>
<h2>${esc(title)}</h2>
${body}
</body></html>`;
}

function fmt(d: Date | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", app.basicAuth);

  app.get("/", async (_req, reply) => {
    const rows = await db().query.leads.findMany({
      orderBy: desc(schema.leads.updatedAt),
      limit: 100,
    });
    const body = `<table><tr><th>Lead</th><th>Contact</th><th>Stage</th><th>Last activity</th></tr>
      ${rows
        .map(
          (l) => `<tr>
        <td><a href="/admin/leads/${l.id}">${esc(l.name ?? "(no name)")}</a>${l.paused ? ' <span class="pill paused">paused</span>' : ""}</td>
        <td>${esc(l.email ?? "")}<br>${esc(l.phone ?? "")}</td>
        <td><span class="pill ${l.stage}">${esc(l.stage)}</span></td>
        <td>${fmt(l.updatedAt)}</td></tr>`,
        )
        .join("")}
    </table>${rows.length === 0 ? '<p class="muted">No leads yet. They appear automatically when someone emails or messages you.</p>' : ""}`;
    reply.type("text/html");
    return layout("Leads", body);
  });

  app.get<{ Params: { id: string } }>("/leads/:id", async (req, reply) => {
    const d = db();
    const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, req.params.id) });
    reply.type("text/html");
    if (!lead) return layout("Not found", "<p>Lead not found.</p>");

    const msgs = await d.query.messages.findMany({
      where: eq(schema.messages.leadId, lead.id),
      orderBy: desc(schema.messages.createdAt),
      limit: 100,
    });

    const timeline = msgs
      .reverse()
      .map(
        (m) =>
          `<div class="msg ${m.direction}"><span class="muted">[${esc(m.channel)}] ${fmt(m.createdAt)}</span><br>${esc(m.body)}</div>`,
      )
      .join("");

    const body = `
      <p>${esc(lead.email ?? "")} ${esc(lead.phone ?? "")} — <span class="pill ${lead.stage}">${esc(lead.stage)}</span></p>
      <p class="muted">Preferences: ${esc(JSON.stringify(lead.preferences ?? {}))}</p>
      ${lead.notes ? `<p class="muted">Notes: ${esc(lead.notes)}</p>` : ""}
      <form class="inline" method="post" action="/admin/leads/${lead.id}/pause">
        <button class="btn ${lead.paused ? "approve" : "reject"}" type="submit">
          ${lead.paused ? "Resume AI replies" : "Pause AI (take over)"}
        </button>
      </form>
      <h3>Timeline</h3>
      <div style="display:flex;flex-direction:column">${timeline || '<p class="muted">No messages.</p>'}</div>
      <h3>Send a manual message</h3>
      <p class="muted">Sends from your accounts on the lead's most recent channel, and pauses the AI on this lead for 4 hours.</p>
      <form method="post" action="/admin/leads/${lead.id}/send">
        <textarea name="text" required placeholder="Type your message…"></textarea>
        <button class="btn approve" type="submit">Send</button>
      </form>`;
    return layout(lead.name ?? lead.email ?? "Lead", body);
  });

  app.post<{ Params: { id: string } }>("/leads/:id/pause", async (req, reply) => {
    const d = db();
    const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, req.params.id) });
    if (lead) {
      await d
        .update(schema.leads)
        .set({ paused: !lead.paused, pausedUntil: null, updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
    }
    return reply.redirect(`/admin/leads/${req.params.id}`);
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/leads/:id/send",
    async (req, reply) => {
      const d = db();
      const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, req.params.id) });
      const text = (req.body?.text ?? "").trim();
      if (lead && text) {
        await sendToLead(lead, text);
        await d
          .update(schema.leads)
          .set({ pausedUntil: new Date(Date.now() + 4 * 3600_000), updatedAt: new Date() })
          .where(eq(schema.leads.id, lead.id));
      }
      return reply.redirect(`/admin/leads/${req.params.id}`);
    },
  );

  app.get("/offers", async (_req, reply) => {
    const rows = await db().query.offers.findMany({
      orderBy: desc(schema.offers.updatedAt),
      limit: 50,
    });
    const body = rows
      .map((o) => {
        const editForm =
          o.status === "pending_approval"
            ? `<form method="post" action="/admin/offers/${o.id}/approve">
                 <p><label>Recipient (listing agent email):<br><input type="email" name="recipientEmail" value="${esc(o.recipientEmail ?? "")}" required></label></p>
                 <p><label>Subject:<br><input type="text" name="subject" value="${esc(o.draftEmailSubject)}"></label></p>
                 <p><label>Email body:<br><textarea name="body" rows="10">${esc(o.draftEmailBody)}</textarea></label></p>
                 <button class="btn approve" type="submit">Approve &amp; send</button>
               </form>
               <form method="post" action="/admin/offers/${o.id}/reject">
                 <p><label>Or reject with feedback:<br><input type="text" name="feedback" placeholder="What should change?"></label></p>
                 <button class="btn reject" type="submit">Reject draft</button>
               </form>`
            : "";
        return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
          <p><strong>${esc(o.propertyAddress)}</strong> <span class="pill ${o.status}">${esc(o.status)}</span>
             <span class="muted">${fmt(o.createdAt)}</span></p>
          <pre>${esc(o.summaryMd)}</pre>
          ${o.rejectionFeedback ? `<p class="muted">Rejection feedback: ${esc(o.rejectionFeedback)}</p>` : ""}
          ${editForm}
        </div>`;
      })
      .join("");
    reply.type("text/html");
    return layout("Offers", body || '<p class="muted">No offers yet.</p>');
  });

  app.post<{ Params: { id: string }; Body: { recipientEmail?: string; subject?: string; body?: string } }>(
    "/offers/:id/approve",
    async (req, reply) => {
      const res = await approveOffer(req.params.id, "dashboard", {
        recipientEmail: req.body?.recipientEmail?.trim(),
        subject: req.body?.subject,
        body: req.body?.body,
      });
      if (!res.ok) {
        reply.type("text/html");
        return layout("Approve failed", `<p>⚠️ ${esc(res.error ?? "Unknown error")}</p><p><a href="/admin/offers">Back</a></p>`);
      }
      return reply.redirect("/admin/offers");
    },
  );

  app.post<{ Params: { id: string }; Body: { feedback?: string } }>(
    "/offers/:id/reject",
    async (req, reply) => {
      await rejectOffer(req.params.id, "dashboard", req.body?.feedback ?? "");
      return reply.redirect("/admin/offers");
    },
  );

  app.get("/showings", async (_req, reply) => {
    const rows = await db().query.showings.findMany({
      orderBy: desc(schema.showings.startsAt),
      limit: 100,
    });
    const body = `<table><tr><th>Property</th><th>When</th><th>Status</th></tr>
      ${rows
        .map(
          (s) =>
            `<tr><td><a href="/admin/leads/${s.leadId}">${esc(s.propertyAddress)}</a>${s.mlsNumber ? ` <span class="muted">MLS ${esc(s.mlsNumber)}</span>` : ""}</td>
             <td>${fmt(s.startsAt)}</td><td><span class="pill ${s.status}">${esc(s.status)}</span></td></tr>`,
        )
        .join("")}
    </table>${rows.length === 0 ? '<p class="muted">No showings yet.</p>' : ""}`;
    reply.type("text/html");
    return layout("Showings", body);
  });
}
