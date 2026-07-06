/**
 * Book a showing on the MLS side from the command line: searches REALM for the
 * address, follows the Book Showing handoff into BrokerBay, and books the slot.
 *
 * Usage:
 *   npm run book -- "36 Example Ave, Toronto" "tomorrow 2pm"
 *   npm run book -- "36 Example Ave" "2026-07-08 14:00" --duration 60 --notes "buyer + parents"
 *   npm run book -- "36 Example Ave" "sat 1pm" --dry-run     # everything except the final submit
 *   npm run book -- "36 Example Ave" "sat 1pm" --queue       # hand off to the app's worker instead
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { closeDb, db } from "../db/client.js";
import { parseRequestedTime, TimeParseError } from "../booking/time.js";
import { createBookingRequest, runBooking } from "../booking/service.js";

function usage(): never {
  console.error(
    'Usage: npm run book -- "<address>" "<time>" [--duration MIN] [--notes "…"] [--dry-run] [--queue]',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const c = loadConfig();
  const here = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db(), { migrationsFolder: path.resolve(here, "..", "..", "drizzle") });

  const args = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run" || a === "--queue") flags[a.slice(2)] = true;
    else if (a === "--duration" || a === "--notes") flags[a.slice(2)] = args[++i] ?? "";
    else if (a.startsWith("--")) usage();
    else positional.push(a);
  }
  if (positional.length < 2) usage();
  const address = positional[0]!;
  const timeInput = positional.slice(1).join(" ");

  let parsed;
  try {
    parsed = parseRequestedTime(timeInput, { tz: c.TZ });
  } catch (err) {
    if (err instanceof TimeParseError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (parsed.start.getTime() <= Date.now()) {
    console.error(`That time (${parsed.echo}) is in the past.`);
    process.exit(2);
  }

  const booking = await createBookingRequest({
    address,
    requestedStart: parsed.start,
    durationMin: flags.duration ? Number(flags.duration) : undefined,
    notes: typeof flags.notes === "string" ? flags.notes : null,
    source: "cli",
    dryRun: flags["dry-run"] === true ? true : undefined,
  });

  console.log(`Booking ${booking.id}`);
  console.log(`  ${address}`);
  console.log(`  ${parsed.echo}, ${booking.durationMin} min${booking.dryRun ? " (DRY RUN — will stop before submit)" : ""}`);

  if (flags.queue) {
    console.log("Queued — the app worker will pick it up within ~15s. Watch it at /admin/bookings.");
  } else {
    console.log("Running now…\n");
    const result = await runBooking(booking.id);
    console.log(`\nResult: ${result.status}`);
    console.log(`Details: ${c.APP_BASE_URL}/admin/bookings/${booking.id}`);
    if (result.retryable) process.exitCode = 1;
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
