import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";

const COOKIE_NAME = "__Host-ray_admin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

interface SessionPayload {
  v: 1;
  u: string;
  iat: number;
  exp: number;
  nonce: string;
}

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

const loginAttempts = new Map<string, LoginAttempt>();

export async function dashboardAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { next?: string } }>("/login", async (req, reply) => {
    dashboardSecurityHeaders(reply);
    const next = safeDashboardPath(req.query.next);
    if (hasValidDashboardSession(req)) return reply.redirect(next);

    reply.type("text/html; charset=utf-8");
    return loginPage(next);
  });

  app.post<{ Body: { username?: string; password?: string; next?: string } }>(
    "/login",
    async (req, reply) => {
      dashboardSecurityHeaders(reply);
      const next = safeDashboardPath(req.body?.next);
      const origin = req.headers.origin;
      if (origin && !isSameOrigin(origin)) {
        return reply.code(403).type("text/html; charset=utf-8").send(loginPage(next, "That sign-in request was blocked. Please try again."));
      }

      const now = Date.now();
      pruneAttempts(now);
      const key = req.ip;
      const current = loginAttempts.get(key);
      if (current && current.failures >= MAX_FAILURES && current.resetAt > now) {
        const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
        reply.header("Retry-After", String(retryAfter));
        return reply.code(429).type("text/html; charset=utf-8").send(
          loginPage(next, "Too many sign-in attempts. Please wait a few minutes and try again."),
        );
      }

      const c = config();
      const userOk = timingSafeTextEqual(req.body?.username ?? "", c.ADMIN_USER);
      const passwordOk = timingSafeTextEqual(req.body?.password ?? "", c.ADMIN_PASSWORD);
      if (!userOk || !passwordOk) {
        recordFailure(key, now);
        return reply.code(401).type("text/html; charset=utf-8").send(
          loginPage(next, "The username or password was not recognized."),
        );
      }

      loginAttempts.delete(key);
      reply.setCookie(COOKIE_NAME, createDashboardSession(c.ADMIN_USER), {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: SESSION_TTL_SECONDS,
      });
      return reply.code(303).redirect(next);
    },
  );

  app.post("/logout", async (_req, reply) => {
    dashboardSecurityHeaders(reply);
    reply.clearCookie(COOKIE_NAME, { path: "/", httpOnly: true, secure: true, sameSite: "strict" });
    return reply.code(303).redirect("/admin/login");
  });
}

export async function requireDashboardSession(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  dashboardSecurityHeaders(reply);
  if (!hasValidDashboardSession(req)) {
    if (req.method === "GET" || req.method === "HEAD") {
      const next = safeDashboardPath(req.url);
      return reply.redirect(`/admin/login?next=${encodeURIComponent(next)}`);
    }
    return reply.code(401).type("text/plain; charset=utf-8").send("Your dashboard session expired. Sign in again.");
  }

  const origin = req.headers.origin;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin && !isSameOrigin(origin)) {
    return reply.code(403).type("text/plain; charset=utf-8").send("Cross-site request blocked.");
  }
}

