import { parseRequestedTime, TimeParseError, type ParsedTime } from "../../booking/time.js";

/**
 * Turn a free-text Telegram message like "16 Curry Cres tomorrow 5pm" into a
 * bookable request: the property address, the requested start time, and
 * optional duration / dry-run modifiers.
 *
 * The message is split into an address part and a time part by scanning for the
 * earliest token that begins a *parseable* time expression — so the street
 * number stays with the address and "tomorrow 5pm" becomes the time.
 */

export interface ParsedBookingMessage {
  address: string;
  start: Date;
  echo: string;
  durationMin?: number;
  dryRun: boolean;
}

export class BookingMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingMessageError";
  }
}

// Tokens that can begin a time expression. Bare numbers are intentionally
// excluded (they're usually street numbers); a bare clock time needs am/pm or
// HH:MM to count.
const TIME_START =
  /\b(today|tonight|tomorrow|tmrw|next|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/gi;

function stripAddressTail(s: string): string {
  return s.replace(/[\s,;:–-]+$/g, "").replace(/\s+\b(on|at|for)\b$/i, "").trim();
}

/** Pull an explicit duration ("for 45 min", "30 minutes") out of the text. */
function extractDuration(text: string): { text: string; durationMin?: number } {
  const m = /\b(?:for\s+)?(\d{1,3})\s*(?:min|mins|minute|minutes)\b/i.exec(text);
  if (!m) return { text };
  const durationMin = Number(m[1]);
  return { text: (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), durationMin };
}

export function parseBookingMessage(
  raw: string,
  opts: { tz: string; now?: Date },
): ParsedBookingMessage {
  let text = raw.trim().replace(/\s+/g, " ");
  if (!text) throw new BookingMessageError("Send me an address and a time, e.g. “16 Curry Cres tomorrow 5pm”.");

  // Modifiers first.
  const dryRun = /\bdry[\s-]?run\b/i.test(text);
  text = text.replace(/\bdry[\s-]?run\b/gi, "").trim();
  const dur = extractDuration(text);
  text = dur.text;
  const durationMin = dur.durationMin;

  // Explicit separators win (address | time, address ; time, address / newline).
  const sep = text.match(/^(.*?)[|;\n]\s*(.+)$/s);
  const tryParse = (address: string, timePart: string): ParsedBookingMessage | null => {
    address = stripAddressTail(address);
    const t = timePart.trim().replace(/^\b(on|at)\b\s+/i, "");
    if (address.length < 3 || !t) return null;
    let parsed: ParsedTime;
    try {
      parsed = parseRequestedTime(t, { tz: opts.tz, now: opts.now });
    } catch (err) {
      if (err instanceof TimeParseError) return null;
      throw err;
    }
    return { address, start: parsed.start, echo: parsed.echo, durationMin, dryRun };
  };

  if (sep) {
    const hit = tryParse(sep[1]!, sep[2]!);
    if (hit) return hit;
  }

  // Otherwise scan for the earliest time-expression start that actually parses.
  const markers: number[] = [];
  for (const m of text.matchAll(TIME_START)) if (m.index !== undefined) markers.push(m.index);
  for (const idx of markers) {
    if (idx === 0) continue; // no address before it
    const hit = tryParse(text.slice(0, idx), text.slice(idx));
    if (hit) return hit;
  }

  // Couldn't find a time — figure out which half is missing for a useful hint.
  const looksLikeOnlyAddress = markers.length === 0;
  throw new BookingMessageError(
    looksLikeOnlyAddress
      ? `Got the address but no time. Add one, e.g. “${text} tomorrow 5pm” or “${text} sat 1:30pm”.`
      : `Couldn't read that. Try “<address>, <time>”, e.g. “16 Curry Cres, tomorrow 5pm” or “16 Curry Cres 2026-07-08 14:00”.`,
  );
}
