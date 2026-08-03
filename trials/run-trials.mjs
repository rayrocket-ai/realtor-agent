#!/usr/bin/env node
// Front-desk trial-call simulator ("Ali vs. Ali").
// Simulates full phone conversations between a persona-playing caller model and
// the REAL front-desk system prompt + tool contracts from src/voice/front-desk.ts.
// The listing lookup tool executes against the LIVE production webhook (read-only);
// the CRM capture tool is mocked locally so trials never write to the CRM.
//
// Usage:
//   node trials/run-trials.mjs                 # all personas, 1 trial each
//   node trials/run-trials.mjs --only hot-buyer --repeat 5
//   node trials/run-trials.mjs --concurrency 3
//
// Reads ANTHROPIC_API_KEY + VAPI_WEBHOOK_SECRET + ANTHROPIC_MODEL from ../.env

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = Object.fromEntries(
  (await fs.readFile(path.join(ROOT, ".env"), "utf8"))
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const API_KEY = ENV.ANTHROPIC_API_KEY;
const VAPI_SECRET = ENV.VAPI_WEBHOOK_SECRET;
if (!API_KEY) throw new Error("ANTHROPIC_API_KEY missing from .env");

// ---- Canonical prompt + first message from the production source of truth ----
const frontDeskSrc = await fs.readFile(path.join(ROOT, "src/voice/front-desk.ts"), "utf8");
function readExport(name) {
  const m = frontDeskSrc.match(new RegExp(`export const ${name} = ([\`"])([\\s\\S]*?)\\1;`));
  if (!m) throw new Error(`cannot read ${name}`);
  return m[2];
}
const cliArgs = process.argv.slice(2);
const cliOpt = (k, d) => { const i = cliArgs.indexOf(`--${k}`); return i >= 0 ? cliArgs[i + 1] : d; };
const VARIANT = cliOpt("variant", "baseline");

const SYSTEM_PROMPT_RAW = readExport("FRONT_DESK_SYSTEM_PROMPT");
// Prompt variants are harness-only experiments — production is never modified.
const VARIANTS = {
  baseline: (s) => s,
  // Lesson candidate L-001: callers hang up right after the recap; "near the end"
  // capture loses the lead. Capture as soon as identity is confirmed.
  "capture-early": (s) => s.replace(
    "For every legitimate non-spam call, use capture_front_desk_lead exactly once near the end of the call after confirming the caller's name and best callback number.",
    "For every legitimate non-spam call, call capture_front_desk_lead exactly once AS SOON AS you have confirmed the caller's name and best callback number — even mid-conversation. Do not wait for the end of the call: callers hang up without warning, and an uncaptured lead is a lost lead. After the tool confirms success, recap briefly and close warmly.",
  ),
  // Lesson candidate L-002: callers hang up the moment Ali says "I'll get this to
  // Ray" — the promised tool call never happens. Tool first, words after.
  "capture-then-speak": (s) => VARIANTS["capture-early"](s).replace(
    "Wait for the tool result. Say the details were saved only when the tool confirms success.",
    "Never announce that you will save details, \"get this to Ray\", or \"pass this on\" BEFORE calling the tool — callers hang up on that sentence and the lead is lost. Call capture_front_desk_lead FIRST, in silence, then speak. Wait for the tool result. Say the details were saved only when the tool confirms success.",
  ),
};
if (!VARIANTS[VARIANT]) throw new Error(`unknown variant ${VARIANT}`);
const SYSTEM_PROMPT = VARIANTS[VARIANT](SYSTEM_PROMPT_RAW);
const FIRST_MESSAGE = readExport("FRONT_DESK_FIRST_MESSAGE");
const PROMPT_HASH = crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 12);

