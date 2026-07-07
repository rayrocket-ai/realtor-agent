/**
 * Live functional audit. Runs against the local Postgres with a scripted
 * Anthropic client that emits real tool_use blocks, so every tool handler,
 * the job queue, and the offer pipeline run for real.
 */
import { eq, desc, and, sql } from "drizzle-orm";
import { db, schema, closeDb, pgPool } from "../db/client.js";
import { ingestInbound } from "../channels/ingest.js";
import { runAgentTurn, setAnthropicClient } from "../agent/loop.js";
import { tick } from "../jobs/worker.js";
import { enqueue } from "../jobs/queue.js";
import { showingReminderHandler } from "../jobs/handlers/showing-reminder.js";
import { handleOfferReply } from "../offers/approval.js";
import {
  setApprovalMode,
  approvePendingMessage,
  rejectPendingMessage,
  handleDraftReply,
  msgShortId,
} from "../approvals/messages.js";
import { setMapsClient } from "../channels/maps.js";
import { parseBrokerBayEmail } from "../channels/brokerbay/parse.js";
import { ingestBrokerBayEvent } from "../feedback/engine.js";
import { feedbackRequestHandler } from "../jobs/handlers/feedback.js";
import { distillLessonsHandler } from "../jobs/handlers/distill-lessons.js";
import { ensureRecurringJobs } from "../jobs/recurring.js";
import type Anthropic from "@anthropic-ai/sdk";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

function scripted(responses: Array<Anthropic.ContentBlock[]>): void {
  let i = 0;
  setAnthropicClient({
    messages: {
      async create() {
        const content = responses[Math.min(i, responses.length - 1)]!;
        i++;
        const hasTool = content.some((b) => b.type === "tool_use");
        return {
          id: `msg_${i}`, type: "message", role: "assistant", model: "scripted",
          content, stop_reason: hasTool ? "tool_use" : "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 } as never,
        } as Anthropic.Message;
      },
    },
  });
}

const text = (t: string): Anthropic.ContentBlock => ({ type: "text", text: t, citations: null }) as never;
const tool = (id: string, name: string, input: object): Anthropic.ContentBlock =>
  ({ type: "tool_use", id, name, input }) as never;

