import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { enqueue } from "../../jobs/queue.js";
import { ingestInbound, resolveLead } from "../../channels/ingest.js";
import { buildSummary, nurtureDelayDays, scoreSubmission, submissionSchema } from "../../leads/qualify.js";

// Simple per-IP throttle so the public form can't be spammed into the lead DB.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear(); // crude memory cap
  return false;
}

export async function publicLeadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_req, reply) => reply.redirect("/connect"));

  app.get("/connect", async (_req, reply) => {
    reply.type("text/html");
    return formPage();
  });

  app.post<{ Body: Record<string, unknown> }>("/api/connect", async (req, reply) => {
    // Honeypot: real users never see or fill this field.
    if (typeof req.body?.website === "string" && req.body.website.trim() !== "") {
      return reply.send({ ok: true });
    }
    if (rateLimited(req.ip)) {
      return reply.status(429).send({ ok: false, error: "Too many requests. Please try again later." });
    }

    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid submission" });
    }
    const s = parsed.data;
    const score = scoreSubmission(s);
    const summary = buildSummary(s, score);
    const d = db();

    let leadId: string;
    if (s.email) {
      // Email present: ingest on the gmail channel so the existing agent loop
      // can reply (subject to the normal approval mode / training wheels).
      const res = await ingestInbound({
        channel: "gmail",
        externalId: s.email,
        externalMsgId: `webform:${crypto.randomUUID()}`,
        name: s.name,
        email: s.email,
        phone: s.phone ?? null,
        body: summary,
        meta: {
          source: "webform",
          src: s.source ?? null,
          subject:
            s.language === "prs" ? "درخواست ملکی شما — Your real estate inquiry" : "Your real estate inquiry",
        },
      });
      leadId = res.leadId;
    } else {
      // Phone-only: store the lead + timeline entry, but don't schedule an
      // agent turn — there is no channel the agent can reply on. Ray follows
      // up on WhatsApp/phone from the notification email.
      const lead = await resolveLead({
        channel: "webform",
        externalId: `phone:${s.phone}`,
        name: s.name,
        phone: s.phone ?? null,
        body: summary,
      });
      leadId = lead.id;
      await d.insert(schema.messages).values({
        leadId,
        channel: "webform",
        direction: "inbound",
        body: summary,
        externalMsgId: `webform:${crypto.randomUUID()}`,
        meta: { source: "webform", src: s.source ?? null },
      });
      const patch: Partial<typeof schema.leads.$inferInsert> = { updatedAt: new Date() };
      if (!lead.name) patch.name = s.name;
      if (!lead.phone && s.phone) patch.phone = s.phone;
      if (lead.stage === "new") patch.stage = "engaged";
      await d.update(schema.leads).set(patch).where(eq(schema.leads.id, leadId));
    }

    const [submission] = await d
      .insert(schema.leadSubmissions)
      .values({
        leadId,
        intent: s.intent,
        language: s.language,
        score,
        answers: { ...s.answers, ...(s.message ? { message: s.message } : {}) },
        source: s.source ?? null,
      })
      .returning({ id: schema.leadSubmissions.id });

    // Merge the qualification into the lead profile the agent already reads,
    // and book the first nurture check-in so every form lead stays in the
    // follow-up loop even if the agent never schedules one itself.
    const followupAt = new Date(Date.now() + nurtureDelayDays(score) * 24 * 3600_000);
    const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, leadId) });
    if (lead) {
      await d
        .update(schema.leads)
        .set({
          preferences: {
            ...(lead.preferences ?? {}),
            preferred_language: s.language === "prs" ? "Dari" : "English",
            intent: s.intent,
            lead_score: score,
            ...(s.contactMethod ? { preferred_contact: s.contactMethod } : {}),
            ...s.answers,
          },
          followupAt: lead.followupAt ?? followupAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.leads.id, leadId));
    }
    // Same dedupe key as the agent's set_followup tool: only one pending
    // follow-up per lead, whoever schedules it first.
    await enqueue({
      type: "followup",
      payload: {
        leadId,
        reason:
          `Nurture check-in for a ${score.toUpperCase()} ${s.intent} lead from the social lead form. ` +
          `If the lead already replied and the conversation is active, this check-in may be unnecessary — output nothing in that case.`,
      },
      runAt: followupAt,
      dedupeKey: `followup:${leadId}`,
    });

    const c = config();
    await enqueue({
      type: "notify-realtor",
      payload: {
        subject: `New ${score.toUpperCase()} lead from your link: ${s.name} (${s.intent})`,
        body: `${summary}\n\nContact: ${s.phone ?? ""} ${s.email ?? ""}\nOpen: ${c.APP_BASE_URL}/admin/leads/${leadId}`,
      },
      dedupeKey: `notify-submission:${submission!.id}`,
    });

    req.log.info({ leadId, intent: s.intent, score }, "lead form submission");
    return reply.send({ ok: true });
  });
}

