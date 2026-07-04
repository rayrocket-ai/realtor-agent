import { eq } from "drizzle-orm";
import { calendarClient } from "../google.js";
import { config } from "../../config.js";
import { db, schema } from "../../db/client.js";

const CAL_ID_KEY = "gcal_calendar_id";

/** Resolve the target calendar's ID from GOOGLE_CALENDAR_ID or by name, cached in app_state. */
export async function resolveCalendarId(): Promise<string> {
  const c = config();
  if (c.GOOGLE_CALENDAR_ID) return c.GOOGLE_CALENDAR_ID;

  const cached = await db().query.appState.findFirst({
    where: eq(schema.appState.key, CAL_ID_KEY),
  });
  if (cached?.value) return cached.value as string;

  const res = await calendarClient().calendarList.list({ maxResults: 250 });
  const match = res.data.items?.find(
    (item) => item.summary?.trim().toLowerCase() === c.GOOGLE_CALENDAR_NAME.trim().toLowerCase(),
  );
  const id = match?.id ?? "primary";
  await db()
    .insert(schema.appState)
    .values({ key: CAL_ID_KEY, value: id })
    .onConflictDoUpdate({
      target: schema.appState.key,
      set: { value: id, updatedAt: new Date() },
    });
  return id;
}

export interface Slot {
  start: Date;
  end: Date;
}

/** Free slots within working hours across the given range, checking the target calendar + primary. */
export async function findFreeSlots(
  rangeStart: Date,
  rangeEnd: Date,
  durationMin: number,
): Promise<Slot[]> {
  const c = config();
  const calId = await resolveCalendarId();
  const ids = calId === "primary" ? ["primary"] : [calId, "primary"];

  const fb = await calendarClient().freebusy.query({
    requestBody: {
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      timeZone: c.TZ,
      items: ids.map((id) => ({ id })),
    },
  });

  const busy: Slot[] = [];
  for (const cal of Object.values(fb.data.calendars ?? {})) {
    for (const b of cal.busy ?? []) {
      if (b.start && b.end) busy.push({ start: new Date(b.start), end: new Date(b.end) });
    }
  }
  busy.sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: Slot[] = [];
  const stepMs = 30 * 60 * 1000;
  const durMs = durationMin * 60 * 1000;
  for (let t = ceilToStep(rangeStart, stepMs); t + durMs <= rangeEnd.getTime(); t += stepMs) {
    const start = new Date(t);
    const end = new Date(t + durMs);
    if (!withinWorkingHours(start, end, c.TZ, c.workingHours)) continue;
    const overlaps = busy.some((b) => b.start.getTime() < end.getTime() && b.end.getTime() > start.getTime());
    if (!overlaps) slots.push({ start, end });
    if (slots.length >= 20) break;
  }
  return slots;
}

function ceilToStep(d: Date, stepMs: number): number {
  return Math.ceil(d.getTime() / stepMs) * stepMs;
}

function withinWorkingHours(
  start: Date,
  end: Date,
  tz: string,
  wh: { start: string; end: string },
): boolean {
  const toMinutes = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  };
  const parse = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s >= parse(wh.start) && e <= parse(wh.end) && e > s;
}

export async function createEvent(opts: {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  attendeeEmail?: string | null;
}): Promise<string> {
  const c = config();
  const calId = await resolveCalendarId();
  const res = await calendarClient().events.insert({
    calendarId: calId,
    sendUpdates: opts.attendeeEmail ? "all" : "none",
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      location: opts.location,
      start: { dateTime: opts.start.toISOString(), timeZone: c.TZ },
      end: { dateTime: opts.end.toISOString(), timeZone: c.TZ },
      attendees: opts.attendeeEmail ? [{ email: opts.attendeeEmail }] : undefined,
    },
  });
  return res.data.id ?? "";
}

export async function updateEvent(
  eventId: string,
  opts: { start?: Date; end?: Date; summary?: string },
): Promise<void> {
  const c = config();
  const calId = await resolveCalendarId();
  await calendarClient().events.patch({
    calendarId: calId,
    eventId,
    sendUpdates: "all",
    requestBody: {
      summary: opts.summary,
      start: opts.start ? { dateTime: opts.start.toISOString(), timeZone: c.TZ } : undefined,
      end: opts.end ? { dateTime: opts.end.toISOString(), timeZone: c.TZ } : undefined,
    },
  });
}

export async function deleteEvent(eventId: string): Promise<void> {
  const calId = await resolveCalendarId();
  try {
    await calendarClient().events.delete({ calendarId: calId, eventId, sendUpdates: "all" });
  } catch (err: unknown) {
    // Already-deleted events shouldn't fail a cancellation flow.
    const status = (err as { code?: number }).code;
    if (status !== 404 && status !== 410) throw err;
  }
}
