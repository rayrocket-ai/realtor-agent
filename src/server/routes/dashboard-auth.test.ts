import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  process.env.APP_BASE_URL = "https://ray.example.com";
  process.env.ADMIN_USER = "ray";
  process.env.ADMIN_PASSWORD = "correct-horse-battery-staple";
  process.env.APPROVAL_TOKEN_SECRET = "test-session-secret-that-is-long";
});

describe("dashboard session", () => {
  it("accepts a valid token and rejects tampering and expiry", async () => {
    const { createDashboardSession, verifyDashboardSession } = await import("./dashboard-auth.js");
    const now = 1_800_000_000_000;
    const token = createDashboardSession("ray", now);

    expect(verifyDashboardSession(token, now + 1_000)).toBe(true);
    expect(verifyDashboardSession(`${token.slice(0, -1)}x`, now + 1_000)).toBe(false);
    expect(verifyDashboardSession(token, now + 12 * 60 * 60 * 1_000 + 1_000)).toBe(false);
  });

  it("allows only local dashboard return paths", async () => {
    const { safeDashboardPath } = await import("./dashboard-auth.js");

    expect(safeDashboardPath("/admin/voice?call=123")).toBe("/admin/voice?call=123");
    expect(safeDashboardPath("https://evil.example/admin")).toBe("/admin/");
    expect(safeDashboardPath("//evil.example/admin")).toBe("/admin/");
    expect(safeDashboardPath("/admin/login")).toBe("/admin/");
  });
});

describe("dashboard sign-in routes", () => {
  it("uses a form login and issues a hardened session cookie", async () => {
    const { dashboardAuthRoutes } = await import("./dashboard-auth.js");
    const app = Fastify({ trustProxy: true });
    await app.register(formbody);
    await app.register(cookie);
    await app.register(dashboardAuthRoutes, { prefix: "/admin" });

    const page = await app.inject({ method: "GET", url: "/admin/login" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Ray Central Command");
    expect(page.headers["www-authenticate"]).toBeUndefined();

    const failed = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=ray&password=wrong",
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.headers["www-authenticate"]).toBeUndefined();

    const success = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=ray&password=correct-horse-battery-staple&next=%2Fadmin%2Fvoice",
    });
    expect(success.statusCode).toBe(303);
    expect(success.headers.location).toBe("/admin/voice");
    const setCookie = String(success.headers["set-cookie"]);
    expect(setCookie).toContain("__Host-ray_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");

    await app.close();
  });
});
