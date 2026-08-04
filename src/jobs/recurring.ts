import { config } from "../config.js";
import { enqueue } from "./queue.js";

/** Recurring jobs and their local (office timezone) run times. `weekday` (0=Sun…6=Sat) makes a job weekly. */
export const RECURRING_JOBS: Record<string, { hour: number; minute: number; weekday?: number }> = {
  "morning-briefing": { hour: 7, minute: 30 },
  "distill-lessons": { hour: 3, minute: 0 },
  "refresh-buyer-profiles": { hour: 6, minute: 30 },
  "buyer-weekly-update": { hour: 8, minute: 0, weekday: 1 },
  "lead-reactivation": { hour: 10, minute: 0 },
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayInTz(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short" }).format(date);
  return WEEKDAYS.indexOf(name.slice(0, 3));
}

/** Next wall-clock occurrence of hour:minute on `weekday` (0=Sun…6=Sat) in tz, from `from`. */
export function nextWeeklyOccurrence(
  hour: number,
  minute: number,
  weekday: number,
  tz: string,
  from: Date = new Date(),
): Date {
  let candidate = nextDailyOccurrence(hour, minute, tz, from);
  for (let i = 0; i < 7 && weekdayInTz(candidate, tz) !== weekday; i++) {
    candidate = nextDailyOccurrence(hour, minute, tz, new Date(candidate.getTime() + 60_000));
  }
  return candidate;
}

export async function scheduleRecurring(type: string): Promise<void> {
  const spec = RECURRING_JOBS[type];
  if (!spec) return;
  const tz = config().TZ;
  await enqueue({
    type,
    runAt:
      spec.weekday === undefined
        ? nextDailyOccurrence(spec.hour, spec.minute, tz)
        : nextWeeklyOccurrence(spec.hour, spec.minute, spec.weekday, tz),
    dedupeKey: `recurring:${type}`,
  });
}

/** Called on boot so daily jobs exist even after long downtime. */
export async function ensureRecurringJobs(): Promise<void> {
  for (const type of Object.keys(RECURRING_JOBS)) {
    await scheduleRecurring(type);
  }
}
