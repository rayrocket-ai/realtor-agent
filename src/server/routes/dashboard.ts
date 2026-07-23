import type { FastifyInstance } from "fastify";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { approveOffer, rejectOffer } from "../../offers/approval.js";
import { sendToLead } from "../../channels/outbound.js";
import {
  approvalMode,
  setApprovalMode,
  approvePendingMessage,
  rejectPendingMessage,
} from "../../approvals/messages.js";
import { escapeHtml as esc } from "./approvals.js";
import { labelAnswer } from "../../leads/qualify.js";

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
  .pill.hot{background:#fecaca}.pill.warm{background:#fef9c3}.pill.cold{background:#dbeafe}
  .msg{padding:8px 12px;border-radius:8px;margin:6px 0;max-width:80%;white-space:pre-wrap;font-size:14px}
  .inbound{background:#f3f4f6}.outbound{background:#dbeafe;margin-left:auto}.internal_note{background:#fef9c3;font-style:italic}
  .btn{display:inline-block;padding:6px 14px;border-radius:6px;border:none;font-weight:600;cursor:pointer;font-size:14px}
  .approve{background:#16a34a;color:#fff}.reject{background:#dc2626;color:#fff}.neutral{background:#e5e7eb}
  textarea,input[type=text],input[type=email]{width:100%;padding:6px;font-size:14px;box-sizing:border-box}
  pre{white-space:pre-wrap;background:#f5f5f4;padding:12px;border-radius:8px;font-size:13px}
  .muted{color:#6b7280;font-size:13px}
  form.inline{display:inline}
</style></head><body>
<nav><a href="/admin">Leads</a><a href="/admin/social">Social Leads</a><a href="/admin/approvals">Approvals</a><a href="/admin/offers">Offers</a><a href="/admin/showings">Showings</a><a href="/admin/tours">Tours</a><a href="/admin/feedback">Feedback</a><a href="/admin/listings">My Listings</a><a href="/admin/activity">Activity</a></nav>
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

  app.get("/social", async (_req, reply) => {
    const d = db();
    const rows = await d.query.leadSubmissions.findMany({
      orderBy: desc(schema.leadSubmissions.createdAt),
      limit: 100,
    });
    const leadsById = new Map((await d.query.leads.findMany()).map((l) => [l.id, l] as const));
    const shareUrl = `${config().APP_BASE_URL}/connect`;
    const body = `<p class="muted">Share this link on your social media profiles: <strong>${esc(shareUrl)}</strong>
      — add <code>?src=instagram</code> / <code>?src=tiktok</code> to see where each lead came from,
      and <code>?lang=prs</code> to open in Dari by default.</p>
      <table><tr><th>When</th><th>Lead</th><th>Intent</th><th>Score</th><th>Lang</th><th>Answers</th><th>Source</th></tr>
      ${rows
        .map((s) => {
          const lead = leadsById.get(s.leadId);
          const answers = Object.entries(s.answers ?? {})
            .map(([k, v]) => {
              const { label, value } = labelAnswer(k, v);
              return `${esc(label)}: ${esc(value.length > 80 ? `${value.slice(0, 80)}…` : value)}`;
            })
            .join("<br>");
          return `<tr>
            <td>${fmt(s.createdAt)}</td>
            <td><a href="/admin/leads/${s.leadId}">${esc(lead?.name ?? lead?.email ?? lead?.phone ?? "lead")}</a><br>
              <span class="muted">${esc(lead?.phone ?? "")} ${esc(lead?.email ?? "")}</span></td>
            <td><span class="pill">${esc(s.intent)}</span></td>
            <td><span class="pill ${s.score}">${esc(s.score)}</span></td>
            <td>${s.language === "prs" ? "دری" : "EN"}</td>
            <td class="muted">${answers || "—"}</td>
            <td class="muted">${esc(s.source ?? "")}</td></tr>`;
        })
        .join("")}
      </table>${rows.length === 0 ? '<p class="muted">No form submissions yet. Put the link above in your Instagram/TikTok bio to start collecting leads.</p>' : ""}`;
    reply.type("text/html");
    return layout("Social media leads", body);
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

  app.get("/approvals", async (_req, reply) => {
    const d = db();
    const [pending, mode, recentDecided] = await Promise.all([
      d.query.pendingMessages.findMany({
        where: eq(schema.pendingMessages.status, "pending"),
        orderBy: asc(schema.pendingMessages.createdAt),
      }),
      approvalMode(),
      d.query.pendingMessages.findMany({
        where: eq(schema.pendingMessages.status, "approved"),
        orderBy: desc(schema.pendingMessages.decidedAt),
        limit: 20,
      }),
    ]);
    const cleanApprovals = recentDecided.filter((p) => p.sentText === p.draftText).length;

    const leadsById = new Map(
      (await d.query.leads.findMany()).map((l) => [l.id, l] as const),
    );

    const cards = pending
      .map((p) => {
        const lead = leadsById.get(p.leadId);
        return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
          <p><strong><a href="/admin/leads/${p.leadId}">${esc(lead?.name ?? lead?.email ?? "lead")}</a></strong>
             <span class="pill">${esc(p.channel)}</span> <span class="muted">${fmt(p.createdAt)}</span></p>
          <form method="post" action="/admin/approvals/${p.id}/approve">
            <textarea name="edited" rows="5">${esc(p.draftText)}</textarea>
            <button class="btn approve" type="submit">Send${"" /* edits auto-detected */}</button>
          </form>
          <form method="post" action="/admin/approvals/${p.id}/reject" class="inline">
            <input type="text" name="reason" placeholder="Reject with feedback…">
            <button class="btn reject" type="submit">Discard</button>
          </form>
        </div>`;
      })
      .join("");

    reply.type("text/html");
    return layout(
      "Approvals",
      `<p>Training wheels: <strong>${mode === "all" ? "ON — every reply needs your approval" : "OFF — replies send automatically"}</strong>
       <form class="inline" method="post" action="/admin/approvals/mode">
         <input type="hidden" name="mode" value="${mode === "all" ? "off" : "all"}">
         <button class="btn neutral" type="submit">${mode === "all" ? "Turn OFF (go full-auto)" : "Turn ON"}</button>
       </form></p>
       <p class="muted">Recent drafts sent without edits: ${cleanApprovals}/${recentDecided.length || 0} — when this is consistently high, it's safe to go full-auto.</p>
       ${cards || '<p class="muted">Nothing waiting for you. 🎉</p>'}`,
    );
  });

  app.post<{ Body: { mode?: string } }>("/approvals/mode", async (req, reply) => {
    const mode = req.body?.mode === "off" ? "off" : "all";
    await setApprovalMode(mode);
    return reply.redirect("/admin/approvals");
  });

  app.post<{ Params: { id: string }; Body: { edited?: string } }>(
    "/approvals/:id/approve",
    async (req, reply) => {
      const pm = await db().query.pendingMessages.findFirst({
        where: eq(schema.pendingMessages.id, req.params.id),
      });
      if (pm) {
        const edited = (req.body?.edited ?? "").trim();
        await approvePendingMessage(
          pm.id,
          "dashboard",
          edited && edited !== pm.draftText ? edited : undefined,
        );
      }
      return reply.redirect("/admin/approvals");
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/approvals/:id/reject",
    async (req, reply) => {
      await rejectPendingMessage(req.params.id, "dashboard", req.body?.reason ?? "");
      return reply.redirect("/admin/approvals");
    },
  );

  app.get("/tours", async (_req, reply) => {
    const rows = await db().query.tours.findMany({ orderBy: desc(schema.tours.createdAt), limit: 30 });
    const body = rows
      .map(
        (t) => `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
        <p><strong>${esc(t.tourDate)}</strong> <span class="pill ${t.status}">${esc(t.status)}</span>
           <a href="/admin/leads/${t.leadId}" class="muted">lead</a></p>
        <pre>${esc(t.itineraryMd ?? "(itinerary not generated yet — agent calls finalize_tour once all stops are booked)")}</pre>
      </div>`,
      )
      .join("");
    reply.type("text/html");
    return layout("Tours", body || '<p class="muted">No tours yet.</p>');
  });

  app.get("/feedback", async (_req, reply) => {
    const d = db();
    const rows = await d.query.listingShowings.findMany({
      orderBy: desc(schema.listingShowings.updatedAt),
      limit: 100,
    });
    const listingsById = new Map((await d.query.listings.findMany()).map((l) => [l.id, l] as const));
    const body = `<table><tr><th>Listing</th><th>Showing agent</th><th>Buyer interest</th><th>Next follow-up</th><th>Notes</th></tr>
      ${rows
        .map(
          (r) => `<tr>
        <td>${esc(listingsById.get(r.listingId)?.propertyAddress ?? "?")}</td>
        <td>${r.agentLeadId ? `<a href="/admin/leads/${r.agentLeadId}">` : ""}${esc(r.agentName ?? r.agentEmail ?? "?")}${r.agentLeadId ? "</a>" : ""}</td>
        <td><span class="pill">${esc(r.buyerInterest ?? "awaiting")}</span> ${r.followupStatus === "closed" ? '<span class="muted">closed</span>' : ""}</td>
        <td>${fmt(r.nextFollowupAt)}</td>
        <td class="muted">${esc((r.feedbackNotes ?? "").slice(0, 120))}</td></tr>`,
        )
        .join("")}
    </table>${rows.length === 0 ? '<p class="muted">No listing showings yet — they appear automatically from BrokerBay confirmation emails.</p>' : ""}`;
    reply.type("text/html");
    return layout("Listing feedback pipeline", body);
  });

  app.get("/listings", async (_req, reply) => {
    const rows = await db().query.listings.findMany({ orderBy: desc(schema.listings.createdAt) });
    const body = `<form method="post" action="/admin/listings">
        <p><input type="text" name="address" placeholder="Property address (as it appears in BrokerBay emails)" required>
        <input type="text" name="mls" placeholder="MLS # (optional)">
        <button class="btn approve" type="submit">Add listing</button></p>
      </form>
      <table><tr><th>Address</th><th>MLS</th><th>Status</th><th></th></tr>
      ${rows
        .map(
          (l) => `<tr><td>${esc(l.propertyAddress)}</td><td>${esc(l.mlsNumber ?? "")}</td>
          <td><span class="pill ${l.status}">${esc(l.status)}</span></td>
          <td><form class="inline" method="post" action="/admin/listings/${l.id}/toggle"><button class="btn neutral" type="submit">${l.status === "active" ? "Mark sold/inactive" : "Reactivate"}</button></form></td></tr>`,
        )
        .join("")}
      </table>
      <p class="muted">Add your active listings here so BrokerBay showing confirmations on them trigger the feedback follow-up engine.</p>`;
    reply.type("text/html");
    return layout("My Listings", body);
  });

  app.post<{ Body: { address?: string; mls?: string } }>("/listings", async (req, reply) => {
    const address = (req.body?.address ?? "").trim();
    if (address) {
      await db().insert(schema.listings).values({
        propertyAddress: address,
        mlsNumber: (req.body?.mls ?? "").trim() || null,
      });
    }
    return reply.redirect("/admin/listings");
  });

  app.post<{ Params: { id: string } }>("/listings/:id/toggle", async (req, reply) => {
    const l = await db().query.listings.findFirst({ where: eq(schema.listings.id, req.params.id) });
    if (l) {
      await db()
        .update(schema.listings)
        .set({ status: l.status === "active" ? "sold" : "active" })
        .where(eq(schema.listings.id, l.id));
    }
    return reply.redirect("/admin/listings");
  });

  app.get("/activity", async (_req, reply) => {
    const runs = await db().query.agentRuns.findMany({
      orderBy: desc(schema.agentRuns.createdAt),
      limit: 50,
    });
    const body = `<table><tr><th>When</th><th>Trigger</th><th>Tools used</th><th>Outcome</th></tr>
      ${runs
        .map((r) => {
          const tools = (r.toolCalls as Array<{ name?: string }>).map((t) => t.name).filter(Boolean).join(", ");
          return `<tr><td>${fmt(r.createdAt)}</td>
          <td>${r.leadId ? `<a href="/admin/leads/${r.leadId}">${esc(r.trigger)}</a>` : esc(r.trigger)}</td>
          <td class="muted">${esc(tools || "—")}</td>
          <td>${r.error ? `<span class="pill rejected">error</span> <span class="muted">${esc(r.error.slice(0, 80))}</span>` : esc((r.output ?? "").slice(0, 120))}</td></tr>`;
        })
        .join("")}
    </table>`;
    reply.type("text/html");
    return layout("Agent activity", body);
  });

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
