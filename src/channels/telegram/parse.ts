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
  /** Listing refs in given order: street addresses and/or MLS numbers. */
  refs: string[];
  start: Date;
  echo: string;
  durationMin?: number;
  dryRun: boolean;
}

/** TRREB-style MLS number, e.g. W13503106. */
export const MLS_RE = /^[A-Za-z]\d{7,8}$/;

export function isMlsNumber(s: string): boolean {
  return MLS_RE.test(s.trim());
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

/**
 * Split the listings part into individual refs.
 *  - Newlines always separate listings.
 *  - Commas separate listings only when BOTH sides look like a new listing
 *    (street number or MLS number) — so "36 Example Ave, Toronto" stays whole.
 */
function splitRefs(listingsPart: string): string[] {
  const startsListing = (s: string) => /^\d+\s+\S/.test(s.trim()) || isMlsNumber(s.trim());
  const lines = listingsPart
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const refs: string[] = [];
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
    let current = "";
    for (const part of parts) {
      if (current && startsListing(part)) {
        refs.push(current);
        current = part;
      } else {
        current = current ? `${current}, ${part}` : part;
      }
    }
    if (current) refs.push(current);
  }
  // MLS numbers may also be space-separated on one line: "W13503106 C5877233".
  const out: string[] = [];
  for (const r of refs) {
    const tokens = r.split(/\s+/);
    if (tokens.length > 1 && tokens.every((t) => isMlsNumber(t))) out.push(...tokens);
    else out.push(stripAddressTail(r));
  }
  return out.filter((r) => r.length >= 3);
}

export function parseBookingMessage(
  raw: string,
  opts: { tz: string; now?: Date },
): ParsedBookingMessage {
  let text = raw.trim();
  if (!text) {
    throw new BookingMessageError("Send me an address (or MLS number) and a time, e.g. “16 Curry Cres tomorrow 5pm”.");
  }

  // Modifiers first.
  const dryRun = /\bdry[\s-]?run\b/i.test(text);
  text = text.replace(/\bdry[\s-]?run\b/gi, "").trim();
  const dur = extractDuration(text);
  text = dur.text;
  const durationMin = dur.durationMin;

  const tryParse = (listingsPart: string, timePart: string): ParsedBookingMessage | null => {
    const t = timePart.trim().replace(/^\b(on|at|for)\b\s+/i, "");
    if (!t) return null;
    let parsed: ParsedTime;
    try {
      parsed = parseRequestedTime(t, { tz: opts.tz, now: opts.now });
    } catch (err) {
      if (err instanceof TimeParseError) return null;
      throw err;
    }
    const refs = splitRefs(listingsPart);
    if (!refs.length) return null;
    return { refs, start: parsed.start, echo: parsed.echo, durationMin, dryRun };
  };

  // Explicit "|" or ";" separator between listings and time wins.
  const sep = text.match(/^(.*)[|;]\s*(.+)$/s);
  if (sep) {
    const hit = tryParse(sep[1]!, sep[2]!);
    if (hit) return hit;
  }

  // If the LAST line parses as a time on its own, everything above is listings.
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const hit = tryParse(lines.slice(0, -1).join("\n"), lines[lines.length - 1]!.replace(/^\b(on|at|for)\b\s+/i, ""));
    if (hit) return hit;
  }

  // Otherwise scan the flattened text for the earliest parseable time expression.
  const flat = text.replace(/\s+/g, " ").trim();
  const markers: number[] = [];
  for (const m of flat.matchAll(TIME_START)) if (m.index !== undefined) markers.push(m.index);
  for (const idx of markers) {
    if (idx === 0) continue; // no listing before it
    const hit = tryParse(flat.slice(0, idx), flat.slice(idx));
    if (hit) return hit;
  }

  // Couldn't find a time — figure out which half is missing for a useful hint.
  const looksLikeOnlyAddress = markers.length === 0;
  throw new BookingMessageError(
    looksLikeOnlyAddress
      ? `Got the listing but no time. Add one, e.g. “${flat} tomorrow 5pm” or “${flat} sat 1:30pm”.`
      : `Couldn't read that. Try “<address or MLS#>, <time>”, e.g. “16 Curry Cres, tomorrow 5pm” — or several listings on separate lines with the time last.`,
  );
}