export function createDashboardSession(username: string, nowMs = Date.now()): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: SessionPayload = {
    v: 1,
    u: username,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const unsigned = `v1.${encoded}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export function verifyDashboardSession(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return false;
  const unsigned = `${parts[0]}.${parts[1]}`;
  if (!timingSafeTextEqual(parts[2], sign(unsigned))) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<SessionPayload>;
    const now = Math.floor(nowMs / 1000);
    return payload.v === 1 &&
      payload.u === config().ADMIN_USER &&
      typeof payload.iat === "number" &&
      typeof payload.exp === "number" &&
      typeof payload.nonce === "string" &&
      payload.nonce.length >= 16 &&
      payload.iat <= now + 300 &&
      payload.exp > now &&
      payload.exp - payload.iat <= SESSION_TTL_SECONDS + 300;
  } catch {
    return false;
  }
}

export function safeDashboardPath(value: unknown): string {
  if (typeof value !== "string") return "/admin/";
  if (!value.startsWith("/admin") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return "/admin/";
  }
  if (value.startsWith("/admin/login") || value.startsWith("/admin/logout")) return "/admin/";
  return value;
}

function hasValidDashboardSession(req: FastifyRequest): boolean {
  return verifyDashboardSession(req.cookies[COOKIE_NAME]);
}

function sign(value: string): string {
  const c = config();
  const secret = c.DASHBOARD_SESSION_SECRET || c.APPROVAL_TOKEN_SECRET;
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function timingSafeTextEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isSameOrigin(origin: string): boolean {
  try {
    return new URL(origin).origin === new URL(config().APP_BASE_URL).origin;
  } catch {
    return false;
  }
}

function recordFailure(key: string, now: number): void {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { failures: 1, resetAt: now + FAILURE_WINDOW_MS });
    return;
  }
  current.failures += 1;
}

function pruneAttempts(now: number): void {
  if (loginAttempts.size < 500) return;
  for (const [key, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(key);
  }
}

function dashboardSecurityHeaders(reply: FastifyReply): void {
  reply
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "same-origin")
    .header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
}

function loginPage(next: string, error = ""): string {
  const safeNext = escapeHtml(next);
  const errorBlock = error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>Sign in — Ray Central Command</title>
<style>
  :root{--ink:#101828;--muted:#667085;--line:#d0d5dd;--blue:#175cd3;--page:#f3f6fb;--panel:#fff;--red:#b42318;--red-bg:#fef3f2}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top left,#e9f2ff 0,transparent 38%),radial-gradient(circle at bottom right,#efe9ff 0,transparent 34%),var(--page);color:var(--ink);font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{width:min(100%,440px)}.brand{display:flex;align-items:center;gap:12px;margin:0 0 18px}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:linear-gradient(145deg,#2e90fa,#7f56d9);color:#fff;font-size:19px;font-weight:850;box-shadow:0 10px 24px #2e90fa38}.brand strong,.brand span{display:block}.brand span{color:var(--muted);font-size:12px}.card{padding:32px;border:1px solid #e4e7ec;border-radius:22px;background:var(--panel);box-shadow:0 22px 60px #10182814}.card h1{margin:0;font-size:29px;letter-spacing:-.04em}.intro{margin:7px 0 24px;color:var(--muted)}label{display:block;margin:15px 0 6px;font-size:13px;font-weight:700}input{width:100%;height:46px;padding:0 13px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font:inherit;outline:none}input:focus{border-color:var(--blue);box-shadow:0 0 0 4px #175cd31c}.button{width:100%;height:46px;margin-top:22px;border:0;border-radius:10px;background:var(--blue);color:#fff;font:inherit;font-weight:750;cursor:pointer}.button:hover{filter:brightness(.94)}.error{margin:0 0 18px;padding:11px 13px;border-radius:10px;background:var(--red-bg);color:var(--red);font-size:13px;font-weight:650}.security{display:flex;gap:8px;align-items:flex-start;margin:18px 2px 0;color:var(--muted);font-size:12px}.foot{text-align:center;margin:18px 0 0;color:var(--muted);font-size:12px}@media(max-width:520px){.card{padding:25px 21px;border-radius:18px}}
</style></head><body><main class="shell"><div class="brand"><span class="mark">R</span><div><strong>Ray Central Command</strong><span>Real Estate Operations</span></div></div><section class="card"><h1>Welcome back</h1><p class="intro">Sign in to manage leads, listings, appointments, approvals, and AI operations.</p>${errorBlock}<form method="post" action="/admin/login"><input type="hidden" name="next" value="${safeNext}"><label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button class="button" type="submit">Sign in securely</button></form><div class="security"><span>●</span><span>Secure, time-limited session. Your password is never stored in the browser page.</span></div></section><p class="foot">Private system · Ray Ahmadi Real Estate</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