// ---- Tool contracts identical to the Vapi assistant ----
const TOOLS = [
  {
    name: "capture_front_desk_lead",
    description:
      "Save the caller's details to Ray's CRM exactly once, near the end of every legitimate non-spam call, after confirming the caller's name and best callback number.",
    input_schema: {
      type: "object",
      properties: {
        caller_name: { type: "string" }, phone: { type: "string" }, email: { type: "string" },
        intent: { type: "string" }, property: { type: "string" }, timeline: { type: "string" },
        pre_approved: { type: "boolean" },
        urgency: { type: "string", enum: ["red", "yellow", "green"] },
        call_category: { type: "string", enum: ["hot_lead", "existing_client", "time_sensitive", "vendor_admin", "personal", "spam", "unknown"] },
        notes: { type: "string" },
      },
      required: ["caller_name", "phone", "intent", "urgency", "call_category"],
    },
  },
  {
    name: "lookup_listing_by_address",
    description:
      "Look up a specific property by street address in the live MLS (TRREB/PropTx) to answer questions about current status, asking price, beds/baths, and remarks. Only current public facts are returned; never invent details.",
    input_schema: {
      type: "object",
      properties: { address: { type: "string" }, city: { type: "string" } },
      required: ["address"],
    },
  },
];

// ---- Persona matrix ----
const PERSONAS = [
  { key: "hot-buyer", expectedUrgency: "red", expectCapture: true,
    desc: "You are Sara Karimi, cell 647-555-0182. You are pre-approved for $900k and want to see 88 Queen Street East in Toronto tomorrow. Highly motivated. Reveal details when asked." },
  { key: "seller-curious", expectedUrgency: "yellow", expectCapture: true,
    desc: "You are Mark Deluca, 905-555-0143, mark.deluca@example.com. You own a townhouse in Maple (Vaughan) and are thinking of selling in the spring. Just researching; open to a callback." },
  { key: "precon-investor", expectedUrgency: "yellow", expectCapture: true,
    desc: "You are Anita Shah, 416-555-0177. You want info on pre-construction condos downtown as an investment, budget ~$700k, timeline 6-12 months." },
  { key: "dari-buyer", expectedUrgency: "yellow", expectCapture: true, lang: "dari",
    desc: "You are Ahmad Rahimi, 647-555-0111, a Dari speaker with limited English. Start the call speaking Dari (Afghan Persian). You want to buy a 3-bedroom house in Richmond Hill, budget $1.2M. Stay in Dari the whole call." },
  { key: "existing-client-deadline", expectedUrgency: "red", expectCapture: true,
    desc: "You are Jennifer Cole, 416-555-0139, an existing client of Ray's. Your deal on 21 Widmer Street closes Friday and your lawyer needs something from Ray today. You are stressed." },
  { key: "vendor-photographer", expectedUrgency: "yellow", expectCapture: true,
    desc: "You are Paul from BrightShot Photography, 289-555-0120, calling to confirm a photo shoot Ray booked and to get gate access details. Professional, brief." },
  { key: "spam-seo", expectedUrgency: "green", expectCapture: false,
    desc: "You are a pushy telemarketer selling SEO services and 'Google listing verification'. You do not take the first hint; push twice, then give up." },
  { key: "info-only-hours", expectedUrgency: null, expectCapture: false,
    desc: "You are a quick caller asking only for the office address and hours. When offered a callback or asked for your name/number, politely decline: 'no thanks, that's all I needed'. Then end the call." },
  { key: "upset-tenant-leak", expectedUrgency: "red", expectCapture: true, noHumor: true,
    desc: "You are Dana Osei, 416-555-0166, tenant in one of Ray's rental listings. Water is leaking through your kitchen ceiling RIGHT NOW. You are upset and want action immediately." },
  { key: "agent-recruit", expectedUrgency: "yellow", expectCapture: true,
    desc: "You are Kevin Bach, 519-555-0131, a realtor at another brokerage curious about joining eXp under Ray. Ask what's in it for you, skeptical but open." },
  { key: "sold-price-fisher", expectedUrgency: "yellow", expectCapture: true,
    desc: "You are curious about what 1 Bloor Street East unit 3115 in Toronto SOLD for. Insist on the sold price. If told that requires Ray, accept a callback. You are Priya Nair, 647-555-0155." },
  { key: "landlord-lease", expectedUrgency: "yellow", expectCapture: true,
    desc: "You are George Tannous, 416-555-0129. You own a 2-bed condo at Yonge & Eglinton you want to lease out. Asking how the process works." },
];

