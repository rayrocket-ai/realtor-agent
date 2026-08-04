import { describe, expect, it } from "vitest";
import { dueTier, REACTIVATION_TIERS } from "./engine.js";

const DAY_MS = 24 * 3600_000;
const now = new Date("2026-08-04T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);

describe("dueTier", () => {
  it("is null while the lead is still fresh", () => {
    expect(dueTier(daysAgo(5), [], now)).toBeNull();
    expect(dueTier(daysAgo(29), [], now)).toBeNull();
  });

  it("fires the 30-day tier once the lead has been quiet a month", () => {
    expect(dueTier(daysAgo(30), [], now)).toBe(30);
    expect(dueTier(daysAgo(45), [], now)).toBe(30);
  });

  it("never repeats a tier already attempted this cycle", () => {
    expect(dueTier(daysAgo(45), [30], now)).toBeNull();
    expect(dueTier(daysAgo(65), [30, 60], now)).toBeNull();
  });

  it("escalates to the next tier as silence grows", () => {
    expect(dueTier(daysAgo(60), [30], now)).toBe(60);
    expect(dueTier(daysAgo(90), [30, 60], now)).toBe(90);
  });

  it("jumps straight to the deepest due tier for very old leads with no attempts", () => {
    // A 100-day-quiet lead gets one 90-day-style message, not three back-to-back.
    expect(dueTier(daysAgo(100), [], now)).toBe(90);
  });

  it("goes silent after the final tier", () => {
    expect(dueTier(daysAgo(200), [90], now)).toBeNull();
    expect(dueTier(daysAgo(200), [...REACTIVATION_TIERS], now)).toBeNull();
  });

  it("resets when engagement is newer than past attempts (caller passes only post-engagement attempts)", () => {
    // Lead replied 31 days ago; earlier attempts are filtered out by the caller,
    // so a fresh cycle starts at the 30-day tier.
    expect(dueTier(daysAgo(31), [], now)).toBe(30);
  });
});
