import { describe, expect, it } from "vitest";
import { nextFollowup } from "./cadence.js";

const now = new Date("2026-07-10T12:00:00Z");
const days = (d: Date | null) => (d ? Math.round((d.getTime() - now.getTime()) / 86_400_000) : null);

describe("nextFollowup — Ray's rules", () => {
  it("hot buyers: every 2 days, capped", () => {
    expect(days(nextFollowup("hot", 0, now))).toBe(2);
    expect(days(nextFollowup("hot", 3, now))).toBe(2);
    expect(nextFollowup("hot", 4, now)).toBeNull();
  });
  it("fifty-fifty: 1 week, then 1 month, then 3 months, then stop", () => {
    expect(days(nextFollowup("fifty_fifty", 0, now))).toBe(7);
    expect(days(nextFollowup("fifty_fifty", 1, now))).toBe(30);
    expect(days(nextFollowup("fifty_fifty", 2, now))).toBe(90);
    expect(nextFollowup("fifty_fifty", 3, now)).toBeNull();
  });
  it("warm follows the same ladder as fifty-fifty", () => {
    expect(days(nextFollowup("warm", 0, now))).toBe(7);
  });
  it("cold: eliminated immediately", () => {
    expect(nextFollowup("cold", 0, now)).toBeNull();
  });
  it("no response: one nudge after 2 days, then stop", () => {
    expect(days(nextFollowup("no_response", 0, now))).toBe(2);
    expect(nextFollowup("no_response", 1, now)).toBeNull();
  });
});
