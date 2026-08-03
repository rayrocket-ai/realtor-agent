import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import { config } from "../config.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { approvalRoutes, messageApprovalRoutes } from "./routes/approvals.js";
import { dashboardAuthRoutes } from "./routes/dashboard-auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { publicLeadRoutes } from "./routes/public-lead.js";
import { voiceMlsRoutes } from "./routes/voice-mls.js";
import { voiceVapiRoutes } from "./routes/voice-vapi.js";
import { vowRoutes } from "./routes/vow.js";

export async function buildApp(): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger: { level: c.LOG_LEVEL },
    trustProxy: true, // behind Caddy
  });

  await app.register(formbody);
  await app.register(cookie);

  await app.register(healthRoutes);
  // VOW is mounted on an internal prefix. Caddy rewrites only the dedicated
  // consumer domain to it, avoiding collisions with the public lead page.
  await app.register(vowRoutes, { prefix: "/vow" });
  await app.register(publicLeadRoutes);
  await app.register(webhookRoutes);
  await app.register(voiceMlsRoutes);
  await app.register(voiceVapiRoutes);
  await app.register(approvalRoutes);
  await app.register(messageApprovalRoutes);
  await app.register(dashboardAuthRoutes, { prefix: "/admin" });
  await app.register(dashboardRoutes, { prefix: "/admin" });

  return app;
}