/**
 * The public lead-capture page: a single self-contained mobile-first wizard
 * with an English/Dari toggle (Dari renders right-to-left). Shared as the
 * link-in-bio on social media, optionally tagged with ?src=instagram etc.
 */
function formPage(): string {
  const c = config();
  const name = c.REALTOR_NAME;
  const brokerage = c.REALTOR_BROKERAGE;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — Real Estate</title>
<meta name="description" content="Connect directly with ${esc(name)} for help buying, selling, or asking a Greater Toronto Area real estate question. Available in English and Dari.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏡</text></svg>">
<style>
  :root{--brand:#0c5fa8;--brand-dark:#082e55;--navy:#082e55;--bg:#f4f7fa;--card:#ffffff;--ink:#102f50;--muted:#61768d;--line:#d7e0e9}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#fff 0,#f4f7fa 210px);color:var(--ink);margin:0;min-height:100vh}
  .wrap{max-width:560px;margin:0 auto;padding:24px 18px 56px}
  header{display:flex;justify-content:space-between;align-items:center;padding:4px 2px 10px}
  .who{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:21px;color:var(--navy);letter-spacing:-.01em}
  .who small{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-weight:500;color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-top:2px}
  .langs{display:flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--card);box-shadow:0 4px 15px rgba(8,46,85,.06)}
  .langs button{border:none;background:none;padding:7px 15px;font-size:13px;cursor:pointer;color:var(--muted)}
  .langs button.on{background:var(--navy);color:#fff;font-weight:700}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;margin-top:14px;box-shadow:0 18px 55px -35px rgba(8,46,85,.45)}
  h1{font-family:Georgia,"Times New Roman",serif;color:var(--navy);font-size:27px;line-height:1.18;letter-spacing:-.02em;margin:0 0 8px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 14px;line-height:1.6}
  .bar{height:5px;background:#e1e8ef;border-radius:999px;margin:8px 0 24px;overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--navy),var(--brand));border-radius:999px;transition:width .3s}
  .q{font-weight:700;color:var(--navy);font-size:15px;margin:18px 0 11px}
  .opts{display:flex;flex-direction:column;gap:9px}
  .opt{display:block;width:100%;text-align:start;padding:14px 16px;border:1.5px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);font-size:15px;cursor:pointer;transition:border-color .15s,background .15s,transform .15s,box-shadow .15s}
  .opt:hover{border-color:#8eb3d5;background:#f8fbfe;transform:translateY(-1px);box-shadow:0 8px 18px -15px rgba(8,46,85,.7)}
  .opt.sel{border-color:var(--brand);background:#f0f6fb;font-weight:700;box-shadow:inset 3px 0 var(--brand)}
  .opt .em{margin-inline-end:10px}
  input[type=text],input[type=tel],input[type=email],textarea{width:100%;padding:13px 14px;border:1.5px solid var(--line);border-radius:11px;font-size:15px;font-family:inherit;background:var(--card);color:var(--ink)}
  input:focus,textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 4px rgba(12,95,168,.09)}
  label{display:block;color:var(--navy);font-size:13px;font-weight:700;margin:14px 0 6px}
  .row{display:flex;gap:10px;margin-top:20px}
  .btn{flex:1;padding:13px 18px;border:none;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer}
  .next{background:var(--navy);color:#fff;box-shadow:0 8px 22px -14px rgba(8,46,85,.8)}
  .next:hover{background:#0c416f}
  .next:disabled{background:#91a6ba;cursor:not-allowed}
  .back{background:none;border:1.5px solid var(--line);color:var(--muted);flex:0 0 auto;padding:14px 20px}
  .err{color:#dc2626;font-size:14px;margin-top:10px;min-height:18px}
  .fine{color:var(--muted);font-size:12px;margin-top:17px;line-height:1.55}
  .done{text-align:center;padding:24px 0}
  .done .big{font-size:52px}
  html[dir=rtl] .opt{text-align:right}
  @media(max-width:520px){.wrap{padding:16px 14px 44px}.card{padding:20px}h1{font-size:24px}.who{font-size:19px}}
</style></head>
<body><div class="wrap">
<header>
  <div class="who">${esc(name)}<small>${esc(brokerage)}</small></div>
  <div class="langs" role="group" aria-label="Language">
    <button type="button" id="lang-en" onclick="setLang('en')">English</button>
    <button type="button" id="lang-prs" onclick="setLang('prs')">دری</button>
  </div>
</header>
<div class="card">
  <div class="bar"><i id="bar" style="width:25%"></i></div>
  <div id="screen"></div>
  <input type="text" name="website" id="hp" tabindex="-1" autocomplete="off" aria-hidden="true"
    style="position:absolute;width:1px;height:1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);opacity:0">
</div>
</div>
<script>
"use strict";
var T = {
  en: {
    hi: "Hi, I'm ${js(name)} 👋",
    intro: "Thanks for reaching out from my page! Answer a few quick questions and I'll personally get back to you.",
    how: "How can I help you?",
    buy: "I want to buy a home",
    sell: "I want to sell my home",
    general: "I have a general question",
    b_timeline: "When are you hoping to buy?",
    s_timeline: "When would you like to sell?",
    asap: "As soon as possible", m03: "In 0–3 months", m13: "In 1–3 months", m36: "In 3–6 months", m612: "In 6–12 months",
    researching: "Just researching for now",
    curious: "Just curious what my home is worth",
    preapproved: "Are you pre-approved for a mortgage?",
    pa_yes: "Yes, I'm pre-approved", pa_not_yet: "Not yet", pa_help: "I'd like help getting pre-approved", pa_cash: "I'm buying with cash",
    budget: "What's your budget?",
    under_500k: "Under $500K", b500: "$500K – $750K", b750: "$750K – $1M", over_1m: "Over $1M", not_sure: "Not sure yet",
    ptype: "What type of home?",
    condo: "Condo / apartment", townhouse: "Townhouse", detached: "Detached / semi-detached", any: "Anything is fine", other: "Other",
    areas: "Which areas are you interested in? (optional)",
    areas_ph: "e.g. Vaughan, North York, Richmond Hill…",
    s_where: "Where is your property?",
    s_where_ph: "Address or neighbourhood",
    s_ptype: "What type of property is it?",
    s_alsobuy: "Will you also need to buy a new home?",
    yes: "Yes", no: "No", notsure: "Not sure yet",
    g_msg: "What would you like to ask?",
    g_ph: "Type your question here…",
    contact: "How can I reach you?",
    name: "Your name", name_ph: "Full name",
    phone: "Phone / WhatsApp", email: "Email",
    cmethod: "Best way to reach you",
    whatsapp: "WhatsApp", call: "Phone call", em: "Email", telegram: "Telegram",
    need_one: "Please enter at least a phone number or an email.",
    need_name: "Please enter your name.",
    need_msg: "Please type your question.",
    need_where: "Please tell me where the property is.",
    cont: "Continue", back: "Back", send: "Send ✓",
    sending: "Sending…",
    fail: "Something went wrong — please try again.",
    thanks: "Thank you!",
    thanks_sub: "I got your info and will reach out to you soon — usually within a few hours.",
    privacy: "Your information goes only to ${js(name)} and is never shared with anyone else."
  },
  prs: {
    hi: "سلام، من ${js(name)} هستم 👋",
    intro: "تشکر که از صفحهٔ من تماس گرفتید! به چند سوال کوتاه جواب بدهید تا شخصاً با شما تماس بگیرم.",
    how: "چطور می‌توانم کمک‌تان کنم؟",
    buy: "می‌خواهم خانه بخرم",
    sell: "می‌خواهم خانه‌ام را بفروشم",
    general: "یک سوال عمومی دارم",
    b_timeline: "چه زمانی می‌خواهید خانه بخرید؟",
    s_timeline: "چه زمانی می‌خواهید بفروشید؟",
    asap: "هرچه زودتر", m03: "در ۰ تا ۳ ماه", m13: "در ۱ تا ۳ ماه", m36: "در ۳ تا ۶ ماه", m612: "در ۶ تا ۱۲ ماه",
    researching: "فعلاً فقط تحقیق می‌کنم",
    curious: "فقط می‌خواهم بدانم خانه‌ام چقدر ارزش دارد",
    preapproved: "آیا برای وام مسکن (قرضه) پیش‌تأیید شده‌اید؟",
    pa_yes: "بله، پیش‌تأیید شده‌ام", pa_not_yet: "هنوز نه", pa_help: "می‌خواهم برای پیش‌تأیید کمکم کنید", pa_cash: "نقد می‌خرم",
    budget: "بودجهٔ شما چقدر است؟",
    under_500k: "کمتر از ۵۰۰ هزار دالر", b500: "۵۰۰ تا ۷۵۰ هزار دالر", b750: "۷۵۰ هزار تا ۱ میلیون دالر", over_1m: "بیشتر از ۱ میلیون دالر", not_sure: "هنوز مطمئن نیستم",
    ptype: "چه نوع خانه‌ای می‌خواهید؟",
    condo: "آپارتمان (کاندو)", townhouse: "تاون‌هاوس", detached: "خانهٔ مستقل / نیمه‌مستقل", any: "فرقی نمی‌کند", other: "دیگر",
    areas: "به کدام مناطق علاقه دارید؟ (اختیاری)",
    areas_ph: "مثلاً وان، نارت یارک، ریچموند هیل…",
    s_where: "ملک شما در کجا موقعیت دارد؟",
    s_where_ph: "آدرس یا منطقه",
    s_ptype: "چه نوع ملکی است؟",
    s_alsobuy: "آیا بعد از فروش، خانهٔ جدید هم می‌خرید؟",
    yes: "بله", no: "نه", notsure: "هنوز مطمئن نیستم",
    g_msg: "چه سوالی دارید؟",
    g_ph: "سوال‌تان را اینجا بنویسید…",
    contact: "چطور با شما تماس بگیرم؟",
    name: "نام شما", name_ph: "نام مکمل",
    phone: "شماره تلفن / واتساپ", email: "ایمیل",
    cmethod: "بهترین راه تماس با شما",
    whatsapp: "واتساپ", call: "تماس تلفنی", em: "ایمیل", telegram: "تلگرام",
    need_one: "لطفاً حداقل شماره تلفن یا ایمیل خود را بنویسید.",
    need_name: "لطفاً نام خود را بنویسید.",
    need_msg: "لطفاً سوال خود را بنویسید.",
    need_where: "لطفاً بگویید ملک در کجا موقعیت دارد.",
    cont: "ادامه", back: "بازگشت", send: "ارسال ✓",
    sending: "در حال ارسال…",
    fail: "مشکلی پیش آمد — لطفاً دوباره کوشش کنید.",
    thanks: "تشکر!",
    thanks_sub: "معلومات شما رسید و به زودی — معمولاً در ظرف چند ساعت — با شما تماس می‌گیرم.",
    privacy: "معلومات شما فقط به ${js(name)} می‌رسد و با هیچ کس دیگری شریک نمی‌شود."
  }
};

var params = new URLSearchParams(location.search);
var state = {
  lang: params.get("lang") === "prs" ? "prs" : "en",
  step: 0, intent: null, answers: {}, message: "",
  name: "", phone: "", email: "", contactMethod: null,
  source: (params.get("src") || "").slice(0, 100)
};
function t(k){ return T[state.lang][k] || k; }

function setLang(l){
  captureContact();
  state.lang = l;
  document.documentElement.lang = l === "prs" ? "fa-AF" : "en";
  document.documentElement.dir = l === "prs" ? "rtl" : "ltr";
  document.getElementById("lang-en").className = l === "en" ? "on" : "";
  document.getElementById("lang-prs").className = l === "prs" ? "on" : "";
  render();
}

// Question definitions per intent. Each: key, title-key, options [value, label-key].
var FLOWS = {
  buying: [
    { key: "timeline", q: "b_timeline", opts: [["asap","asap"],["0_3","m03"],["3_6","m36"],["6_12","m612"],["researching","researching"]] },
    { key: "preapproved", q: "preapproved", opts: [["yes","pa_yes"],["not_yet","pa_not_yet"],["need_help","pa_help"],["cash","pa_cash"]] },
    { key: "budget", q: "budget", opts: [["under_500k","under_500k"],["500_750k","b500"],["750k_1m","b750"],["over_1m","over_1m"],["not_sure","not_sure"]] },
    { key: "propertyType", q: "ptype", opts: [["condo","condo"],["townhouse","townhouse"],["detached","detached"],["any","any"]] },
    { key: "areas", q: "areas", text: true, ph: "areas_ph", optional: true }
  ],
  selling: [
    { key: "address", q: "s_where", text: true, ph: "s_where_ph", err: "need_where" },
    { key: "propertyType", q: "s_ptype", opts: [["condo","condo"],["townhouse","townhouse"],["detached","detached"],["other","other"]] },
    { key: "timeline", q: "s_timeline", opts: [["asap","asap"],["1_3","m13"],["3_6","m36"],["curious","curious"]] },
    { key: "alsoBuying", q: "s_alsobuy", opts: [["yes","yes"],["no","no"],["not_sure","notsure"]] }
  ],
  general: []
};

function totalSteps(){
  if (!state.intent) return 4;
  return 1 + FLOWS[state.intent].length + (state.intent === "general" ? 1 : 0) + 1;
}

function render(){
  var el = document.getElementById("screen");
  var pct = Math.min(100, Math.round(((state.step + 1) / totalSteps()) * 100));
  document.getElementById("bar").style.width = pct + "%";

  if (state.step === 0) { el.innerHTML = introScreen(); return; }
  var flow = FLOWS[state.intent];
  var qi = state.step - 1;
  if (state.intent === "general" && qi === 0) { el.innerHTML = messageScreen(); return; }
  if (qi < flow.length) { el.innerHTML = questionScreen(flow[qi]); focusText(); return; }
  el.innerHTML = contactScreen();
}

function introScreen(){
  return '<h1>' + t("hi") + '</h1><p class="sub">' + t("intro") + '</p>'
    + '<div class="q">' + t("how") + '</div><div class="opts">'
    + opt("pick(\\'buying\\')", "🏡", t("buy"), state.intent === "buying")
    + opt("pick(\\'selling\\')", "💰", t("sell"), state.intent === "selling")
    + opt("pick(\\'general\\')", "💬", t("general"), state.intent === "general")
    + '</div><p class="fine">' + t("privacy") + '</p>';
}

function opt(onclick, emoji, label, sel){
  return '<button type="button" class="opt' + (sel ? " sel" : "") + '" onclick="' + onclick + '">'
    + (emoji ? '<span class="em">' + emoji + '</span>' : '') + label + '</button>';
}

function pick(intent){
  if (state.intent !== intent) { state.answers = {}; state.message = ""; }
  state.intent = intent; state.step = 1; render();
}

function questionScreen(qd){
  var html = '<div class="q">' + t(qd.q) + '</div>';
  if (qd.text) {
    html += '<input type="text" id="txt" maxlength="300" placeholder="' + t(qd.ph) + '" value="' + escAttr(state.answers[qd.key] || "") + '">';
    html += '<div class="err" id="err"></div>';
  } else {
    html += '<div class="opts">' + qd.opts.map(function(o){
      return opt("choose(\\'" + qd.key + "\\',\\'" + o[0] + "\\')", "", t(o[1]), state.answers[qd.key] === o[0]);
    }).join("") + '</div>';
  }
  html += nav(qd.text ? '<button type="button" class="btn next" onclick="saveText()">' + t("cont") + '</button>' : "");
  return html;
}

function messageScreen(){
  return '<div class="q">' + t("g_msg") + '</div>'
    + '<textarea id="txt" rows="5" maxlength="5000" placeholder="' + t("g_ph") + '">' + escHtml(state.message) + '</textarea>'
    + '<div class="err" id="err"></div>'
    + nav('<button type="button" class="btn next" onclick="saveMessage()">' + t("cont") + '</button>');
}

function contactScreen(){
  return '<div class="q">' + t("contact") + '</div>'
    + '<label>' + t("name") + '</label><input type="text" id="c-name" maxlength="200" placeholder="' + t("name_ph") + '" value="' + escAttr(state.name) + '">'
    + '<label>' + t("phone") + '</label><input type="tel" id="c-phone" maxlength="40" inputmode="tel" dir="ltr" placeholder="+1 …" value="' + escAttr(state.phone) + '">'
    + '<label>' + t("email") + '</label><input type="email" id="c-email" maxlength="320" dir="ltr" placeholder="name@example.com" value="' + escAttr(state.email) + '">'
    + '<label>' + t("cmethod") + '</label><div class="opts">'
    + [["whatsapp","whatsapp"],["call","call"],["email","em"],["telegram","telegram"]].map(function(o){
        return opt("method(\\'" + o[0] + "\\')", "", t(o[1]), state.contactMethod === o[0]);
      }).join("")
    + '</div><div class="err" id="err"></div>'
    + nav('<button type="button" class="btn next" id="sendbtn" onclick="submit()">' + t("send") + '</button>');
}

function nav(primary){
  return '<div class="row"><button type="button" class="btn back" onclick="goBack()">' + t("back") + '</button>' + (primary || "") + '</div>';
}

function focusText(){ var x = document.getElementById("txt"); if (x) x.focus(); }
function goBack(){ captureContact(); state.step = Math.max(0, state.step - 1); render(); }
function choose(key, value){ state.answers[key] = value; state.step++; render(); }
function method(m){ captureContact(); state.contactMethod = m; render(); }

// Selecting a contact-method chip re-renders the screen, so save the typed
// fields first or they would be wiped.
function captureContact(){
  var n = document.getElementById("c-name"), p = document.getElementById("c-phone"), e = document.getElementById("c-email");
  if (n) state.name = n.value;
  if (p) state.phone = p.value;
  if (e) state.email = e.value;
}

function saveText(){
  var flow = FLOWS[state.intent], qd = flow[state.step - 1];
  var v = document.getElementById("txt").value.trim();
  if (!v && !qd.optional) { document.getElementById("err").textContent = t(qd.err || "need_name"); return; }
  if (v) state.answers[qd.key] = v; else delete state.answers[qd.key];
  state.step++; render();
}

function saveMessage(){
  var v = document.getElementById("txt").value.trim();
  if (!v) { document.getElementById("err").textContent = t("need_msg"); return; }
  state.message = v; state.step++; render();
}

function submit(){
  state.name = document.getElementById("c-name").value.trim();
  state.phone = document.getElementById("c-phone").value.trim();
  state.email = document.getElementById("c-email").value.trim();
  var err = document.getElementById("err");
  if (!state.name) { err.textContent = t("need_name"); return; }
  if (!state.phone && !state.email) { err.textContent = t("need_one"); return; }
  var btn = document.getElementById("sendbtn");
  btn.disabled = true; btn.textContent = t("sending");
  fetch("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: state.intent, language: state.lang, name: state.name,
      phone: state.phone || "", email: state.email || "",
      contactMethod: state.contactMethod || undefined,
      answers: state.answers, message: state.message || undefined,
      source: state.source || undefined,
      website: document.getElementById("hp").value
    })
  }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok && j.ok, j: j }; }); })
    .then(function(res){
      if (res.ok) {
        document.getElementById("bar").style.width = "100%";
        document.getElementById("screen").innerHTML =
          '<div class="done"><div class="big">🎉</div><h1>' + t("thanks") + '</h1>'
          + '<p class="sub">' + t("thanks_sub") + '</p>'
          + '<p class="fine">' + t("privacy") + '</p></div>';
      } else {
        btn.disabled = false; btn.textContent = t("send");
        err.textContent = (res.j && res.j.error) || t("fail");
      }
    })
    .catch(function(){ btn.disabled = false; btn.textContent = t("send"); err.textContent = t("fail"); });
}

function escHtml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function escAttr(s){ return escHtml(s).replace(/"/g,"&quot;"); }

setLang(state.lang);
</script>
</body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape for embedding inside a single-quoted/double-quoted JS string literal. */
function js(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/</g, "\\u003c");
}
