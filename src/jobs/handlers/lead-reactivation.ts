import {
  DAILY_REACTIVATION_CAP,
  reactivateLead,
  reactivationCandidates,
} from "../../reactivation/engine.js";
import type { JobHandler } from "./index.js";

/** Daily 10:00am: re-engage leads that have gone quiet for 30/60/90 days. */
export const leadReactivationHandler: JobHandler = async () => {
  const candidates = await reactivationCandidates();
  let drafted = 0;
  let notified = 0;
  let processed = 0;
  for (const candidate of candidates) {
    if (processed >= DAILY_REACTIVATION_CAP) break;
    const outcome = await reactivateLead(candidate);
    if (outcome === "skipped") continue;
    processed++;
    if (outcome === "drafted") drafted++;
    else notified++;
  }
  const remaining = candidates.length - processed;
  console.log(
    `[reactivation] ${drafted} re-engagement drafts, ${notified} realtor notifications` +
      (remaining > 0 ? `, ${remaining} candidates deferred to the next daily run` : ""),
  );
};
