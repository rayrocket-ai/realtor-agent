/**
 * Tour routing: geocode addresses, order stops by driving distance, and lay
 * showings back-to-back on BrokerBay's 15-minute grid.
 *
 * Geocoding uses OpenStreetMap's Nominatim (free, no key; 1 req/s etiquette).
 * Everything else is pure math so it's fully unit-testable and degrades
 * gracefully: stops that fail to geocode keep their given order.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RouteStop {
  ref: string;
  address: string;
  mlsNumber?: string | null;
  point?: GeoPoint;
}

export interface PlannedStop extends RouteStop {
  startsAt: Date;
  travelMinFromPrev?: number;
  distanceKmFromPrev?: number;
}

/** Great-circle distance in km. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Straight-line km → driving minutes. Roads aren't straight, so pad the
 * distance by 30%, assume ~40 km/h city driving, add 5 min to park/walk in,
 * and clamp to [10, 90].
 */
export function travelMinutes(km: number): number {
  const driveMin = ((km * 1.3) / 40) * 60 + 5;
  return Math.min(90, Math.max(10, Math.round(driveMin)));
}

/** Round a Date UP to the next 15-minute boundary (BrokerBay's slot grid). */
export function ceilToQuarterHour(d: Date): Date {
  const ms = 15 * 60 * 1000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

/**
 * Order stops to minimize total travel distance (open path, any start).
 * Brute force up to 7 stops (720–5040 permutations); nearest-neighbour from
 * the best anchor beyond that. Stops without coordinates keep their original
 * position relative to the ordered ones... in practice: if ANY stop lacks a
 * point, the given order is kept (predictability beats a half-optimized route).
 */
export function orderByDistance(stops: RouteStop[]): RouteStop[] {
  if (stops.length <= 2) return [...stops];
  if (stops.some((s) => !s.point)) return [...stops];
  const pts = stops.map((s) => s.point!);
  const dist = (i: number, j: number) => haversineKm(pts[i]!, pts[j]!);

  const n = stops.length;
  const pathLen = (perm: number[]) => {
    let sum = 0;
    for (let i = 1; i < perm.length; i++) sum += dist(perm[i - 1]!, perm[i]!);
    return sum;
  };

  let best: number[] | null = null;
  let bestLen = Infinity;
  if (n <= 7) {
    const perm = Array.from({ length: n }, (_, i) => i);
    const permute = (k: number) => {
      if (k === n) {
        const len = pathLen(perm);
        if (len < bestLen) {
          bestLen = len;
          best = [...perm];
        }
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        permute(k + 1);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    permute(0);
  } else {
    // Nearest-neighbour from every anchor, keep the shortest.
    for (let anchor = 0; anchor < n; anchor++) {
      const remaining = new Set(Array.from({ length: n }, (_, i) => i));
      remaining.delete(anchor);
      const path = [anchor];
      while (remaining.size) {
        const cur = path[path.length - 1]!;
        let nearest = -1;
        let nd = Infinity;
        for (const j of remaining) {
          const d = dist(cur, j);
          if (d < nd) {
            nd = d;
            nearest = j;
          }
        }
        path.push(nearest);
        remaining.delete(nearest);
      }
      const len = pathLen(path);
      if (len < bestLen) {
        bestLen = len;
        best = path;
      }
    }
  }
  return (best ?? stops.map((_, i) => i)).map((i: number) => stops[i]!);
}

/**
 * Turn ordered stops into a timed itinerary: first showing at `start`, each
 * next one after the previous showing's duration plus travel time, snapped up
 * to the 15-minute grid. Without coordinates the gap defaults to 15 minutes.
 */
export function scheduleStops(ordered: RouteStop[], start: Date, durationMin: number): PlannedStop[] {
  const out: PlannedStop[] = [];
  let cursor = ceilToQuarterHour(start);
  for (let i = 0; i < ordered.length; i++) {
    const stop = ordered[i]!;
    let travelMin: number | undefined;
    let distanceKm: number | undefined;
    if (i > 0) {
      const prev = ordered[i - 1]!;
      if (prev.point && stop.point) {
        distanceKm = Math.round(haversineKm(prev.point, stop.point) * 10) / 10;
        travelMin = travelMinutes(distanceKm);
      } else {
        travelMin = 15; // no coordinates — assume a short hop
      }
      cursor = ceilToQuarterHour(new Date(cursor.getTime() + (durationMin + travelMin) * 60_000));
    }
    out.push({ ...stop, startsAt: cursor, travelMinFromPrev: travelMin, distanceKmFromPrev: distanceKm });
  }
  return out;
}

/** Plan a tour: order by distance, then lay out the times. */
export function planTourRoute(stops: RouteStop[], start: Date, durationMin: number): PlannedStop[] {
  return scheduleStops(orderByDistance(stops), start, durationMin);
}

/**
 * Geocode an address via Nominatim. Returns null on any failure — the tour
 * still books, just without distance ordering. Biased to Ontario, Canada.
 */
export async function geocode(address: string, fetchImpl: typeof fetch = fetch): Promise<GeoPoint | null> {
  try {
    const q = /ontario|,\s*on\b|canada/i.test(address) ? address : `${address}, Ontario, Canada`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca&q=${encodeURIComponent(q)}`;
    const res = await fetchImpl(url, {
      headers: { "user-agent": "realtor-agent/0.1 (showing tour planner)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return { lat: Number(data[0]!.lat), lng: Number(data[0]!.lon) };
  } catch {
    return null;
  }
}
