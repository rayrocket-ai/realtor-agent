import { describe, expect, it } from "vitest";
import { parseBookingMessage, BookingMessageError, isMlsNumber } from "./parse.js";

const TZ = "America/Toronto";
const NOW = new Date("2026-07-06T14:00:00Z"); // Mon 10:00 Toronto

const parse = (s: string) => parseBookingMessage(s, { tz: TZ, now: NOW });

describe("isMlsNumber", () => {
  it("matches TRREB-style numbers only", () => {
    expect(isMlsNumber("W13503106")).toBe(true);
    expect(isMlsNumber("c5877233")).toBe(true);
    expect(isMlsNumber("16 Curry Cres")).toBe(false);
    expect(isMlsNumber("W135")).toBe(false);
  });
});

describe("parseBookingMessage — single listing", () => {
  it("splits address and time on a plain message", () => {
    const r = parse("16 Curry Cres tomorrow 5pm");
    expect(r.refs).toEqual(["16 Curry Cres"]);
    expect(r.start.toISOString()).toBe("2026-07-07T21:00:00.000Z");
    expect(r.dryRun).toBe(false);
  });

  it("books by MLS number", () => {
    const r = parse("W13503106 tomorrow 6pm");
    expect(r.refs).toEqual(["W13503106"]);
    expect(r.start.toISOString()).toBe("2026-07-07T22:00:00.000Z");
  });

  it("keeps the street number with the address, not the time", () => {
    const r = parse("5 Main St tomorrow 2pm");
    expect(r.refs).toEqual(["5 Main St"]);
  });

  it("keeps city commas inside one address", () => {
    const r = parse("36 Example Ave, Toronto, sat 1:30pm");
    expect(r.refs).toEqual(["36 Example Ave, Toronto"]);
    expect(r.start.toISOString()).toBe("2026-07-11T17:30:00.000Z");
  });

  it("handles an explicit date and duration", () => {
    const r = parse("12 King St W 2026-07-08 14:00 for 45 min");
    expect(r.refs).toEqual(["12 King St W"]);
    expect(r.durationMin).toBe(45);
    expect(r.start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
  });

  it("recognizes a dry-run modifier", () => {
    const r = parse("dry run 16 Curry Cres tomorrow 5pm");
    expect(r.refs).toEqual(["16 Curry Cres"]);
    expect(r.dryRun).toBe(true);
  });
});

describe("parseBookingMessage — multiple listings (tours)", () => {
  it("splits several MLS numbers on one line", () => {
    const r = parse("W13503106 C5877233 tomorrow 6pm");
    expect(r.refs).toEqual(["W13503106", "C5877233"]);
    expect(r.start.toISOString()).toBe("2026-07-07T22:00:00.000Z");
  });

  it("splits comma-separated MLS numbers", () => {
    const r = parse("W13503106, C5877233, tomorrow 6pm");
    expect(r.refs).toEqual(["W13503106", "C5877233"]);
  });

  it("splits addresses on separate lines with the time last", () => {
    const r = parse("16 Curry Cres\n34 Buttonleaf Cres\n47 Boyce Ave\ntomorrow 6pm");
    expect(r.refs).toEqual(["16 Curry Cres", "34 Buttonleaf Cres", "47 Boyce Ave"]);
    expect(r.start.toISOString()).toBe("2026-07-07T22:00:00.000Z");
  });

  it('handles "for 6pm" phrasing on the last line', () => {
    const r = parse("16 Curry Cres\nW13503106\nfor tomorrow 6pm");
    expect(r.refs).toEqual(["16 Curry Cres", "W13503106"]);
    expect(r.start.toISOString()).toBe("2026-07-07T22:00:00.000Z");
  });

  it("splits comma-separated addresses when each starts with a street number", () => {
    const r = parse("16 Curry Cres, 34 Buttonleaf Cres, 47 Boyce Ave tomorrow 6pm");
    expect(r.refs).toEqual(["16 Curry Cres", "34 Buttonleaf Cres", "47 Boyce Ave"]);
  });

  it("mixes MLS numbers and addresses", () => {
    const r = parse("W13503106\n36 Example Ave, Toronto\ntomorrow 6pm");
    expect(r.refs).toEqual(["W13503106", "36 Example Ave, Toronto"]);
  });
});

describe("parseBookingMessage — errors", () => {
  it("errors helpfully when there's no time", () => {
    expect(() => parse("16 Curry Cres")).toThrow(BookingMessageError);
    try {
      parse("16 Curry Cres");
    } catch (e) {
      expect((e as Error).message).toContain("no time");
    }
  });

  it("errors on an empty message", () => {
    expect(() => parse("   ")).toThrow(BookingMessageError);
  });
});
