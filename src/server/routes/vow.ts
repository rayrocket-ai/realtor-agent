import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { sendEmail } from "../../channels/gmail/send.js";
import { searchListings } from "../../listings/reso.js";

const scrypt = promisify(crypto.scrypt);
const TERMS_VERSION = "2026-07-08";
const SESSION_COOKIE = "vow_session";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

type Form = Record<string, string | undefined>;

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title: string, body: string): string {
  const c = config();
  const contact = c.REALTOR_PHONE || c.REALTOR_EMAIL || c.GMAIL_ADDRESS;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} — Ray Ahmadi Homes</title>
<style>
:root{--ink:#172033;--muted:#5c667a;--blue:#164c8c;--gold:#bf8a2f;--paper:#f7f5f0;--line:#dde2ea}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{background:#fff;border-bottom:1px solid var(--line)}.wrap{max-width:1080px;margin:auto;padding:0 24px}.bar{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.brand{font-size:21px;font-weight:800;color:var(--ink);text-decoration:none}.brand span{color:var(--gold)}nav a{color:var(--ink);text-decoration:none;margin-left:20px;font-weight:650}
main{min-height:65vh}.hero{padding:76px 0 58px;background:linear-gradient(135deg,#eef3fa,#f7f5f0)}.hero h1{font-size:clamp(38px,7vw,68px);line-height:1.02;max-width:800px;margin:0 0 22px}.hero p{font-size:20px;color:var(--muted);max-width:680px}
.section{padding:48px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:0 8px 28px #1720330a}
.btn{display:inline-block;border:0;border-radius:10px;background:var(--blue);color:#fff;padding:12px 18px;font-weight:750;text-decoration:none;cursor:pointer}.btn.alt{background:#fff;color:var(--blue);border:1px solid var(--blue);margin-left:8px}
form{max-width:620px}.field{margin:0 0 18px}.field label{display:block;font-weight:700;margin-bottom:6px}.field input{width:100%;padding:12px;border:1px solid #bac3d1;border-radius:8px;font:inherit}.check{display:flex;gap:10px;align-items:flex-start;margin:16px 0}.check input{margin-top:5px}.notice{padding:14px 16px;border-radius:9px;background:#e9f2ff;margin:16px 0}.error{background:#feeceb;color:#8f201c}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line)}footer{background:#101827;color:#e8edf5;padding:34px 0}footer a{color:#fff}
.calc-page{background:#f2f4f7;padding:52px 0 70px}.calc-head{text-align:center;max-width:720px;margin:0 auto 28px}.calc-head h1{font-size:clamp(34px,5vw,48px);line-height:1.08;margin:0 0 12px}.calc-head p{color:var(--muted);font-size:17px;margin:0}.calc-card{max-width:720px;margin:0 auto 20px;background:#fff;border:1px solid #e4e8ef;border-radius:16px;padding:24px;box-shadow:0 10px 34px #17203310}.calc-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(240px,260px);gap:24px;align-items:center;padding:10px 0}.calc-label{font-weight:750}.calc-label small{display:block;color:var(--muted);font-weight:450}.calc-input{position:relative}.calc-input input,.calc-input select{width:100%;height:48px;border:1px solid #d7dde7;border-radius:11px;background:#fff;padding:0 42px 0 15px;font:inherit;color:var(--ink);outline:none}.calc-input input:focus,.calc-input select:focus{border-color:var(--blue);box-shadow:0 0 0 3px #164c8c18}.calc-unit{position:absolute;right:15px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}.calc-result{text-align:center}.calc-total{font-size:clamp(38px,7vw,54px);line-height:1;font-weight:850;margin:10px 0}.calc-caption{color:var(--muted);margin:0 0 22px}.calc-line{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--line);text-align:left}.calc-line:last-child{border-bottom:0;font-weight:800}.calc-disclaimer{font-size:13px;color:var(--muted);text-align:center;margin:20px auto 0;max-width:680px}.calc-cta{display:flex;justify-content:center;gap:10px;margin-top:24px;flex-wrap:wrap}
@media(max-width:650px){nav{display:none}.hero{padding:52px 0}.btn.alt{margin:8px 0 0}.calc-page{padding:34px 0 52px}.calc-card{padding:18px}.calc-row{grid-template-columns:1fr;gap:7px;padding:9px 0}.calc-input input,.calc-input select{height:50px}}
</style></head><body>
<header><div class="wrap bar"><a class="brand" href="/">Ray Ahmadi <span>Homes</span></a><nav><a href="/connect">Mortgage Calculator</a><a href="/search">Search</a><a href="/register">Register</a><a href="/login">Sign in</a><a href="/privacy">Privacy</a></nav></div></header>
<main>${body}</main>
<footer><div class="wrap"><strong>Ray Ahmadi, REALTOR® — ${esc(c.REALTOR_BROKERAGE)}</strong><br>Questions about a property? <a href="mailto:${esc(c.REALTOR_EMAIL || c.GMAIL_ADDRESS)}">${esc(c.REALTOR_EMAIL || c.GMAIL_ADDRESS)}</a>${c.REALTOR_PHONE ? ` · <a href="tel:${esc(c.REALTOR_PHONE)}">${esc(c.REALTOR_PHONE)}</a>` : ""}<p>MLS® data is proprietary to the applicable real estate board and PropTx. Unauthorized copying, scraping, data mining, redistribution, or AI ingestion is prohibited.</p><small>Contact: ${esc(contact)} · <a href="/terms">Terms of Use</a> · <a href="/privacy">Privacy Policy</a></small></div></footer>
</body></html>`;
}

function section(content: string): string {
  return `<section class="section"><div class="wrap">${content}</div></section>`;
}

function tokenHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function passwordHash(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function audit(req: FastifyRequest, action: string, consumerId?: string, meta: Record<string, unknown> = {}) {
  await db().insert(schema.vowAuditLog).values({
    consumerId: consumerId || null,
    action,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 500),
    meta,
  });
}

async function consumerFor(req: FastifyRequest) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await db().query.vowSessions.findFirst({
    where: and(eq(schema.vowSessions.tokenHash, tokenHash(token)), gt(schema.vowSessions.expiresAt, new Date())),
  });
  if (!session) return null;
  return (await db().query.vowConsumers.findFirst({ where: eq(schema.vowConsumers.id, session.consumerId) })) ?? null;
}

function setSession(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: SESSION_MS / 1000,
  });
}

export async function vowRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return page("Toronto real estate search", `<section class="hero"><div class="wrap"><p class="muted">PRIVATE, REALTOR®-SUPPORTED PROPERTY SEARCH</p><h1>Find the right home with a human in your corner.</h1><p>Secure access to Toronto-area property information, saved searches, showing requests, and knowledgeable guidance from Ray Ahmadi at eXp Realty.</p><p><a class="btn" href="/register">Request secure access</a><a class="btn alt" href="/login">Sign in</a></p></div></section>${section(`<div class="grid"><div class="card"><h2>Current information</h2><p>Search licensed listing information once your account and email are verified.</p></div><div class="card"><h2>Private and accountable</h2><p>Every account is unique, password protected, and monitored to protect MLS® information.</p></div><div class="card"><h2>Local expertise</h2><p>Ask questions, compare options, and request showings directly with Ray.</p></div></div>`)}`);
  });

  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain").send("User-agent: *\nDisallow: /\n"));

  app.get("/connect", async (_req, reply) => {
    reply.type("text/html");
    return page("Mortgage Payment Calculator", `<section class="calc-page"><div class="wrap">
      <div class="calc-head">
        <p class="muted" style="font-size:12px;font-weight:800;letter-spacing:.2em;margin-bottom:10px">PLAN WITH CONFIDENCE</p>
        <h1>Mortgage Payment Calculator</h1>
        <p>Estimate your monthly payment and the income you may need to qualify.</p>
      </div>
      <div class="calc-card" aria-label="Mortgage calculator inputs">
        <div class="calc-row"><label class="calc-label" for="home-price">Home Price</label><div class="calc-input"><input id="home-price" inputmode="decimal" value="1,000,000" aria-label="Home price"><span class="calc-unit">$</span></div></div>
        <div class="calc-row"><label class="calc-label" for="down-payment">Down Payment<small>Percentage of purchase price</small></label><div class="calc-input"><input id="down-payment" inputmode="decimal" value="20" aria-label="Down payment percentage"><span class="calc-unit">%</span></div></div>
        <div class="calc-row"><label class="calc-label" for="interest-rate">Interest Rate</label><div class="calc-input"><input id="interest-rate" inputmode="decimal" value="4.00" aria-label="Annual interest rate"><span class="calc-unit">%</span></div></div>
        <div class="calc-row"><label class="calc-label" for="amortization">Amortization<small>Loan repayment period</small></label><div class="calc-input"><select id="amortization" aria-label="Amortization period"><option value="15">15 years</option><option value="20">20 years</option><option value="25">25 years</option><option value="30" selected>30 years</option></select></div></div>
      </div>
      <div class="calc-card calc-result" aria-live="polite">
        <div class="calc-total" id="monthly-payment">$3,804.15</div>
        <p class="calc-caption" id="payment-caption">Estimated monthly mortgage payment</p>
        <div class="calc-line"><span>Down payment</span><strong id="down-payment-value">$200,000</strong></div>
        <div class="calc-line"><span>Mortgage principal</span><strong id="mortgage-principal">$800,000</strong></div>
        <div class="calc-line"><span>Total interest over amortization</span><strong id="total-interest">$569,494</strong></div>
        <div class="calc-line"><span>Estimated annual income needed<small class="muted" style="display:block;font-weight:400">Assumes housing costs near 39% of gross income</small></span><strong id="income-needed">$117,051</strong></div>
        <div class="calc-cta"><a class="btn" href="tel:416-625-2070">Discuss your budget</a><a class="btn alt" href="/register">Request property access</a></div>
      </div>
      <p class="calc-disclaimer">Estimates only. Canadian fixed-rate mortgages compound semi-annually. Qualification depends on lender stress tests, property taxes, heating costs, condo fees, other debts, credit, and current lending rules. This is not financial advice.</p>
    </div></section>
    <script>
      (function () {
        var priceInput = document.getElementById("home-price");
        var downInput = document.getElementById("down-payment");
        var rateInput = document.getElementById("interest-rate");
        var amortizationInput = document.getElementById("amortization");
        var money0 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
        var money2 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
        function numberFrom(value) { return Number(String(value).replace(/[^0-9.-]/g, "")) || 0; }
        function calculate() {
          var price = Math.max(0, numberFrom(priceInput.value));
          var downPercent = Math.min(100, Math.max(0, numberFrom(downInput.value)));
          var annualRate = Math.max(0, numberFrom(rateInput.value)) / 100;
          var years = Number(amortizationInput.value) || 30;
          var down = price * downPercent / 100;
          var principal = Math.max(0, price - down);
          var months = years * 12;
          var monthlyRate = annualRate === 0 ? 0 : Math.pow(1 + annualRate / 2, 2 / 12) - 1;
          var payment = monthlyRate === 0 ? principal / months : principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
          var interest = Math.max(0, payment * months - principal);
          var annualIncome = payment * 12 / 0.39;
          document.getElementById("monthly-payment").textContent = money2.format(payment || 0);
          document.getElementById("payment-caption").textContent = "Estimated monthly payment at " + (annualRate * 100).toFixed(2) + "% over " + years + " years";
          document.getElementById("down-payment-value").textContent = money0.format(down);
          document.getElementById("mortgage-principal").textContent = money0.format(principal);
          document.getElementById("total-interest").textContent = money0.format(interest);
          document.getElementById("income-needed").textContent = money0.format(annualIncome);
        }
        [priceInput, downInput, rateInput, amortizationInput].forEach(function (element) {
          element.addEventListener("input", calculate);
          element.addEventListener("change", calculate);
        });
        priceInput.addEventListener("blur", function () { priceInput.value = new Intl.NumberFormat("en-CA").format(numberFrom(priceInput.value)); });
        calculate();
      })();
    </script>`);
  });

  app.get("/privacy", async (_req, reply) => {
    const c = config();
    reply.type("text/html");
    return page("Privacy Policy", section(`<div class="card"><h1>Privacy Policy</h1><p>Last updated July 8, 2026.</p><h2>Information collected</h2><p>We collect the name, email address, username, account-security information, search activity, property interactions, communications, and technical audit information needed to provide and secure this private real-estate service.</p><h2>How information is used</h2><p>Information is used to verify your account, establish and support the broker-consumer relationship you request, provide property-search services, respond to inquiries, arrange showings, prevent unauthorized MLS® data use, and comply with legal and real-estate-board obligations.</p><h2>Sharing and retention</h2><p>We do not sell personal information. We may disclose it to ${esc(c.REALTOR_BROKERAGE)}, service providers acting under our instructions, regulators, the applicable real estate board, PropTx, or other authorized representatives when required for compliance, security, or service delivery. VOW account and audit records are retained for the periods required by applicable MLS® rules and law.</p><h2>Security and choices</h2><p>We use access controls, encrypted transport, password hashing, expiring sessions, and activity logs. Contact <a href="mailto:${esc(c.REALTOR_EMAIL || c.GMAIL_ADDRESS)}">${esc(c.REALTOR_EMAIL || c.GMAIL_ADDRESS)}</a> to request access or correction, subject to lawful retention requirements.</p></div>`));
  });

  app.get("/terms", async (_req, reply) => {
    reply.type("text/html");
    return page("VOW Terms of Use", section(`<div class="card"><h1>VOW Terms of Use</h1><p>Version ${TERMS_VERSION}. You must accept these terms before accessing listing information.</p><ol><li>You acknowledge that you are entering into a lawful broker-consumer relationship with Ray Ahmadi for the purpose of receiving real-estate brokerage services. These Terms do not create a representation agreement or financial obligation; any such agreement must be established separately.</li><li>Listing information is for your personal, non-commercial use in connection with your bona fide interest in purchasing, selling, or leasing real estate.</li><li>You may not copy, redistribute, retransmit, publish, display, broadcast, sell, sublicense, or otherwise provide listing information to any other person or entity.</li><li>You may not provide listing information to an artificial-intelligence system or any technology intended to collect, store, reorganize, analyze, summarize, or manipulate listing information or related data.</li><li>Scraping, screen scraping, database scraping, data mining, automated extraction, and other collection, storage, reorganization, summarization, or manipulation of listing information are prohibited.</li><li>You acknowledge the applicable Association's and PropTx's ownership of and proprietary rights and copyright in the MLS® database, MLS® system, listing information, and related information.</li><li>You authorize the applicable Association, its members, PropTx, and their authorized representatives to access this VOW to verify compliance and monitor listing displays.</li><li>Your account is personal. You must protect your credentials, promptly report suspected unauthorized access, and renew your password at least every 90 days.</li></ol><p>Questions may be directed to Ray using the contact information displayed on every page.</p></div>`));
  });

  app.get("/register", async (_req, reply) => {
    reply.type("text/html");
    return page("Register", section(`<div class="card"><h1>Request secure VOW access</h1><p>Registration creates a personal account. A verification link will be sent to your email address.</p><form method="post" action="/register"><div class="field"><label>Full legal name<input name="name" autocomplete="name" required maxlength="160"></label></div><div class="field"><label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254"></label></div><div class="field"><label>Username<input name="username" autocomplete="username" required minlength="4" maxlength="80"></label></div><div class="field"><label>Password<input name="password" type="password" autocomplete="new-password" required minlength="12"><span class="muted">At least 12 characters. Passwords expire after 90 days.</span></label></div><label class="check"><input name="relationship" type="checkbox" value="yes" required><span>I acknowledge that I am entering into a lawful broker-consumer relationship with Ray Ahmadi for the purpose of receiving real-estate brokerage services. This does not create a representation agreement or financial obligation.</span></label><label class="check"><input name="terms" type="checkbox" value="yes" required><span>I have reviewed and agree to the <a href="/terms" target="_blank">VOW Terms of Use</a>, including the restrictions on redistribution, scraping, data mining, and AI ingestion.</span></label><button class="btn" type="submit">Create and verify account</button></form></div>`));
  });

  app.post<{ Body: Form }>("/register", async (req, reply) => {
    const name = (req.body.name ?? "").trim();
    const email = (req.body.email ?? "").trim().toLowerCase();
    const username = (req.body.username ?? "").trim().toLowerCase();
    const password = req.body.password ?? "";
    if (name.length < 2 || !email.includes("@") || username.length < 4 || password.length < 12 || req.body.terms !== "yes" || req.body.relationship !== "yes") {
      reply.code(400).type("text/html");
      return page("Registration error", section('<div class="notice error">Please complete every field, accept both acknowledgements, and use a password of at least 12 characters.</div><p><a href="/register">Return to registration</a></p>'));
    }
    const existing = await db().query.vowConsumers.findFirst({ where: eq(schema.vowConsumers.email, email) });
    if (existing) {
      await audit(req, "registration_duplicate", existing.id);
      reply.code(409).type("text/html");
      return page("Account exists", section('<div class="notice error">An account already exists for this email. Please sign in or contact Ray for assistance.</div><p><a href="/login">Sign in</a></p>'));
    }
    const verificationToken = crypto.randomBytes(32).toString("base64url");
    const [consumer] = await db().insert(schema.vowConsumers).values({
      name,
      email,
      username,
      passwordHash: await passwordHash(password),
      passwordExpiresAt: new Date(Date.now() + NINETY_DAYS_MS),
      verificationTokenHash: tokenHash(verificationToken),
      verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      termsVersion: TERMS_VERSION,
      termsAcceptedAt: new Date(),
      brokerRelationshipAcknowledged: true,
    }).returning();
    await audit(req, "registered", consumer?.id, { termsVersion: TERMS_VERSION });
    const verifyUrl = `${config().VOW_BASE_URL}/verify?token=${encodeURIComponent(verificationToken)}`;
    if (config().gmailEnabled) {
      await sendEmail({ to: email, subject: "Verify your Ray Ahmadi Homes account", body: `Hello ${name},\n\nVerify your email and activate your private property-search account:\n${verifyUrl}\n\nThis link expires in 24 hours. If you did not request this account, ignore this email.` });
    }
    reply.type("text/html");
    return page("Check your email", section(`<div class="notice"><strong>Registration received.</strong> Check ${esc(email)} for the verification link.</div>`));
  });

  app.get<{ Querystring: { token?: string } }>("/verify", async (req, reply) => {
    const hash = tokenHash(req.query.token ?? "");
    const consumer = await db().query.vowConsumers.findFirst({
      where: and(eq(schema.vowConsumers.verificationTokenHash, hash), gt(schema.vowConsumers.verificationExpiresAt, new Date())),
    });
    if (!consumer) {
      reply.code(400).type("text/html");
      return page("Invalid verification", section('<div class="notice error">This verification link is invalid or expired. Contact Ray for assistance.</div>'));
    }
    await db().update(schema.vowConsumers).set({ emailVerifiedAt: new Date(), verificationTokenHash: null, verificationExpiresAt: null, updatedAt: new Date() }).where(eq(schema.vowConsumers.id, consumer.id));
    await audit(req, "email_verified", consumer.id);
    reply.type("text/html");
    return page("Email verified", section('<div class="notice"><strong>Your email is verified.</strong> You may now sign in.</div><p><a class="btn" href="/login">Sign in</a></p>'));
  });

  app.get("/login", async (_req, reply) => {
    reply.type("text/html");
    return page("Sign in", section('<div class="card"><h1>Secure sign in</h1><form method="post" action="/login"><div class="field"><label>Username or email<input name="identifier" autocomplete="username" required></label></div><div class="field"><label>Password<input name="password" type="password" autocomplete="current-password" required></label></div><button class="btn" type="submit">Sign in</button></form></div>'));
  });

  app.post<{ Body: Form }>("/login", async (req, reply) => {
    const identifier = (req.body.identifier ?? "").trim().toLowerCase();
    const consumer = await db().query.vowConsumers.findFirst({
      where: identifier.includes("@") ? eq(schema.vowConsumers.email, identifier) : eq(schema.vowConsumers.username, identifier),
    });
    const valid = consumer ? await passwordMatches(req.body.password ?? "", consumer.passwordHash) : false;
    if (!consumer || !valid || !consumer.emailVerifiedAt || consumer.passwordExpiresAt <= new Date()) {
      await audit(req, "login_failed", consumer?.id);
      reply.code(401).type("text/html");
      return page("Sign-in failed", section('<div class="notice error">Sign-in failed. Confirm your email is verified and your password has not expired.</div><p><a href="/login">Try again</a></p>'));
    }
    const token = crypto.randomBytes(32).toString("base64url");
    await db().insert(schema.vowSessions).values({ consumerId: consumer.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + SESSION_MS) });
    setSession(reply, token);
    await audit(req, "login_succeeded", consumer.id);
    return reply.redirect("/search");
  });

  app.post("/logout", async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) await db().delete(schema.vowSessions).where(eq(schema.vowSessions.tokenHash, tokenHash(raw)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.redirect("/");
  });

  app.get<{ Querystring: { city?: string; minPrice?: string; maxPrice?: string; bedrooms?: string } }>("/search", async (req, reply) => {
    const consumer = await consumerFor(req);
    if (!consumer) return reply.redirect("/login");
    await audit(req, "search_page_view", consumer.id);
    const c = config();
    let resultsHtml = '<div class="notice">MLS® search access is awaiting final PropTx approval. Your verified account is ready; listing results will activate as soon as the licensed feed token is issued.</div>';
    if (c.mlsEnabled && req.query.city) {
      const listings = await searchListings({ city: req.query.city.trim(), minPrice: Number(req.query.minPrice) || undefined, maxPrice: Number(req.query.maxPrice) || undefined, minBedrooms: Number(req.query.bedrooms) || undefined, limit: 20 });
      await audit(req, "listing_search", consumer.id, { city: req.query.city, resultCount: listings.length });
      resultsHtml = listings.length ? `<table><thead><tr><th>Property</th><th>Price</th><th>Beds/Baths</th><th>Status</th></tr></thead><tbody>${listings.map((l) => `<tr><td>${esc(l.address)}<br><span class="muted">${esc(l.city)} · MLS® ${esc(l.mlsNumber)}</span></td><td>${l.listPrice == null ? "" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(l.listPrice)}</td><td>${esc(l.bedrooms)} / ${esc(l.bathrooms)}</td><td>${esc(l.status)}</td></tr>`).join("")}</tbody></table>` : "<p>No matching listings were returned.</p>";
    }
    reply.type("text/html");
    return page("Property search", section(`<div style="display:flex;justify-content:space-between;gap:20px;align-items:center"><div><h1>Welcome, ${esc(consumer.name)}</h1><p class="muted">Your verified VOW account is personal and expires for password renewal on ${esc(consumer.passwordExpiresAt.toLocaleDateString("en-CA"))}.</p></div><form method="post" action="/logout"><button class="btn alt" type="submit">Sign out</button></form></div><div class="card"><form method="get" action="/search"><div class="grid"><div class="field"><label>City<input name="city" value="${esc(req.query.city)}" placeholder="Toronto"></label></div><div class="field"><label>Minimum price<input name="minPrice" inputmode="numeric" value="${esc(req.query.minPrice)}"></label></div><div class="field"><label>Maximum price<input name="maxPrice" inputmode="numeric" value="${esc(req.query.maxPrice)}"></label></div><div class="field"><label>Minimum bedrooms<input name="bedrooms" inputmode="numeric" value="${esc(req.query.bedrooms)}"></label></div></div><button class="btn" type="submit">Search listings</button></form></div><div style="margin-top:24px">${resultsHtml}</div>`));
  });
}
