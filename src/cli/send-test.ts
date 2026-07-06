/**
 * Local testing harness: inject a fake inbound message and run the agent
 * turn immediately (skipping the debounce). Combine with MOCK_ANTHROPIC=1
 * to test without an API key.
 *
 * Usage:
 *   npm run send-test -- "can I see 12 Main St this weekend?"
 *   npm run send-test -- --channel whatsapp "what's my home worth?"
 */
import { loadConfig } from "../config.js";
import { db, closeDb } from "../db/client.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { ingestInbound } from "../channels/ingest.js";
import { runAgentTurn } from "../agent/loop.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  loadConfig();
  const here = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db(), { migrationsFolder: path.resolve(here, "..", "..", "drizzle") });

  const args = process.argv.slice(2);
  let channel = "gmail";
  const chIdx = args.indexOf("--channel");
  if (chIdx >= 0) {
    channel = args[chIdx + 1] ?? "gmail";
    args.splice(chIdx, 2);
  }
  const text = args.join(" ") || "Hi, is 12 Main St still available? Can I see it this weekend?";

  const result = await ingestInbound({
    channel,
    externalId: channel === "gmail" ? "testlead@example.com" : "test-contact-1",
    externalMsgId: `test:${Date.now()}`,
    name: "Test Lead",
    email: channel === "gmail" ? "testlead@example.com" : null,
    body: text,
    meta: { subject: "Test inquiry", source: "send-test" },
  });

  console.log(`Ingested for lead ${result.leadId}. Running agent turn now…\n`);
  try {
    const turn = await runAgentTurn(result.leadId, "send-test");
    console.log(turn.replied ? `Agent replied:\n\n${turn.output}` : `No reply: ${turn.reason}`);
  } catch (err) {
    console.error("Agent turn failed:", err);
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
