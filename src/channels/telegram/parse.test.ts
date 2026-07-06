import { describe, expect, it } from "vitest";
import { parseBookingMessage, BookingMessageError } from "./parse.js";

const TZ = "America/Toronto";
const NOW = new Date("2026-07-06T14:00:00Z"); // Mon 10:00 Toronto

const parse = (s: string) => parseBookingMessage(s, { tz: TZ, now: NOW });

describe("parseBookingMessage", () => {
  it("splits address and time on a plain message", () => {
    const r = parse("16 Curry Cres tomorrow 5pm");
    expect(r.address).toBe("16 Curry Cres");
    expect(r.start.toISOString()).toBe("2026-07-07T21:00:00.000Z");
    expect(r.dryRun).toBe(false);
  });

  it("keeps the street number with the address, not the time", () => {
    const r = parse("5 Main St tomorrow 2pm");
    expect(r.address).toBe("5 Main St");
    expect(r.start.toISOString()).toBe("2026-07-07T18:00:00.000Z");
  });

  it("handles a comma between address and time", () => {
    const r = parse("36 Example Ave, Toronto, sat 1:30pm");
    expect(r.address).toBe("36 Example Ave, Toronto");
    expect(r.start.toISOString()).toBe("2026-07-11T17:30:00.000Z");
  });

  it("handles an explicit date", () => {
    const r = parse("12 King St W 2026-07-08 14:00");
    expect(r.address).toBe("12 King St W");
    expect(r.start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
  });

  it("does not mistake a weekday-like street name for the time", () => {
    const r = parse("10 Sunset Blvd tomorrow 6pm");
    expect(r.address).toBe("10 Sunset Blvd");
    expect(r.start.toISOString()).toBe("2026-07-07T22:00:00.000Z");
  });

  it("pulls out an explicit duration", () => {
    const r = parse("16 Curry Cres tomorrow 5pm for 45 min");
    expect(r.address).toBe("16 Curry Cres");
    expect(r.durationMin).toBe(45);
    expect(r.start.toISOString()).toBe("2026-07-07T21:00:00.000Z");
  });

  it("recognizes a dry-run modifier anywhere", () => {
    const r = parse("dry run 16 Curry Cres tomorrow 5pm");
    expect(r.address).toBe("16 Curry Cres");
    expect(r.dryRun).toBe(true);
  });

  it("supports an explicit pipe separator", () => {
    const r = parse("Unit 5 - 88 Queen St W | jul 8 2pm");
    expect(r.address).toBe("Unit 5 - 88 Queen St W");
    expect(r.start.toISOString()).toBe("2026-07-08T18:00:00.000Z");
  });

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
