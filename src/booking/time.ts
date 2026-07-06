/**
 * Parse the realtor's requested showing time ("tomorrow 2pm", "2026-07-08 14:30",
 * "saturday 1pm", "jul 8 at 2:30 pm") into a UTC Date, interpreting wall-clock
 * times in the configured timezone.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Minutes-style offset of `tz` at `date`, in milliseconds. */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return asUtc - date.getTime();
}

/** Convert wall-clock Y-M-D H:M in `tz` to a UTC Date (DST-safe two-pass). */
export function zonedTimeToUtc(
  y: number, m: number, d: number, hh: number, mm: number, tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

function nowParts(now: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(dtf.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    y: +p.year!, m: +p.month!, d: +p.day!,
    weekday: WEEKDAYS[p.weekday!.slice(0, 3).toLowerCase()] ?? 0,
  };
}

function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "2pm" | "2:30 pm" | "14:00" | "14" (24h only when unambiguous) → minutes since midnight, or null. */
export function parseTimeOfDay(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\./g, "");
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else {
    // Without am/pm we only accept an explicit 24h time like "14:00" or "9:00".
    if (m[2] === undefined) return null;
    if (h > 23) return null;
  }
  return h * 60 + min;
}

export interface ParsedTime {
  start: Date;
  /** Human echo of how the input was understood, e.g. "Wed, Jul 8, 2:00 PM (America/Toronto)". */
  echo: string;
}

export class TimeParseError extends Error {
  constructor(input: string) {
    super(
      `Couldn't understand the time "${input}". Try formats like ` +
        `"2026-07-08 14:00", "tomorrow 2pm", "saturday 1:30pm", or "jul 8 2pm".`,
    );
    this.name = "TimeParseError";
  }
}

export function parseRequestedTime(
  input: string,
  opts: { tz: string; now?: Date },
): ParsedTime {
  const tz = opts.tz;
  const now = opts.now ?? new Date();
  const s = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/\bat\b/g, " ").replace(/\s+/g, " ").trim();

  // 1) Full ISO with explicit offset/Z — take as-is.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2})?(z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(input.trim());
    if (!Number.isNaN(d.getTime())) return { start: d, echo: fmtEcho(d, tz) };
  }

  // 2) "YYYY-MM-DD <time>" (or ISO without offset) — wall clock in tz.
  let m = /^(\d{4})-(\d{2})-(\d{2})[t ](.+)$/.exec(s);
  if (m) {
    const tod = parseTimeOfDay(m[4]!);
    if (tod === null) throw new TimeParseError(input);
    return finish(+m[1]!, +m[2]!, +m[3]!, tod, tz);
  }

  // 3) "today <time>" / "tomorrow <time>" / "tonight <time>"
  m = /^(today|tonight|tomorrow) (.+)$/.exec(s);
  if (m) {
    const tod = parseTimeOfDay(m[2]!);
    if (tod === null) throw new TimeParseError(input);
    const base = nowParts(now, tz);
    const shifted = m[1] === "tomorrow" ? addDays(base.y, base.m, base.d, 1) : base;
    return finish(shifted.y, shifted.m, shifted.d, tod, tz);
  }

  // 4) "(next) <weekday> <time>" — next occurrence of that weekday (never today).
  m = /^(?:next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]* (.+)$/.exec(s);
  if (m) {
    const tod = parseTimeOfDay(m[2]!);
    if (tod === null) throw new TimeParseError(input);
    const base = nowParts(now, tz);
    const target = WEEKDAYS[m[1]!]!;
    let delta = (target - base.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    const day = addDays(base.y, base.m, base.d, delta);
    return finish(day.y, day.m, day.d, tod, tz);
  }

  // 5) "<month> <day>(,) (<year>)? <time>" e.g. "jul 8 2pm", "july 8 2026 2:30 pm"
  m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,?(?: (\d{4}))? (.+)$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.slice(0, 3)];
    const tod = mon !== undefined ? parseTimeOfDay(m[4]!) : null;
    if (mon !== undefined && tod !== null) {
      const base = nowParts(now, tz);
      let year = m[3] ? +m[3] : base.y;
      let res = finish(year, mon, +m[2]!, tod, tz);
      // No year given and the date already passed → they mean next year.
      if (!m[3] && res.start.getTime() < now.getTime()) {
        res = finish(year + 1, mon, +m[2]!, tod, tz);
      }
      return res;
    }
  }

  throw new TimeParseError(input);
}

function finish(y: number, mo: number, d: number, todMinutes: number, tz: string): ParsedTime {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new TimeParseError(`${y}-${mo}-${d}`);
  const start = zonedTimeToUtc(y, mo, d, Math.floor(todMinutes / 60), todMinutes % 60, tz);
  return { start, echo: fmtEcho(start, tz) };
}

function fmtEcho(d: Date, tz: string): string {
  return (
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      weekday: "short", month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(d) + ` (${tz})`
  );
}

/** Format a Date as BrokerBay-style slot text in tz, e.g. "2:00 PM". */
export function fmtSlot(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}
