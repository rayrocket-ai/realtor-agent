import { describe, expect, it } from "vitest";
import {
  ceilToQuarterHour,
  haversineKm,
  orderByDistance,
  planTourRoute,
  travelMinutes,
  type RouteStop,
} from "./geo.js";

// Real GTA coordinates.
const CURRY = { lat: 43.5256, lng: -79.8853 }; // 16 Curry Cres, Halton Hills
const SQUARE_ONE = { lat: 43.593, lng: -79.6425 }; // Mississauga
const DOWNTOWN = { lat: 43.6532, lng: -79.3832 }; // Toronto
const SCARBOROUGH = { lat: 43.7764, lng: -79.2318 };

const stop = (ref: string, point?: { lat: number; lng: number }): RouteStop => ({
  ref,
  address: ref,
  point,
});

describe("haversineKm / travelMinutes", () => {
  it("computes sane GTA distances", () => {
    const km = haversineKm(DOWNTOWN, SCARBOROUGH);
    expect(km).toBeGreaterThan(15);
    expect(km).toBeLessThan(25);
  });
  it("clamps travel time to [10, 90] minutes", () => {
    expect(travelMinutes(0.1)).toBe(10);
    expect(travelMinutes(200)).toBe(90);
    expect(travelMinutes(10)).toBeGreaterThan(15); // ~25 min for 10 km city
  });
});

describe("ceilToQuarterHour", () => {
  it("rounds up to :00/:15/:30/:45 and leaves exact boundaries alone", () => {
    expect(ceilToQuarterHour(new Date("2026-07-07T22:01:00Z")).toISOString()).toBe("2026-07-07T22:15:00.000Z");
    expect(ceilToQuarterHour(new Date("2026-07-07T22:15:00Z")).toISOString()).toBe("2026-07-07T22:15:00.000Z");
    expect(ceilToQuarterHour(new Date("2026-07-07T22:46:10Z")).toISOString()).toBe("2026-07-07T23:00:00.000Z");
  });
});

describe("orderByDistance", () => {
  it("orders a west→east chain correctly regardless of input order", () => {
    const ordered = orderByDistance([
      stop("downtown", DOWNTOWN),
      stop("halton", CURRY),
      stop("scarborough", SCARBOROUGH),
      stop("mississauga", SQUARE_ONE),
    ]);
    const refs = ordered.map((s) => s.ref);
    // Shortest open path is the geographic sweep; either direction is optimal.
    expect([refs.join(","), [...refs].reverse().join(",")]).toContain(
      "halton,mississauga,downtown,scarborough",
    );
  });

  it("keeps the given order when any stop lacks coordinates", () => {
    const ordered = orderByDistance([stop("a", DOWNTOWN), stop("b"), stop("c", CURRY)]);
    expect(ordered.map((s) => s.ref)).toEqual(["a", "b", "c"]);
  });

  it("passes through 1-2 stops untouched", () => {
    expect(orderByDistance([stop("x", CURRY)]).map((s) => s.ref)).toEqual(["x"]);
  });
});

describe("planTourRoute", () => {
  const start = new Date("2026-07-07T22:00:00Z"); // 6:00 PM Toronto (EDT)

  it("first showing starts exactly at the requested time", () => {
    const plan = planTourRoute([stop("a", DOWNTOWN), stop("b", SCARBOROUGH)], start, 30);
    expect(plan[0]!.startsAt.toISOString()).toBe("2026-07-07T22:00:00.000Z");
  });

  it("staggers times by duration + travel, snapped to the 15-min grid", () => {
    const plan = planTourRoute([stop("a", DOWNTOWN), stop("b", SCARBOROUGH)], start, 30);
    // ~19 km → ~42 min travel; 22:00 + 30 min showing + travel → ceil to :15 grid
    const second = plan[1]!;
    expect(second.travelMinFromPrev).toBeGreaterThan(25);
    expect(second.startsAt.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-07-07T23:00:00Z").getTime(),
    );
    expect(second.startsAt.getMinutes() % 15).toBe(0);
    expect(second.distanceKmFromPrev).toBeGreaterThan(10);
  });

  it("uses a default 15-min hop when coordinates are missing", () => {
    const plan = planTourRoute([stop("a"), stop("b"), stop("c")], start, 30);
    expect(plan[1]!.startsAt.toISOString()).toBe("2026-07-07T22:45:00.000Z"); // +30 showing +15 hop
    expect(plan[2]!.startsAt.toISOString()).toBe("2026-07-07T23:30:00.000Z");
  });

  it("a 3-4 home tour starting 6pm ends at a sane hour", () => {
    const plan = planTourRoute(
      [stop("a", CURRY), stop("b", SQUARE_ONE), stop("c", DOWNTOWN), stop("d", SCARBOROUGH)],
      start,
      30,
    );
    const last = plan[plan.length - 1]!;
    // 4 showings with GTA-wide travel should still wrap up the same evening.
    expect(last.startsAt.getTime()).toBeLessThan(new Date("2026-07-08T02:30:00Z").getTime());
    // strictly increasing times
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.startsAt.getTime()).toBeGreaterThan(plan[i - 1]!.startsAt.getTime());
    }
  });
});
