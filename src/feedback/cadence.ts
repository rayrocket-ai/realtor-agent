/** Follow-up cadence rules for listing-showing feedback. Pure, testable. */

export type BuyerInterest = "hot" | "warm" | "fifty_fifty" | "cold" | "no_response";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Given the interest level and how many follow-ups have already happened,
 * return when to follow up next — or null to stop.
 * Ray's rules: hot = 2 days; warm/fifty-fifty = 1 week, then 1 month, then
 * 3 months; cold = stop; no response = one nudge after 2 days, then stop.
 */
export function nextFollowup(
  interest: BuyerInterest,
  cadenceStage: number,
  now: Date = new Date(),
): Date | null {
  switch (interest) {
    case "hot":
      return cadenceStage < 4 ? new Date(now.getTime() + 2 * DAY) : null;
    case "warm":
    case "fifty_fifty": {
      const gaps = [7 * DAY, 30 * DAY, 90 * DAY];
      const gap = gaps[cadenceStage];
      return gap ? new Date(now.getTime() + gap) : null;
    }
    case "no_response":
      return cadenceStage < 1 ? new Date(now.getTime() + 2 * DAY) : null;
    case "cold":
      return null;
  }
}
