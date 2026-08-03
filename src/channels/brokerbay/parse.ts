/**
 * Heuristic parser for BrokerBay notification emails (confirmations, changes,
 * cancellations). BrokerBay has no public API for individual agents, but every
 * booking event lands in the realtor's inbox — so the inbox IS the API.
 * Pure function; fixtures in parse.test.ts.
 */
export interface BrokerBayEvent {
  kind: "confirmed" | "declined" | "cancelled" | "rescheduled" | "requested" | "unknown";
  address: string | null;
  startsAt: Date | null;
  lockboxCode: string | null;
  instructions: string | null;
  agentName: string | null;
  agentEmail: string | null;
  agentPhone: string | null;
}

export function isBrokerBayEmail(fromEmail: string, subject: string): boolean {
  return (
    /@(.*\.)?brokerbay\.(com|ca)$/i.test(fromEmail) ||
    /brokerbay/i.test(fromEmail) ||
    /\bshowing (request|confirmed|approved|declined|cancelled|updated|rescheduled)\b/i.test(subject)
  );
}

export function parseBrokerBayEmail(subject: string, body: string): BrokerBayEvent {
  const text = `${subject}\n${body}`;

  const kind: BrokerBayEvent["kind"] = /confirm|approved/i.test(subject)
    ? "confirmed"
    : /declin/i.test(subject)
      ? "declined"
      : /cancel/i.test(subject)
        ? "cancelled"
        : /reschedul|updated|changed/i.test(subject)
          ? "rescheduled"
          : /request/i.test(subject)
            ? "requested"
            : "unknown";

  // Address: labeled line first, else a street-looking line.
  const address =
    match(text, /(?:property|address|listing)\s*[:\-]\s*([^\n]+)/i) ??
    match(text, /^\s*(\d{1,6}\s+[A-Za-z][^\n,]*(?:,\s*[^\n]+)?)\s*$/m);

  // Date/time: "Jul 12, 2026 2:00 PM" / "2026-07-12 14:00" / labeled lines.
  const dateStr =
    match(text, /(?:date\s*(?:&|and)?\s*time|showing time|time)\s*[:\-]\s*([^\n]+)/i) ??
    match(
      text,
      /((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}[^\n]*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)[^\n]*)/,
      2,
    );
  const startsAt = dateStr ? parseLooseDate(dateStr) : null;

  const lockboxCode =
    match(text, /lock\s*box(?:\s*(?:code|combo|combination|#))?\s*[:\-]\s*([^\n]+)/i) ??
    match(text, /\bLB\s*(?:code|#)?\s*[:\-]\s*([^\n]+)/i);

  const instructions = match(
    text,
    /(?:showing\s+)?instructions?\s*[:\-]\s*([\s\S]{0,400}?)(?:\n\s*\n|$)/i,
  );

  const agentName = match(text, /(?:showing agent|booked by|agent name|requested by)\s*[:\-]\s*([^\n]+)/i);
  const agentEmail = match(text, /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  const agentPhone = match(text, /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);

  return {
    kind,
    address: clean(address),
    startsAt,
    lockboxCode: clean(lockboxCode),
    instructions: clean(instructions),
    agentName: clean(agentName),
    agentEmail: agentEmail?.toLowerCase() ?? null,
    agentPhone: clean(agentPhone),
  };
}

function match(text: string, re: RegExp, group = 1): string | null {
  const m = text.match(re);
  return m?.[group]?.trim() || null;
}

function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s.replace(/\s+/g, " ").trim();
  return out.length ? out.slice(0, 300) : null;
}

/** Tolerant date parsing for the formats BrokerBay emails use. */
export function parseLooseDate(s: string, timeZone = "America/Toronto"): Date | null {
  // BrokerBay notifications omit the zone and use the brokerage's local time.
  // Parse that form before Date(), which would otherwise interpret it in the
  // server/container zone (usually UTC) and miss the matching showing by hours.
  const m = s.match(
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}).*?(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/,
  );
  if (m) {
    const wall = new Date(`${m[1]} ${m[2]} UTC`);
    if (!Number.isNaN(wall.getTime())) {
      return localWallTimeToUtc(wall, timeZone);
    }
  }
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct;
  return null;
}

function localWallTimeToUtc(wallAsUtc: Date, timeZone: string): Date {
  let candidate = wallAsUtc.getTime();
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(candidate));
    const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour") % 24,
      value("minute"),
      value("second"),
    );
    candidate += wallAsUtc.getTime() - represented;
  }
  return new Date(candidate);
}
