import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "./config.js";
import { db, closeDb } from "./db/client.js";
import { buildApp } from "./server/app.js";
import { startWorker, stopWorker } from "./jobs/worker.js";
import { startGmailPoller, stopGmailPoller } from "./channels/gmail/poller.js";
import { startTelegramBot, stopTelegramBot } from "./channels/telegram/bot.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const c = loadConfig(); // fail fast on bad .env

  // Migrations run on every boot — no separate deploy step for the operator.
  const migrationsFolder = path.resolve(here, "..", "drizzle");
  await migrate(db(), { migrationsFolder });
  console.log("[db] migrations applied");

  const app = await buildApp();
  await app.listen({ port: c.PORT, host: "0.0.0.0" });
  console.log(`[http] listening on :${c.PORT}`);

  startWorker();
  startGmailPoller();
  startTelegramBot();

  if (!c.gmailEnabled) console.warn("[warn] Gmail/Calendar not configured — run `npm run auth:google` and fill in .env");
  if (!c.boosendEnabled) console.warn("[warn] Boosend not configured — WhatsApp/Instagram disabled");
  if (!c.telegramEnabled) console.warn("[warn] Telegram bot not configured — set TELEGRAM_BOT_TOKEN to book by chat");
  if (!c.ANTHROPIC_API_KEY && !c.MOCK_ANTHROPIC) {
    console.warn("[warn] ANTHROPIC_API_KEY missing — agent replies will fail until it is set");
  }

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal}`);
    stopGmailPoller();
    stopTelegramBot();
    stopWorker();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
