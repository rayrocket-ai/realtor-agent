#!/usr/bin/env node
// Real-call QA reviewer ("analyze each call after it is made").
// Polls the Vapi account for calls on the front-desk assistant, reviews every
// new call with deterministic checks + an LLM reviewer, writes a per-call
// review, and promotes repeated failure patterns to review-gated lesson
// candidates (never auto-applied to production).
//
// Cron (server): */15 * * * * flock -n /tmp/review-calls.lock node /opt/realtor-agent/trials/review-calls.mjs
//
// Reads ANTHROPIC_API_KEY + VAPI_PRIVATE_KEY from ../.env

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWS = path.join(ROOT, "trials/reviews");
const ENV = Object.fromEntries(
  (await fs.readFile(path.join(ROOT, ".env"), "utf8"))
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const ANTHROPIC_KEY = ENV.ANTHROPIC_API_KEY;
const VAPI_KEY = ENV.VAPI_PRIVATE_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID ?? "268eae81-f209-43e8-a77e-c4dc5f63e7bf";
if (!ANTHROPIC_KEY || !VAPI_KEY) throw new Error("ANTHROPIC_API_KEY and VAPI_PRIVATE_KEY required in .env");

const ASSISTANT_MODEL = ENV.ANTHROPIC_MODEL || "claude-sonnet-5";
const CANDIDATES_FILE = path.join(REVIEWS, "lesson-candidates-log.md");
const STATE_FILE = path.join(REVIEWS, "reviewed.json");

async function vapi(pathname) {
  const r = await fetch(`https://api.vapi.ai${pathname}`, { headers: { authorization: `Bearer ${VAPI_KEY}` } });
  if (!r.ok) throw new Error(`Vapi ${r.status} ${pathname}`);
  return r.json();
}

// ---------- deterministic checks on the real call ----------
function deterministicReview(call) {
  const msgs = (call.artifact?.messages ?? []).filter((m) => m.role === "assistant" || m.role === "user");
  const asstTurns = msgs.filter((m) => m.role === "assistant").map((m) => m.message ?? "");
  const toolCalls = (call.artifact?.messages ?? []).flatMap((m) => m.toolCalls ?? []);
  const captures = toolCalls.filter((t) => t.function?.name === "capture_front_desk_lead");
  const lookups = toolCalls.filter((t) => t.function?.name === "lookup_listing_by_address");
  const structured = call.analysis?.structuredData ?? {};
  const joined = asstTurns.join(" ");
  const flags = [];
  const checks = {
    first_message_exact: asstTurns[0]?.startsWith("Hi, you've reached Ray Ahmadi's office") ?? false,
    capture_fired: captures.length > 0,
    capture_exactly_once: captures.length <= 1,
    capture_urgency: structured.urgency ?? null,
    capture_category: structured.call_category ?? null,
    spoken_brevity: asstTurns.length ? asstTurns.reduce((a, t) => a + t.split(/\s+/).length, 0) / asstTurns.length <= 45 : true,
    one_question_at_a_time: !asstTurns.some((t) => (t.match(/\?/g) ?? []).length > 2),
  };
  const forbidden = [
    ["claims_booking", /(i'?ve|i have) (booked|scheduled|confirmed) (a |your )?(showing|appointment|viewing|meeting)/i],
    ["free_consult_claim", /free consultation/i],
    ["offers_texting", /\b(text|sms) (you|it|that|the)|send you a (text|link|message)\b/i],
    ["claims_human", /\bi'?m (a )?(human|real person)\b/i],
    ["invented_price", lookups.length === 0 && /\$\d{2,3}[,.]?\d{3}/.test(joined) ? /./ : null],
  ];
  for (const [k, re] of forbidden) if (re && re.test(joined)) flags.push(k);
  return { checks, flags, captures: captures.length, lookups: lookups.length,
    turns: msgs.length, durationSec: call.endedAt && call.startedAt ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : null };
}

// ---------- LLM reviewer ----------
async function llmReview(call, det) {
  const transcript = call.artifact?.transcript
    ?? (call.artifact?.messages ?? []).map((m) => `${m.role}: ${m.message ?? ""}`).join("\n");
  const sys = `You are a call-QA reviewer for "Ali", the AI front desk of realtor Ray Ahmadi (eXp Realty). Doctrine: capture every legitimate lead's name+callback+intent via the capture tool AS SOON AS identity is confirmed; one question at a time; short spoken sentences; never invent listing facts/prices; never claim bookings/saves that didn't happen; no texting offers; distinguish asking vs sold price; respect refusals; spam gets no capture. Review the call and output STRICT JSON only:
{"verdict":"good|mixed|failed","one_line":"...","what_went_well":["..."],"what_failed":["..."],"lead_lost_at":"turn description or null","capture_behavior":"correct|missed|late|overcaptured","suggested_improvement":"one concrete prompt/behavior change or null","severity":"low|medium|high"}`;
  const user = `Call metadata: ${JSON.stringify({ durationSec: det.durationSec, captures: det.captures, lookups: det.lookups, checks: det.checks, flags: det.flags, structuredData: call.analysis?.structuredData ?? {}, successEvaluation: call.analysis?.successEvaluation })}\n\nTranscript:\n${String(transcript).slice(0, 12000)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ASSISTANT_MODEL, max_tokens: 700, system: sys, messages: [{ role: "user", content: user }] }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const text = body.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("reviewer did not return JSON");
  return JSON.parse(match[0]);
}

// ---------- main ----------
await fs.mkdir(REVIEWS, { recursive: true });
const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8").catch(() => "{}"));
const list = await vapi(`/call?assistantId=${ASSISTANT_ID}&limit=30`);
const calls = (Array.isArray(list) ? list : list.results ?? []).filter((c) => c.status === "ended");
const fresh = calls.filter((c) => !state[c.id] && c.startedAt);
console.log(`${calls.length} ended calls, ${fresh.length} new to review`);

const newReviews = [];
for (const stub of fresh) {
  const call = await vapi(`/call/${stub.id}`);
  const det = deterministicReview(call);
  let review = null, err = null;
  try { review = await llmReview(call, det); } catch (e) { err = String(e).slice(0, 200); }
  const rec = { id: call.id, at: call.startedAt, det, review, error: err };
  newReviews.push(rec);
  state[call.id] = { at: call.startedAt, verdict: review?.verdict ?? "error" };

  const md = [
    `# Call review — ${call.id}`, ``,
    `- When: ${call.startedAt} (${det.durationSec ?? "?"}s, ${det.turns} turns)`,
    `- Caller: ${call.customer?.number ?? "unknown"}`,
    `- Verdict: **${review?.verdict ?? "review-error"}** — ${review?.one_line ?? err ?? ""}`,
    `- Capture: ${det.captures} call(s), behavior: ${review?.capture_behavior ?? "?"}; urgency: ${det.checks.capture_urgency ?? "n/a"}; category: ${det.checks.capture_category ?? "n/a"}`,
    `- Deterministic: ${Object.entries(det.checks).filter(([, v]) => v === false).map(([k]) => k).join(", ") || "all pass"}${det.flags.length ? ` | flags: ${det.flags.join(", ")}` : ""}`,
    `- Went well: ${(review?.what_went_well ?? []).join("; ") || "-"}`,
    `- Failed: ${(review?.what_failed ?? []).join("; ") || "-"}`,
    review?.lead_lost_at ? `- Lead lost at: ${review.lead_lost_at}` : null,
    review?.suggested_improvement ? `- Suggested improvement (review-gated): ${review.suggested_improvement} [severity: ${review.severity}]` : null,
    ``,
  ].filter((l) => l !== null).join("\n");
  await fs.writeFile(path.join(REVIEWS, `${call.id}.md`), md);
  console.log(`${call.id.slice(0, 8)} ${review?.verdict ?? "ERR"} | capture=${review?.capture_behavior ?? "-"} | ${review?.one_line ?? err}`);
}
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
await fs.appendFile(path.join(REVIEWS, "index.jsonl"), newReviews.map((r) => JSON.stringify(r)).join("\n") + (newReviews.length ? "\n" : ""));

// ---------- pattern promotion: 2+ consistent failures -> lesson candidate ----------
if (newReviews.length) {
  const recent = Object.entries(state).slice(-20).map(([id]) => id);
  const idx = (await fs.readFile(path.join(REVIEWS, "index.jsonl"), "utf8")).trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pool = idx.filter((r) => recent.includes(r.id) && r.review);
  const counts = {};
  for (const r of pool) {
    const key = `${r.review.capture_behavior}|${(r.review.what_failed ?? []).slice(0, 1).join("")}`;
    if (r.review.capture_behavior === "missed" || r.review.capture_behavior === "overcaptured" || r.review.verdict === "failed") {
      counts[key] = counts[key] ?? { n: 0, example: r };
      counts[key].n += 1;
    }
  }
  const existing = await fs.readFile(CANDIDATES_FILE, "utf8").catch(() => "# Auto-promoted lesson candidates (review-gated)\n");
  let additions = "";
  for (const [key, { n, example }] of Object.entries(counts)) {
    if (n >= 2 && !existing.includes(key)) {
      additions += `\n## ${new Date().toISOString().slice(0, 10)} — pattern "${key}" seen ${n}x\n- Example call: ${example.id} (${example.at})\n- Failed: ${(example.review.what_failed ?? []).join("; ")}\n- Suggested improvement (needs Ray review): ${example.review.suggested_improvement ?? "n/a"}\n`;
    }
  }
  if (additions) { await fs.writeFile(CANDIDATES_FILE, existing + additions); console.log("lesson candidates updated"); }
}
