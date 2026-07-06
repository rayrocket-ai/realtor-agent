/**
 * One-time Telegram wiring. Prereqs in .env: TELEGRAM_BOT_TOKEN (from @BotFather),
 * APP_BASE_URL, and TELEGRAM_WEBHOOK_SECRET (any random string).
 *
 * Usage: npm run telegram:setup   (or: docker compose run --rm app npx tsx src/cli/telegram-setup.ts)
 */
import { loadConfig } from "../config.js";
import { setTelegramWebhook, getTelegramBotInfo } from "../channels/telegram/client.js";

async function main(): Promise<void> {
  const c = loadConfig();
  if (!c.telegramEnabled) {
    console.error("Set TELEGRAM_BOT_TOKEN in .env first (create a bot with @BotFather on Telegram).");
    process.exit(1);
  }
  if (!c.TELEGRAM_WEBHOOK_SECRET) {
    console.error("Set TELEGRAM_WEBHOOK_SECRET in .env (any long random string) first.");
    process.exit(1);
  }

  const url = `${c.APP_BASE_URL.replace(/\/$/, "")}/webhooks/telegram`;
  await setTelegramWebhook(url, c.TELEGRAM_WEBHOOK_SECRET);
  const me = await getTelegramBotInfo();

  console.log(`✅ Webhook registered: ${url}`);
  console.log(`Bot: @${me.username ?? "unknown"} (${me.first_name ?? ""})`);
  console.log(`\nShare this link with leads: https://t.me/${me.username ?? "<your-bot>"}`);
  console.log("Anyone who messages the bot becomes a lead and gets an AI reply within ~1 minute.");
}

main().catch((err) => {
  console.error("Telegram setup failed:", (err as Error).message);
  process.exit(1);
});
