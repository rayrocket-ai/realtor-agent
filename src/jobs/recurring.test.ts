import { describe, expect, it } from "vitest";
import { nextDailyOccurrence, nextWeeklyOccurrence } from "./recurring.js";

const TZ = "America/Toronto";

function weekdayInTz(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short" }).format(date);
}

function hourMinuteInTz(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

describe("nextWeeklyOccurrence", () => {
  // 2026-08-04T12:00:00Z is a Tuesday, 08:00 in Toronto (UTC-4).
  const tuesdayNoonUtc = new Date("2026-08-04T12:00:00Z");

  it("lands on the requested weekday at the requested local time", () => {
    const next = nextWeeklyOccurrence(8, 0, 1, TZ, tuesdayNoonUtc); // Monday 8:00
    expect(weekdayInTz(next)).toBe("Mon");
    expect(hourMinuteInTz(next)).toBe("08:00");
    expect(next.getTime()).toBeGreaterThan(tuesdayNoonUtc.getTime());
    // Next Monday is 6 days out — never more than 7.
    const days = (next.getTime() - tuesdayNoonUtc.getTime()) / (24 * 3600_000);
    expect(days).toBeGreaterThan(5);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("uses today when the time is still ahead on the target weekday", () => {
    // From Tuesday 08:00 local, Tuesday 09:30 is later the same day.
    const next = nextWeeklyOccurrence(9, 30, 2, TZ, tuesdayNoonUtc);
    expect(weekdayInTz(next)).toBe("Tue");
    const hours = (next.getTime() - tuesdayNoonUtc.getTime()) / 3600_000;
    expect(hours).toBeLessThan(24);
  });

  it("rolls a full week when the time has already passed on the target weekday", () => {
    const next = nextWeeklyOccurrence(7, 0, 2, TZ, tuesdayNoonUtc); // Tuesday 7:00 already passed
    expect(weekdayInTz(next)).toBe("Tue");
    const days = (next.getTime() - tuesdayNoonUtc.getTime()) / (24 * 3600_000);
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("agrees with nextDailyOccurrence when the next daily hit is on the target weekday", () => {
    const daily = nextDailyOccurrence(9, 30, TZ, tuesdayNoonUtc);
    const weekly = nextWeeklyOccurrence(9, 30, 2, TZ, tuesdayNoonUtc);
    expect(weekly.getTime()).toBe(daily.getTime());
  });
});