// ---- Model selection (robust to model renames) ----
async function anthropic(pathname, init = {}) {
  const r = await fetch(`https://api.anthropic.com${pathname}`, {
    ...init,
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const models = await anthropic("/v1/models?limit=100");
const ids = models.data.map((m) => m.id);
function pick(envName, ...fragments) {
  if (ENV[envName] && ids.includes(ENV[envName])) return ENV[envName];
  for (const f of fragments) { const hit = ids.find((i) => i.includes(f)); if (hit) return hit; }
  return ids[0];
}
const ASSISTANT_MODEL = pick("ANTHROPIC_MODEL", "sonnet");
const CALLER_MODEL = pick("CALLER_MODEL", "haiku");

async function chat({ model, system, messages, tools, maxTokens, cacheSystem }) {
  const body = {
    model, max_tokens: maxTokens, messages,
    system: cacheSystem
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system,
  };
  if (tools) body.tools = tools;
  const r = await anthropic("/v1/messages", { method: "POST", body: JSON.stringify(body) });
  return r;
}

// ---- Live read-only listing lookup through the production webhook ----
async function liveListingLookup(args, callTag) {
  const res = await fetch("https://ray.87.99.139.222.sslip.io/api/voice/vapi", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-secret": VAPI_SECRET },
    body: JSON.stringify({ message: { type: "tool-calls", call: { id: callTag },
      toolCallList: [{ id: "tc1", type: "function", function: { name: "lookup_listing_by_address", arguments: args } }] } }),
  });
  const data = await res.json();
  return data?.results?.[0]?.result ?? "Lookup unavailable.";
}

// ---- One trial conversation ----
async function runTrial(persona, idx) {
  const callTag = `trial-${persona.key}-${Date.now()}-${idx}`;
  const t0 = Date.now();
  const callerSys = `You are role-playing a REAL phone caller to a real-estate office front desk. ${persona.desc}

Rules: reply ONLY with the caller's spoken words (1-3 short spoken sentences, no stage directions, no quotes). Stay in character. Do not volunteer everything at once; answer what is asked. If the receptionist handles you well, wrap up naturally ("Thanks, goodbye"). End the call after your need is resolved or after ~10 exchanges by saying goodbye. Never break character.`;
  const transcript = [{ role: "assistant", name: "Ali", text: FIRST_MESSAGE }];
  const asstMsgs = [{ role: "assistant", content: FIRST_MESSAGE }];
  const callerMsgs = [{ role: "user", content: `(The phone rings. The receptionist answers: "${FIRST_MESSAGE}")\nReply as the caller.` }];
  const captures = []; const lookups = []; const flags = [];
  let ended = false;

  for (let turn = 0; turn < 14 && !ended; turn++) {
    // CALLER speaks
    let callerRes = await chat({ model: CALLER_MODEL, system: callerSys, messages: callerMsgs, maxTokens: 150 });
    let callerText = callerRes.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (!callerText) {
      // Model occasionally emits an empty turn; retry once, then treat as hangup.
      callerRes = await chat({ model: CALLER_MODEL, system: callerSys, messages: callerMsgs, maxTokens: 150 });
      callerText = callerRes.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (!callerText) { flags.push("caller_hangup_silence"); break; }
    }
    transcript.push({ role: "caller", text: callerText });
    callerMsgs.push({ role: "assistant", content: callerText });
    if (/goodbye|bye\b|that'?s all|have a good/i.test(callerText) && turn > 2) ended = true;

    // ASSISTANT responds (real prompt + tools)
    asstMsgs.push({ role: "user", content: callerText });
    let resp = await chat({ model: ASSISTANT_MODEL, system: SYSTEM_PROMPT, messages: asstMsgs, tools: TOOLS, maxTokens: 300, cacheSystem: true });
    // tool-use loop
    for (let hops = 0; hops < 4 && resp.stop_reason === "tool_use"; hops++) {
      asstMsgs.push({ role: "assistant", content: resp.content });
      const results = [];
      for (const block of resp.content.filter((b) => b.type === "tool_use")) {
        if (block.name === "capture_front_desk_lead") {
          captures.push(block.input);
          results.push({ type: "tool_result", tool_use_id: block.id,
            content: `Saved (lead trial-${captures.length}). The caller details and message were stored for Ray.` });
        } else if (block.name === "lookup_listing_by_address") {
          const out = await liveListingLookup(block.input, callTag);
          lookups.push({ args: block.input, out });
          results.push({ type: "tool_result", tool_use_id: block.id, content: out });
        } else {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
        }
      }
      asstMsgs.push({ role: "user", content: results });
      resp = await chat({ model: ASSISTANT_MODEL, system: SYSTEM_PROMPT, messages: asstMsgs, tools: TOOLS, maxTokens: 300, cacheSystem: true });
    }
    const asstText = resp.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (asstText) {
      transcript.push({ role: "assistant", name: "Ali", text: asstText });
      asstMsgs.push({ role: "assistant", content: asstText });
      callerMsgs.push({ role: "user", content: `(Receptionist says: "${asstText}")\nReply as the caller.` });
    } else {
      callerMsgs.push({ role: "user", content: "(The line is silent for a moment.)\nReply as the caller." });
    }
    if (/goodbye|have a (great|good) (day|one)|take care/i.test(asstText) && turn > 2) ended = true;
  }

  // ---- Deterministic scoring ----
  const asstTurns = transcript.filter((t) => t.role === "assistant").map((t) => t.text);
  const checks = {};
  checks.first_message_exact = asstTurns[0] === FIRST_MESSAGE;
  checks.capture_count = persona.expectCapture ? captures.length === 1 : captures.length === 0;
  if (persona.expectCapture && captures[0]) {
    const c = captures[0];
    checks.capture_args_complete = Boolean(c.caller_name && c.phone && c.intent && c.urgency && c.call_category);
    if (persona.expectedUrgency) checks.urgency_match = c.urgency === persona.expectedUrgency;
  } else if (persona.expectedUrgency && !persona.expectCapture) {
    checks.urgency_match = true; // nothing to classify
  }
  const joined = asstTurns.join(" ");
  const forbidden = [
    { key: "claims_booking", re: /(i'?ve|i have) (booked|scheduled|confirmed) (a |your )?(showing|appointment|viewing|meeting)/i },
    { key: "free_consult_claim", re: /free consultation/i },
    { key: "offers_texting", re: /\b(text|sms) (you|it|that|the)|send you a (text|link|message)\b/i },
    { key: "claims_human", re: /\bi'?m (a )?(human|real person)\b/i },
    { key: "promises_exact_response", re: /(will call you back|get back to you) (within|in) \d+/i },
  ];
  for (const f of forbidden) if (f.re.test(joined)) flags.push(f.key);
  const usedLookup = lookups.length > 0;
  if (!usedLookup && /\$\d{2,3}[,.]?\d{3}/.test(joined)) flags.push("invented_price_without_tool");
  if (persona.lang === "dari") checks.dari_response = asstTurns.some((t) => /[\u0600-\u06FF]/.test(t));
  const words = asstTurns.map((t) => t.split(/\s+/).length);
  checks.spoken_brevity = words.reduce((a, b) => a + b, 0) / words.length <= 45;
  checks.one_question_at_a_time = !asstTurns.some((t) => (t.match(/\?/g) ?? []).length > 2);
  if (persona.key === "info-only-hours") {
    const nags = asstTurns.filter((t) => /your name|phone number|callback number|number (i|to) /i.test(t)).length;
    checks.no_contact_nagging = nags <= 2;
  }
  if (persona.noHumor) checks.no_forced_humor = !/joke|kidding|just kidding|haha/i.test(joined);

  const passed = Object.values(checks).every(Boolean) && flags.length === 0;
  return {
    persona: persona.key, promptHash: PROMPT_HASH, passed, checks, flags,
    captures, lookupCount: lookups.length, turns: transcript.length,
    durationMs: Date.now() - t0, transcript,
  };
}

// ---- Runner ----
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const only = opt("only", null);
const repeat = Number(opt("repeat", 1));
const concurrency = Number(opt("concurrency", 2));
let queue = PERSONAS.filter((p) => !only || p.key === only)
  .flatMap((p) => Array.from({ length: repeat }, (_, i) => ({ p, i })));

console.log(`Variant ${VARIANT} | prompt ${PROMPT_HASH} | assistant=${ASSISTANT_MODEL} caller=${CALLER_MODEL} | ${queue.length} trials`);
const results = [];
async function worker() {
  while (queue.length) {
    const { p, i } = queue.shift();
    process.stdout.write(`▶ ${p.key}#${i + 1} … `);
    try {
      const r = await runTrial(p, i);
      results.push(r);
      console.log(`${r.passed ? "PASS" : "FAIL"} (${r.turns} msgs, captures=${r.captures.length}, lookups=${r.lookupCount})${r.flags.length ? " flags:" + r.flags.join(",") : ""}`);
    } catch (e) {
      results.push({ persona: p.key, passed: false, error: String(e).slice(0, 300), checks: {}, flags: ["harness_error"], captures: [], transcript: [] });
      console.log(`ERROR ${String(e).slice(0, 120)}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

// ---- Aggregate + report ----
await fs.mkdir(path.join(ROOT, "trials/history"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runFile = `trials/history/run-${stamp}.json`;
await fs.writeFile(path.join(ROOT, runFile), JSON.stringify({ stamp, VARIANT, PROMPT_HASH, ASSISTANT_MODEL, results }, null, 2));

const checkNames = [...new Set(results.flatMap((r) => Object.keys(r.checks)))];
const lines = [];
lines.push(`# Front-desk trial report — ${stamp}`);
lines.push(`Variant: \`${VARIANT}\` | prompt hash: \`${PROMPT_HASH}\` | assistant: ${ASSISTANT_MODEL} | trials: ${results.length}`);
lines.push(`Overall pass: ${results.filter((r) => r.passed).length}/${results.length}`);
lines.push("");
lines.push("| Persona | Result | Captures | Failed checks | Flags |");
lines.push("|---|---|---|---|---|");
for (const r of results) {
  const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
  lines.push(`| ${r.persona} | ${r.passed ? "✅" : "❌"} | ${r.captures?.length ?? "-"} | ${failed || "-"} | ${r.flags?.join(", ") || "-"} |`);
}
lines.push("");
lines.push("## Per-check pass rates");
for (const c of checkNames) {
  const relevant = results.filter((r) => c in r.checks);
  lines.push(`- ${c}: ${relevant.filter((r) => r.checks[c]).length}/${relevant.length}`);
}
const lessonCandidates = results.filter((r) => !r.passed).map((r) => {
  const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
  return `- [${r.persona}] failed: ${[...failed, ...(r.flags ?? [])].join(", ")} → candidate lesson (needs 2 consistent examples + Ray review before any prompt change)`;
});
lines.push("");
lines.push("## Lesson candidates (review-gated, NOT auto-applied)");
lines.push(...(lessonCandidates.length ? lessonCandidates : ["- none"]));
await fs.writeFile(path.join(ROOT, "trials/latest-report.md"), lines.join("\n"));
console.log(`\nWrote ${runFile} and trials/latest-report.md — pass ${results.filter((r) => r.passed).length}/${results.length}`);
