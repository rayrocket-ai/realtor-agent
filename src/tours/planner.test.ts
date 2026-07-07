import { describe, expect, it } from "vitest";
import { planTour, ceilToQuarterHour, renderItinerary } from "./planner.js";

describe("planTour", () => {
  // matrix index 0 = office; 1..3 = addresses A, B, C
  const matrix = [
    [0, 30, 10, 20], // office -> A 30, B 10, C 20
    [30, 0, 25, 5],
    [10, 25, 0, 15],
    [20, 5, 15, 0],
  ];

  it("orders stops nearest-neighbor from the office", () => {
    const { legs } = planTour({
      addresses: ["A", "B", "C"],
      matrixMinutes: matrix,
      windowStart: new Date("2026-07-11T14:00:00Z"),
      durationMin: 30,
    });
    // office->B (10) then B->C (15) then C->A (5)
    expect(legs.map((l) => l.address)).toEqual(["B", "C", "A"]);
    expect(legs.map((l) => l.travelMinutesFromPrev)).toEqual([10, 15, 5]);
  });

  it("assigns increasing quarter-hour times with drive + padding", () => {
    const { legs, totalMinutes } = planTour({
      addresses: ["A", "B", "C"],
      matrixMinutes: matrix,
      windowStart: new Date("2026-07-11T14:00:00Z"),
      durationMin: 30,
      padMin: 10,
    });
    for (const leg of legs) {
      expect(leg.startsAt.getMinutes() % 15).toBe(0);
      expect(leg.endsAt.getTime()).toBe(leg.startsAt.getTime() + 30 * 60_000);
    }
    for (let i = 1; i < legs.length; i++) {
      const gapMin = (legs[i]!.startsAt.getTime() - legs[i - 1]!.endsAt.getTime()) / 60_000;
      expect(gapMin).toBeGreaterThanOrEqual(legs[i]!.travelMinutesFromPrev);
    }
    expect(totalMinutes).toBeGreaterThan(90); // 3 showings + driving
  });

  it("falls back to a default when the matrix has nulls", () => {
    const { legs } = planTour({
      addresses: ["A"],
      matrixMinutes: [
        [0, null],
        [null, 0],
      ],
      windowStart: new Date("2026-07-11T14:00:00Z"),
      durationMin: 30,
    });
    expect(legs[0]!.travelMinutesFromPrev).toBe(25);
  });
});

describe("ceilToQuarterHour", () => {
  it("rounds up to :00/:15/:30/:45", () => {
    expect(ceilToQuarterHour(new Date("2026-07-11T14:01:00Z")).toISOString()).toContain("14:15");
    expect(ceilToQuarterHour(new Date("2026-07-11T14:15:00Z")).toISOString()).toContain("14:15");
  });
});

describe("renderItinerary", () => {
  it("includes lockboxes, times and drive legs", () => {
    const md = renderItinerary({
      leadName: "Maya",
      tourDate: "2026-07-11",
      timeZone: "America/Toronto",
      legs: [
        {
          address: "12 Main St",
          startsAt: new Date("2026-07-11T14:15:00Z"),
          endsAt: new Date("2026-07-11T14:45:00Z"),
          travelMinutesFromPrev: 20,
          lockboxCode: "1234",
          instructions: "Remove shoes",
          confirmationStatus: "confirmed",
        },
      ],
    });
    expect(md).toContain("12 Main St");
    expect(md).toContain("Lockbox: 1234");
    expect(md).toContain("Remove shoes");
    expect(md).toContain("from office");
  });
});
