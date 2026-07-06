import Fastify, { type FastifyInstance } from "fastify";
import basicAuth from "@fastify/basic-auth";
import formbody from "@fastify/formbody";
import crypto from "node:crypto";
import { config } from "../config.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { approvalRoutes } from "./routes/approvals.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { bookingRoutes } from "./routes/bookings.js";

export async function buildApp(): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger: { level: c.LOG_LEVEL },
    trustProxy: true, // behind Caddy
  });

  await app.register(formbody);
  await app.register(basicAuth, {
    validate: async (username, password) => {
      const userOk = timingSafeEqual(username, c.ADMIN_USER);
      const passOk = timingSafeEqual(password, c.ADMIN_PASSWORD);
      if (!userOk || !passOk) throw new Error("Unauthorized");
    },
    authenticate: { realm: "realtor-agent" },
  });

  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(approvalRoutes);
  await app.register(dashboardRoutes, { prefix: "/admin" });
  await app.register(bookingRoutes, { prefix: "/admin/bookings" });

  return app;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
