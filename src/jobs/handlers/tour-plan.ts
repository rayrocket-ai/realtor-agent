import { planTour } from "../../booking/tours.js";
import type { JobHandler } from "./index.js";

/**
 * Plan a multi-home tour: resolve listings, order by distance, queue one
 * booking per stop. planTour is idempotent, so queue retries are safe.
 */
export const tourPlanHandler: JobHandler = async (payload) => {
  const tourId = String(payload.tourId ?? "");
  if (!tourId) throw new Error("tour-plan job missing tourId");
  await planTour(tourId);
};
