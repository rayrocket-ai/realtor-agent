import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (_req, reply) => {
    try {
      await db().execute(sql`SELECT 1`);
      return { ok: true, db: "up", time: new Date().toISOString() };
    } catch (err) {
      reply.status(503);
      return { ok: false, db: "down", error: (err as Error).message };
    }
  });
}
