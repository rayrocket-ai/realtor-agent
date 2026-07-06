import { describe, expect, it } from "vitest";
import { parseRequestedTime, parseTimeOfDay, TimeParseError, zonedTimeToUtc, fmtSlot } from "./time.js";

const TZ = "America/Toronto";
// A fixed "now": Monday 2026-07-06 10:00 Toronto (EDT, UTC-4).
const NOW = new Date("2026-07-06T14:00:00Z");

describe("parseTimeOfDay", () => {
  it("parses 12h and 24h forms", () => {
    expect(parseTimeOfDay("2pm")).toBe(14 * 60);
    expect(parseTimeOfDay("2:30 PM")).toBe(14 * 60 + 30);
    expect(parseTimeOfDay("12am")).toBe(0);
    expect(parseTimeOfDay("12:15pm")).toBe(12 * 60 + 15);
    expect(parseTimeOfDay("14:00")).toBe(14 * 60);
    expect(parseTimeOfDay("9:05")).toBe(9 * 60 + 5);
  });
  it("rejects ambiguous or invalid times", () => {
    expect(parseTimeOfDay("2")).toBeNull(); // no am/pm, no minutes → ambiguous
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("13pm")).toBeNull();
    expect(parseTimeOfDay("2:75pm")).toBeNull();
  });
});

describe("zonedTimeToUtc", () => {
  it("converts Toronto summer (EDT, -4) and winter (EST, -5) wall times", () => {
    expect(zonedTimeToUtc(2026, 7, 8, 14, 0, TZ).toISOString()).toBe("2026-07-08T18:00:00.000Z");
    expect(zonedTimeToUtc(2026, 1, 15, 14, 0, TZ).toISOString()).toBe("2026-01-15T19:00:00.000Z");
  });
});

describe("parseRequestedTime", () => {
  const parse = (s: string) => parseRequestedTime(s, { tz: TZ, now: NOW });

  it("accepts explicit dates with times", () => {
    expect(parse("2026-07-08 14:00").start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
    expect(parse("2026-07-08 2pm").start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
    expect(parse("2026-07-08T14:00").start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
  });

  it("respects an explicit UTC offset", () => {
    expect(parse("2026-07-08T14:00:00-04:00").start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
    expect(parse("2026-07-08T18:00:00Z").start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
  });

  it("handles today / tomorrow", () => {
    expect(parse("today 5pm").start.toISOString()).toBe("2026-07-06T21:00:00.000Z");
    expect(parse("tomorrow 2pm").start.toISOString()).toBe("2026-07-07T18:00:00.000Z");
    expect(parse("tomorrow at 2pm").start.toISOString()).toBe("2026-07-07T18:00:00.000Z");
  });

  it("handles weekdays as the NEXT occurrence (never today)", () => {
    // NOW is Monday → "saturday" = Jul 11, "monday" = Jul 13 (next week).
    expect(parse("saturday 1pm").start.toISOString()).toBe("2026-07-11T17:00:00.000Z");
    expect(parse("sat 1:30pm").start.toISOString()).toBe("2026-07-11T17:30:00.000Z");
    expect(parse("monday 9:00").start.toISOString()).toBe("2026-07-13T13:00:00.000Z");
    expect(parse("next friday 11am").start.toISOString()).toBe("2026-07-10T15:00:00.000Z");
  });

  it("handles month-day forms, rolling to next year when past", () => {
    expect(parse("jul 8 2pm").start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
    expect(parse("July 8 at 2:30 pm").start.toISOString()).toBe("2026-07-08T18:30:00.000Z");
    // Jan 5 already passed in 2026 → next year.
    expect(parse("jan 5 2pm").start.toISOString()).toBe("2027-01-05T19:00:00.000Z");
    expect(parse("jan 5 2027 2pm").start.toISOString()).toBe("2027-01-05T19:00:00.000Z");
  });

  it("produces a human echo in the right timezone", () => {
    expect(parse("2026-07-08 2pm").echo).toContain("2:00");
    expect(parse("2026-07-08 2pm").echo).toContain(TZ);
  });

  it("rejects garbage and bare hours", () => {
    expect(() => parse("whenever")).toThrow(TimeParseError);
    expect(() => parse("tomorrow 2")).toThrow(TimeParseError);
    expect(() => parse("2026-07-08")).toThrow(TimeParseError);
  });
});

describe("fmtSlot", () => {
  it("matches BrokerBay-style slot labels", () => {
    expect(fmtSlot(new Date("2026-07-08T18:00:00Z"), TZ)).toBe("2:00 PM");
    expect(fmtSlot(new Date("2026-07-08T13:30:00Z"), TZ)).toBe("9:30 AM");
  });
});
