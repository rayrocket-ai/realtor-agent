/** Pure tour-scheduling logic — no I/O, fully unit-testable. */

export interface TourLeg {
  address: string;
  travelMinutesFromPrev: number; // from office for the first leg
  startsAt: Date;
  endsAt: Date;
}

export interface PlanInput {
  /** matrix[0] row/col is the OFFICE; addresses[i] corresponds to matrix index i+1 */
  addresses: string[];
  matrixMinutes: Array<Array<number | null>>;
  windowStart: Date;
  durationMin: number; // per showing
  padMin?: number; // buffer added on top of drive time between legs
}

const DEFAULT_PAD_MIN = 10;

function minutes(matrix: Array<Array<number | null>>, i: number, j: number): number {
  return matrix[i]?.[j] ?? 25;
}

/** Round a date UP to the next quarter hour. */
export function ceilToQuarterHour(d: Date): Date {
  const ms = 15 * 60 * 1000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

/**
 * Greedy nearest-neighbor route starting from the office (index 0), then a
 * forward pass assigning times: each showing starts after the previous ends
 * plus drive time plus padding, rounded to a quarter hour.
 */
export function planTour(input: PlanInput): { legs: TourLeg[]; totalMinutes: number } {
  const pad = input.padMin ?? DEFAULT_PAD_MIN;
  const n = input.addresses.length;
  const unvisited = new Set<number>(Array.from({ length: n }, (_, i) => i + 1)); // matrix indices
  const order: number[] = [];
  let current = 0; // office

  while (unvisited.size) {
    let best = -1;
    let bestMin = Infinity;
    for (const idx of unvisited) {
      const m = minutes(input.matrixMinutes, current, idx);
      if (m < bestMin) {
        bestMin = m;
        best = idx;
      }
    }
    order.push(best);
    unvisited.delete(best);
    current = best;
  }

  const legs: TourLeg[] = [];
  let cursor = ceilToQuarterHour(input.windowStart);
  let prev = 0;
  for (const idx of order) {
    const travel = minutes(input.matrixMinutes, prev, idx);
    const arrive = new Date(cursor.getTime() + (legs.length === 0 ? travel : travel + pad) * 60_000);
    const startsAt = ceilToQuarterHour(arrive);
    const endsAt = new Date(startsAt.getTime() + input.durationMin * 60_000);
    legs.push({
      address: input.addresses[idx - 1]!,
      travelMinutesFromPrev: travel,
      startsAt,
      endsAt,
    });
    cursor = endsAt;
    prev = idx;
  }

  const totalMinutes = legs.length
    ? Math.round((legs[legs.length - 1]!.endsAt.getTime() - input.windowStart.getTime()) / 60_000)
    : 0;
  return { legs, totalMinutes };
}

export function renderItinerary(opts: {
  leadName: string;
  tourDate: string;
  timeZone: string;
  legs: Array<{
    address: string;
    startsAt: Date;
    endsAt: Date;
    travelMinutesFromPrev: number | null;
    lockboxCode?: string | null;
    instructions?: string | null;
    confirmationStatus?: string | null;
  }>;
}): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: opts.timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const lines = [
    `# Showing Tour — ${opts.tourDate} (${opts.leadName})`,
    "",
  ];
  opts.legs.forEach((leg, i) => {
    const rows: Array<string | null> = [
      `## ${i + 1}. ${leg.address}`,
      `- Time: ${fmt.format(leg.startsAt)} – ${fmt.format(leg.endsAt)}`,
      `- Drive: ${leg.travelMinutesFromPrev ?? "?"} min ${i === 0 ? "from office" : "from previous stop"}`,
      `- Status: ${leg.confirmationStatus ?? "pending confirmation"}`,
      leg.lockboxCode ? `- Lockbox: ${leg.lockboxCode}` : `- Lockbox: (not received yet)`,
      leg.instructions ? `- Instructions: ${leg.instructions}` : null,
      "",
    ];
    for (const r of rows) if (r !== null) lines.push(r);
  });
  return lines.join("\n");
}
