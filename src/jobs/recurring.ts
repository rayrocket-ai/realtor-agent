import { config } from "../config.js";
import { enqueue } from "./queue.js";

/** Daily jobs and their local (office timezone) run times. */
export const RECURRING_JOBS: Record<string, { hour: number; minute: number }> = {
  "morning-briefing": { hour: 7, minute: 30 },
  "distill-lessons": { hour: 3, minute: 0 },
};

/** Next wall-clock occurrence of hour:minute in tz, from `from`. */
export function nextDailyOccurrence(
  hour: number,
  minute: number,
  tz: string,
  from: Date = new Date(),
): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(from);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const nowMin = (get("hour") % 24) * 60 + get("minute") + get("second") / 60;
  let deltaMin = hour * 60 + minute - nowMin;
  if (deltaMin <= 0.5) deltaMin += 24 * 60;
  return new Date(from.getTime() + deltaMin * 60_000);
}

export async function scheduleRecurring(type: string): Promise<void> {
  const spec = RECURRING_JOBS[type];
  if (!spec) return;
  await enqueue({
    type,
    runAt: nextDailyOccurrence(spec.hour, spec.minute, config().TZ),
    dedupeKey: `recurring:${type}`,
  });
}

/** Called on boot so daily jobs exist even after long downtime. */
export async function ensureRecurringJobs(): Promise<void> {
  for (const type of Object.keys(RECURRING_JOBS)) {
    await scheduleRecurring(type);
  }
}
