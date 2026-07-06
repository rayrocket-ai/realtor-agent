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

  const d = db();
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

  console.log("\n== 7. Fresh offer for HTTP approval test ==");
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

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