async function main() {
  // This script TRUNCATES all tables — never run it against production data.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
  if (!isLocal && process.env.AUDIT_ALLOW_TRUNCATE !== "1") {
    console.error(
      "Refusing to run: DATABASE_URL is not localhost and this audit wipes all data.\n" +
        "Point DATABASE_URL at a throwaway local database (or set AUDIT_ALLOW_TRUNCATE=1 if you really mean it).",
    );
    process.exit(1);
  }

  // Legacy sections assume replies send immediately; approval mode is exercised in section 11.
  process.env.APPROVAL_MODE = process.env.APPROVAL_MODE ?? "off";
  const d = db();
  {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    await migrate(d, { migrationsFolder: path.resolve(here, "..", "..", "drizzle") });
  }
  // Clean slate for repeatable runs.
  await pgPool().query(
    `TRUNCATE leads, channel_identities, messages, showings, offers, jobs, agent_runs RESTART IDENTITY CASCADE`,
  );

  console.log("\n== 1. Ingestion & debounce ==");
  const r1 = await ingestInbound({
    channel: "whatsapp", externalId: "wa-audit-1", threadRef: "conv-1",
    externalMsgId: "wa:m1", name: "Maya Chen", phone: "+14165550001",
    body: "Hi! I want to make an offer on 45 Elm Ave. We saw it yesterday.",
  });
  const r1dup = await ingestInbound({
    channel: "whatsapp", externalId: "wa-audit-1", externalMsgId: "wa:m1",
    body: "duplicate delivery of same message",
  });
  const r2 = await ingestInbound({
    channel: "whatsapp", externalId: "wa-audit-1", externalMsgId: "wa:m2",
    body: "Budget is 900k, we're pre-approved. Offer 875k, 40k deposit, close Sept 15, financing condition 5 days. Irrevocable tomorrow 11:59pm. Listing agent is lisa@listings.ca",
  });
  check("same lead across messages", r1.leadId === r2.leadId);
  check("duplicate externalMsgId deduped", r1dup.stored === false);
  const pendingTurns = await pgPool().query(
    `SELECT count(*) FROM jobs WHERE type='agent-turn' AND status='pending'`,
  );
  check("rapid messages debounced into ONE agent-turn job", pendingTurns.rows[0].count === "1", `got ${pendingTurns.rows[0].count}`);

  // Same person emails in → merged by... (no email on wa lead) — verify email identity creates link when phone matches
  const r3 = await ingestInbound({
    channel: "gmail", externalId: "maya@buyers.ca", externalMsgId: "gm:m1",
    name: "Maya Chen", email: "maya@buyers.ca", phone: "+14165550001",
    body: "Following up from WhatsApp — same Maya.",
    meta: { subject: "Offer on 45 Elm" },
  });
  check("email + whatsapp merged into one lead (by phone)", r3.leadId === r1.leadId, `wa=${r1.leadId} gm=${r3.leadId}`);

  console.log("\n== 2. Agent turn with real tool execution (scripted model) ==");
  scripted([
    [
      text("Saving profile and drafting the offer."),
      tool("t1", "update_lead", { preferences: { budget_max: 900000, pre_approved: true }, stage: "offer_prep" }),
      tool("t2", "draft_offer", {
        property_address: "45 Elm Ave, Toronto", mls_number: "C7654321",
        price: 875000, deposit: 40000,
        irrevocable_date: "2026-07-05 11:59 PM", completion_date: "2026-09-15",
        conditions: ["financing (5 business days)"],
        inclusions: "fridge, stove, washer, dryer",
        listing_agent_email: "lisa@listings.ca",
      }),
    ],
    [text("Great news Maya — I've put the offer together and Ray is reviewing it now. He'll send the formal OREA Form 100 paperwork once he approves. I'll keep you posted!")],
  ]);
  const turn = await runAgentTurn(r1.leadId, "audit");
  check("agent produced a final reply", turn.replied === true);

  const lead = (await d.query.leads.findFirst({ where: eq(schema.leads.id, r1.leadId) }))!;
  check("update_lead persisted preferences", (lead.preferences as any)?.budget_max === 900000);
  check("lead stage moved to offer_prep", lead.stage === "offer_prep");

  const offer = (await d.query.offers.findFirst({ where: eq(schema.offers.leadId, r1.leadId) }))!;
  check("offer row created, pending approval", offer?.status === "pending_approval");
  check("offer has approval token + 72h expiry", Boolean(offer?.approvalTokenHash && offer?.tokenExpiresAt));
  check("recipient captured", offer?.recipientEmail === "lisa@listings.ca");
  check("terms sheet mentions OREA Form 100", offer?.summaryMd.includes("OREA Form 100") === true);

  const notify = await pgPool().query(`SELECT payload FROM jobs WHERE type='notify-realtor' AND status='pending'`);
  check("realtor approval email queued", notify.rows.length >= 1);
  const bodyStr: string = notify.rows[0]?.payload?.body ?? "";
  const tokenMatch = bodyStr.match(/\/approve\/([0-9a-f]{64})/);
  check("approval link with raw token in notification", Boolean(tokenMatch));
  const outbound = await d.query.messages.findFirst({
    where: and(eq(schema.messages.leadId, r1.leadId), eq(schema.messages.direction, "outbound")),
    orderBy: desc(schema.messages.createdAt),
  });
  // Most recent inbound was the gmail follow-up, so the reply goes out on gmail (by design).
  check("reply stored on timeline, most-recent channel (gmail)", outbound?.channel === "gmail");
  const run = await d.query.agentRuns.findFirst({ orderBy: desc(schema.agentRuns.createdAt) });
  check("agent run audit-logged with tool calls", (run?.toolCalls as unknown[])?.length === 2);

  console.log("\n== 3. Reply-to-approve (reject path) ==");
  await handleOfferReply(`Re: [OFFER-${offer.id.replace(/-/g, "").slice(0, 8)}] Approve offer`, "Go to 885k and drop the financing condition\n> quoted text");
  const rejected = (await d.query.offers.findFirst({ where: eq(schema.offers.id, offer.id) }))!;
  check("email reply with feedback → offer rejected", rejected.status === "rejected");
  check("feedback captured", rejected.rejectionFeedback?.includes("885k") === true);
  const note = await d.query.messages.findFirst({
    where: and(eq(schema.messages.leadId, r1.leadId), eq(schema.messages.direction, "internal_note")),
    orderBy: desc(schema.messages.createdAt),
  });
  check("feedback stored as internal note for next agent turn", note?.body.includes("885k") === true);
  const revTurn = await pgPool().query(`SELECT count(*) FROM jobs WHERE type='agent-turn' AND status='pending'`);
  check("revision agent-turn enqueued", Number(revTurn.rows[0].count) >= 1);

  console.log("\n== 4. Human takeover ==");
  await ingestInbound({
    channel: "whatsapp", externalId: "wa-audit-1", externalMsgId: "wa:ray1",
    body: "Maya it's Ray, calling you in 5.", fromRealtor: true,
  });
  const paused = (await d.query.leads.findFirst({ where: eq(schema.leads.id, r1.leadId) }))!;
  check("realtor reply pauses agent ~4h", Boolean(paused.pausedUntil && paused.pausedUntil.getTime() > Date.now() + 3.9 * 3600_000));
  scripted([[text("should not be sent")]]);
  const blocked = await runAgentTurn(r1.leadId, "audit-paused");
  check("agent stays silent while paused", blocked.replied === false, blocked.reason ?? "");
  await d.update(schema.leads).set({ pausedUntil: null }).where(eq(schema.leads.id, r1.leadId));

  console.log("\n== 5. Job worker: retries & failure notification ==");
  await enqueue({ type: "does-not-exist", payload: {} });
  await tick();
  const badJob = await pgPool().query(`SELECT status FROM jobs WHERE type='does-not-exist'`);
  check("unknown job type marked failed (no crash)", badJob.rows[0]?.status === "failed");

  console.log("\n== 6. Showing reminder handler ==");
  const [showing] = await d.insert(schema.showings).values({
    leadId: r1.leadId, propertyAddress: "45 Elm Ave",
    startsAt: new Date(Date.now() + 2 * 3600_000), endsAt: new Date(Date.now() + 2.75 * 3600_000),
    status: "confirmed",
  }).returning();
  await showingReminderHandler({ showingId: showing!.id, label: "2h" });
  const reminder = await d.query.messages.findFirst({
    where: and(eq(schema.messages.leadId, r1.leadId), eq(schema.messages.direction, "outbound")),
    orderBy: desc(schema.messages.createdAt),
  });
  check("2h reminder sent on lead most-recent channel", reminder?.body.includes("45 Elm Ave") === true && reminder?.channel === "gmail");
  await d.update(schema.showings).set({ status: "cancelled" }).where(eq(schema.showings.id, showing!.id));
  const before = await pgPool().query(`SELECT count(*) FROM messages`);
  await showingReminderHandler({ showingId: showing!.id, label: "24h" });
  const after = await pgPool().query(`SELECT count(*) FROM messages`);
  check("cancelled showing sends NO reminder", before.rows[0].count === after.rows[0].count);

  console.log("\n== 7. Escalation to human ==");
  scripted([
    [tool("t-esc", "escalate_to_human", { reason: "Lead asked about mortgage penalty clauses (legal)", urgency: "high" })],
    [text("I've flagged this for Ray — he'll reach out to you personally shortly.")],
  ]);
  await runAgentTurn(r1.leadId, "audit-escalate");
  const escLead = (await d.query.leads.findFirst({ where: eq(schema.leads.id, r1.leadId) }))!;
  check("escalation pauses the lead", escLead.paused === true);
  const escNotify = await pgPool().query(
    `SELECT payload FROM jobs WHERE type='notify-realtor' AND payload->>'subject' LIKE '%Lead needs you%'`,
  );
  check("escalation emails the realtor with urgency + timeline link", escNotify.rows.length === 1 && (escNotify.rows[0].payload.subject as string).startsWith("[HIGH]"));
  await d.update(schema.leads).set({ paused: false }).where(eq(schema.leads.id, r1.leadId));

  console.log("\n== 8. Scheduled follow-up (set_followup -> job -> agent turn) ==");
  scripted([
    [tool("t-fu", "set_followup", { when: new Date(Date.now() + 1000).toISOString(), reason: "Check how the mortgage pre-approval went" })],
    [text("No problem — I'll check in with you soon!")],
  ]);
  await runAgentTurn(r1.leadId, "audit-followup-set");
  const fuJob = await pgPool().query(`SELECT id FROM jobs WHERE type='followup' AND status='pending'`);
  check("set_followup enqueued a followup job", fuJob.rows.length === 1);
  await new Promise((r) => setTimeout(r, 1100));
  scripted([[text("Hi Maya! Just checking in — how did the pre-approval go?")]]);
  await tick(); // worker picks up the due followup job and runs an agent turn
  const fuMsg = await d.query.messages.findFirst({
    where: and(eq(schema.messages.leadId, r1.leadId), eq(schema.messages.direction, "outbound")),
    orderBy: desc(schema.messages.createdAt),
  });
  check("followup fired: agent sent the check-in", fuMsg?.body.includes("pre-approval") === true);
  const fuLead = (await d.query.leads.findFirst({ where: eq(schema.leads.id, r1.leadId) }))!;
  check("followupAt cleared after firing", fuLead.followupAt === null);

  console.log("\n== 9. Cancel showing via agent tool ==");
  const [show2] = await d.insert(schema.showings).values({
    leadId: r1.leadId, propertyAddress: "99 Oak Rd",
    startsAt: new Date(Date.now() + 48 * 3600_000), endsAt: new Date(Date.now() + 49 * 3600_000),
    status: "confirmed", gcalEventId: null, // no Google in the audit env
  }).returning();
  scripted([
    [tool("t-cx", "cancel_showing", { showing_id: show2!.id })],
    [text("Done — I've cancelled Saturday's showing at 99 Oak Rd. Want to pick another time?")],
  ]);
  await runAgentTurn(r1.leadId, "audit-cancel");
  const cxShow = (await d.query.showings.findFirst({ where: eq(schema.showings.id, show2!.id) }))!;
  check("cancel_showing marks showing cancelled", cxShow.status === "cancelled");

  console.log("\n== 10. Fresh offer for HTTP approval test ==");
  scripted([
    [tool("t3", "draft_offer", {
      property_address: "45 Elm Ave, Toronto", price: 885000, deposit: 40000,
      irrevocable_date: "2026-07-06 11:59 PM", completion_date: "2026-09-15",
      conditions: [], listing_agent_email: "lisa@listings.ca",
    })],
    [text("Revised offer at $885k firm is with Ray for approval now.")],
  ]);
  await runAgentTurn(r1.leadId, "audit-revision");
  const notify2 = await pgPool().query(
    `SELECT payload FROM jobs WHERE type='notify-realtor' AND status='pending' ORDER BY created_at DESC LIMIT 1`,
  );
  const token2 = (notify2.rows[0]?.payload?.body as string).match(/\/approve\/([0-9a-f]{64})/)?.[1];
  check("second offer + token issued", Boolean(token2));
  console.log(`TOKEN=${token2}`);

  console.log("\n== 11. Review-before-send approval queue ==");
  await setApprovalMode("all");
  scripted([[text("Hi Maya — quick check-in on the Elm Ave offer status!")]]);
  const qTurn = await runAgentTurn(r1.leadId, "audit-approval");
  check("reply queued instead of sent (training wheels)", qTurn.queued === true);
  let pm = (await d.query.pendingMessages.findFirst({
    where: eq(schema.pendingMessages.status, "pending"),
  }))!;
  check("pending message stored with token", Boolean(pm?.approvalTokenHash));
  const beforeOut = await pgPool().query(`SELECT count(*) FROM messages WHERE direction='outbound'`);
  const appr = await approvePendingMessage(pm.id, "dashboard", "Hey Maya! Ray here — offer news coming today, hang tight.");
  const afterOut = await pgPool().query(`SELECT count(*) FROM messages WHERE direction='outbound'`);
  check("approve-with-edits sends the edited text", appr.ok && Number(afterOut.rows[0].count) === Number(beforeOut.rows[0].count) + 1);
  const fb = await d.query.agentFeedback.findMany();
  check("edit diff captured for learning", fb.length === 1 && fb[0]!.sentText.includes("hang tight"));

  scripted([[text("Draft two — will be rejected.")]]);
  await runAgentTurn(r1.leadId, "audit-approval-2");
  pm = (await d.query.pendingMessages.findFirst({ where: eq(schema.pendingMessages.status, "pending") }))!;
  await rejectPendingMessage(pm.id, "dashboard", "Too casual. Never use exclamation marks with this client.");
  const correctionLesson = await d.query.lessons.findFirst({
    where: eq(schema.lessons.sourceType, "correction"),
  });
  check("rejection feedback becomes an instant lesson", Boolean(correctionLesson));
  const requeued = await pgPool().query(
    `SELECT count(*) FROM jobs WHERE type='agent-turn' AND status='pending'`,
  );
  check("rejected draft re-queues an agent turn", Number(requeued.rows[0].count) >= 1);

  scripted([[text("Draft three — approved via email reply.")]]);
  await runAgentTurn(r1.leadId, "audit-approval-3");
  pm = (await d.query.pendingMessages.findFirst({ where: eq(schema.pendingMessages.status, "pending") }))!;
  await handleDraftReply(`Re: [MSG-${msgShortId(pm.id)}] Draft reply`, "approve\n> quoted stuff");
  const decided = await d.query.pendingMessages.findFirst({ where: eq(schema.pendingMessages.id, pm.id) });
  check("reply-to-approve works ([MSG-...] email)", decided?.status === "approved");
  await setApprovalMode("off");

  console.log("\n== 12. Lesson distiller (self-improvement) ==");
  scripted([[text("- Keep replies under three sentences.\n- Never use exclamation marks.")]]);
  await distillLessonsHandler({});
  const activeLessons = await d.query.lessons.findMany({ where: eq(schema.lessons.active, true) });
  check("edits distilled into lessons", activeLessons.some((l) => l.lesson.toLowerCase().includes("three sentences")));

  console.log("\n== 13. BrokerBay email -> feedback pipeline ==");
  await d.insert(schema.listings).values({ propertyAddress: "77 Birch Blvd, Vaughan, ON", mlsNumber: "N5555555" });
  const bbEmail = `Property: 77 Birch Blvd, Vaughan, ON\nDate & Time: Jul 20, 2026 from 3:00 PM to 3:30 PM\nShowing Agent: Tom Realtor\nEmail: tom@otherbrokerage.ca\nPhone: (905) 555-9999\nLockbox Code: 9876`;
  const outcome1 = await ingestBrokerBayEvent(parseBrokerBayEmail("Showing Confirmed - 77 Birch Blvd", bbEmail));
  check("listing showing recorded from BrokerBay email", outcome1.includes("listing showing recorded"));
  const ls = (await d.query.listingShowings.findMany())[0]!;
  check("showing agent became a contact with a lead record", Boolean(ls.agentLeadId));
  const fbJob = await pgPool().query(`SELECT count(*) FROM jobs WHERE type='feedback-request' AND status='pending'`);
  check("feedback request scheduled ~4h after showing", fbJob.rows[0].count === "1");
  scripted([[text("Hi Tom — thanks for showing 77 Birch! How did your buyers like it?")]]);
  await feedbackRequestHandler({ listingShowingId: ls.id });
  const fbOut = await d.query.messages.findFirst({
    where: and(eq(schema.messages.leadId, ls.agentLeadId!), eq(schema.messages.direction, "outbound")),
  });
  check("feedback ask sent to the showing agent", Boolean(fbOut));
  scripted([
    [tool("t-fb", "record_showing_feedback", { buyer_interest: "fifty_fifty", notes: "Liked layout, budget 1.1M, want to see comparables" })],
    [text("Thanks Tom — I'll check back in a week.")],
  ]);
  await runAgentTurn(ls.agentLeadId!, "audit-feedback");
  const lsAfter = (await d.query.listingShowings.findMany())[0]!;
  check("fifty-fifty feedback recorded", lsAfter.buyerInterest === "fifty_fifty");
  const nextDays = lsAfter.nextFollowupAt
    ? Math.round((lsAfter.nextFollowupAt.getTime() - Date.now()) / 86_400_000)
    : -1;
  check("next follow-up ~1 week out (Ray's cadence)", nextDays >= 6 && nextDays <= 8);

  console.log("\n== 14. Buyer-side BrokerBay enrichment (lockbox onto our showing) ==");
  const [buyShowing] = await d
    .insert(schema.showings)
    .values({
      leadId: r1.leadId,
      propertyAddress: "300 Oak Lane, Toronto",
      startsAt: new Date("2026-07-21T18:00:00Z"),
      endsAt: new Date("2026-07-21T18:30:00Z"),
      status: "confirmed",
    })
    .returning();
  const outcome2 = await ingestBrokerBayEvent(
    parseBrokerBayEmail(
      "Showing Confirmed - 300 Oak Lane",
      "Property: 300 Oak Lane, Toronto\nDate & Time: Jul 21, 2026 from 2:00 PM to 2:30 PM\nLockbox Code: 1122\nShowing Instructions: Alarm code 9. Park in driveway.",
    ),
  );
  const enriched = (await d.query.showings.findFirst({ where: eq(schema.showings.id, buyShowing!.id) }))!;
  check("our showing enriched with lockbox + instructions", outcome2.includes("enriched") && enriched.lockboxCode === "1122" && (enriched.instructions ?? "").includes("Alarm"));

  console.log("\n== 15. Drive-time tour planning ==");
  setMapsClient({
    async driveMatrix(stops) {
      // office + 3 stops; deterministic small matrix
      return stops.map((_, i) => stops.map((_, j) => (i === j ? 0 : 10 + Math.abs(i - j) * 5)));
    },
  });
  scripted([
    [tool("t-tour", "plan_showing_tour", {
      addresses: ["1 First St, Toronto", "2 Second Ave, Toronto", "3 Third Rd, Toronto"],
      window_start: "2026-07-25T14:00:00-04:00",
      duration_min: 30,
    })],
    [text("Here's the plan — three stops starting at 2pm, I'll confirm each one.")],
  ]);
  await runAgentTurn(r1.leadId, "audit-tour");
  const tour = (await d.query.tours.findMany())[0]!;
  check("tour created from plan_showing_tour", Boolean(tour) && tour.status === "proposed");
  const tourRun = await d.query.agentRuns.findFirst({ orderBy: desc(schema.agentRuns.createdAt) });
  const tourToolResult = (tourRun?.toolCalls as Array<{ result?: string }>)[0]?.result ?? "";
  check("plan includes ordered stops with drive times", tourToolResult.includes("drive") && tourToolResult.includes("1."));
  setMapsClient(undefined);

  console.log("\n== 16. Recurring daily jobs ==");
  await ensureRecurringJobs();
  const rec = await pgPool().query(
    `SELECT type FROM jobs WHERE status='pending' AND type IN ('morning-briefing','distill-lessons')`,
  );
  check("morning briefing + lesson distiller scheduled", rec.rows.length === 2);

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
