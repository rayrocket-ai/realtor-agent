import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { escapeHtml as esc } from "./approvals.js";
import { layout, fmt } from "./dashboard.js";
import { parseRequestedTime, TimeParseError } from "../../booking/time.js";
import { createBookingRequest, retryBooking } from "../../booking/service.js";
import { listShots, shotPath, otpFilePath } from "../../booking/browser.js";

const STATUS_HINTS: Record<string, string> = {
  pending: "queued — the worker picks it up within ~15s",
  running: "browser is working through REALM/BrokerBay right now",
  submitted: "request sent — waiting for the listing side to approve",
  confirmed: "confirmed by BrokerBay",
  needs_attention: "stopped — see the reason below",
  failed: "failed — see the error below",
  dry_run: "dry run finished (nothing submitted)",
};

function bookingForm(values: { address?: string; time?: string; notes?: string; error?: string } = {}): string {
  const c = config();
  return `
  ${values.error ? `<p style="color:#dc2626">⚠️ ${esc(values.error)}</p>` : ""}
  ${!c.bookingEnabled ? '<p style="color:#dc2626">⚠️ REALM credentials are not configured (REALM_USERNAME / REALM_PASSWORD in .env) — requests will park as “needs attention”.</p>' : ""}
  <form method="post" action="/admin/bookings" style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
    <p><label>Property address<br><input type="text" name="address" required value="${esc(values.address ?? "")}" placeholder="36 Example Ave, Toronto"></label></p>
    <p><label>When (${esc(c.TZ)})<br><input type="text" name="time" required value="${esc(values.time ?? "")}" placeholder='e.g. "tomorrow 2pm", "sat 1:30pm", "2026-07-08 14:00"'></label></p>
    <p><label>Duration
      <select name="duration">
        ${[15, 30, 45, 60].map((d) => `<option value="${d}" ${d === c.BOOKING_DEFAULT_DURATION_MIN ? "selected" : ""}>${d} minutes</option>`).join("")}
      </select></label></p>
    <p><label>Note to listing agent (optional)<br><input type="text" name="notes" value="${esc(values.notes ?? "")}"></label></p>
    <p><label><input type="checkbox" name="dryRun" value="1"> Dry run — do everything except the final submit</label></p>
    <button class="btn approve" type="submit">Book it</button>
  </form>
  <form method="post" action="/admin/bookings/otp" style="margin:8px 0">
    <label class="muted">REALM asked for a verification code? Paste it here (a waiting booking picks it up within seconds):
      <input type="text" name="code" inputmode="numeric" pattern="[0-9]{4,8}" placeholder="123456" style="width:120px;display:inline-block;margin:0 8px">
    </label>
    <button class="btn neutral" type="submit">Send code</button>
  </form>`;
}

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", app.basicAuth);

  app.get("/", async (_req, reply) => {
    const rows = await db().query.mlsBookings.findMany({
      orderBy: desc(schema.mlsBookings.createdAt),
      limit: 100,
    });
    const table = `<table><tr><th>Property</th><th>Requested time</th><th>Status</th><th>MLS</th></tr>
      ${rows
        .map(
          (b) => `<tr>
          <td><a href="/admin/bookings/${b.id}">${esc(b.address)}</a>${b.tourStop ? ` <span class="pill">tour · stop ${b.tourStop}</span>` : ""}${b.dryRun ? ' <span class="pill">dry run</span>' : ""}</td>
          <td>${fmt(b.requestedStart)} · ${b.durationMin} min</td>
          <td><span class="pill ${b.status}">${esc(b.status)}</span></td>
          <td>${esc(b.mlsNumber ?? "")}</td></tr>`,
        )
        .join("")}
    </table>`;
    reply.type("text/html");
    return layout(
      "MLS bookings (REALM → BrokerBay)",
      bookingForm() + (rows.length ? table : '<p class="muted">No bookings yet. Give an address and a time above.</p>'),
    );
  });

  app.post<{ Body: { address?: string; time?: string; duration?: string; notes?: string; dryRun?: string } }>(
    "/",
    async (req, reply) => {
      const address = (req.body?.address ?? "").trim();
      const time = (req.body?.time ?? "").trim();
      const rerender = (error: string) => {
        reply.type("text/html");
        return layout("MLS bookings (REALM → BrokerBay)", bookingForm({ address, time, notes: req.body?.notes, error }));
      };
      if (!address || !time) return rerender("Address and time are both required.");
      let parsed;
      try {
        parsed = parseRequestedTime(time, { tz: config().TZ });
      } catch (err) {
        if (err instanceof TimeParseError) return rerender(err.message);
        throw err;
      }
      if (parsed.start.getTime() <= Date.now()) return rerender(`That time (${parsed.echo}) is in the past.`);

      const booking = await createBookingRequest({
        address,
        requestedStart: parsed.start,
        durationMin: req.body?.duration ? Number(req.body.duration) : undefined,
        notes: req.body?.notes?.trim() || null,
        source: "dashboard",
        dryRun: req.body?.dryRun === "1" ? true : undefined,
      });
      return reply.redirect(`/admin/bookings/${booking.id}`);
    },
  );

  app.post<{ Body: { code?: string } }>("/otp", async (req, reply) => {
    const code = (req.body?.code ?? "").trim();
    if (/^\d{4,8}$/.test(code)) {
      fs.mkdirSync(path.dirname(otpFilePath()), { recursive: true });
      fs.writeFileSync(otpFilePath(), code, "utf8");
    }
    return reply.redirect("/admin/bookings");
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const b = await db().query.mlsBookings.findFirst({
      where: eq(schema.mlsBookings.id, req.params.id),
    });
    reply.type("text/html");
    if (!b) return layout("Not found", "<p>Booking not found.</p>");

    const shots = listShots(b.id);
    const logHtml = (b.log ?? [])
      .map((e) => `<tr><td class="muted">${esc(new Date(e.t).toLocaleTimeString("en-CA", { timeZone: config().TZ }))}</td><td><strong>${esc(e.step)}</strong></td><td>${esc(e.note ?? "")}</td></tr>`)
      .join("");
    const retryable = ["failed", "needs_attention", "dry_run"].includes(b.status);

    const body = `
      <p><strong>${esc(b.address)}</strong>${b.matchedAddress && b.matchedAddress !== b.address ? ` <span class="muted">(matched: ${esc(b.matchedAddress)})</span>` : ""}</p>
      <p>${fmt(b.requestedStart)} · ${b.durationMin} min ${b.mlsNumber ? `· MLS ${esc(b.mlsNumber)}` : ""} ${b.dryRun ? '· <span class="pill">dry run</span>' : ""}</p>
      <p><span class="pill ${b.status}">${esc(b.status)}</span> <span class="muted">${esc(STATUS_HINTS[b.status] ?? "")}</span></p>
      ${b.attentionReason ? `<p style="color:#b45309">⚠️ ${esc(b.attentionReason)}</p>` : ""}
      ${b.confirmationText ? `<p>BrokerBay said: <em>${esc(b.confirmationText)}</em></p>` : ""}
      ${b.error ? `<pre>${esc(b.error)}</pre>` : ""}
      ${b.notes ? `<p class="muted">Note to listing agent: ${esc(b.notes)}</p>` : ""}
      ${
        retryable
          ? `<form method="post" action="/admin/bookings/${b.id}/retry">
               ${b.submitAttemptedAt ? '<p><label><input type="checkbox" name="checkedBrokerBay" value="1" required> I checked BrokerBay — there is no duplicate showing request</label></p>' : ""}
               <button class="btn neutral" type="submit">Retry ${b.dryRun ? "" : "booking"}${b.dryRun ? " (still dry run — untick on the main form for a real one)" : ""}</button>
             </form>`
          : ""
      }
      <h3>Steps</h3>
      <table>${logHtml || '<tr><td class="muted">Nothing yet.</td></tr>'}</table>
      <h3>Screenshots</h3>
      ${
        shots.length
          ? shots
              .map(
                (f) =>
                  `<p class="muted">${esc(f)}</p><a href="/admin/bookings/${b.id}/shots/${f}"><img src="/admin/bookings/${b.id}/shots/${f}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px"></a>`,
              )
              .join("")
          : '<p class="muted">None captured.</p>'
      }`;
    return layout(`Booking: ${b.address}`, body);
  });

  app.post<{ Params: { id: string }; Body: { checkedBrokerBay?: string } }>(
    "/:id/retry",
    async (req, reply) => {
      const b = await db().query.mlsBookings.findFirst({
        where: eq(schema.mlsBookings.id, req.params.id),
      });
      if (b && ["failed", "needs_attention", "dry_run"].includes(b.status)) {
        // If a submit may already have gone through, the operator must confirm
        // they checked BrokerBay before we clear the guard.
        if (!b.submitAttemptedAt || req.body?.checkedBrokerBay === "1") {
          await retryBooking(b.id);
        }
      }
      return reply.redirect(`/admin/bookings/${req.params.id}`);
    },
  );

  app.get<{ Params: { id: string; file: string } }>("/:id/shots/:file", async (req, reply) => {
    const p = shotPath(req.params.id, req.params.file);
    if (!p) return reply.code(404).send("not found");
    reply.type("image/png");
    return reply.send(fs.createReadStream(p));
  });
}
