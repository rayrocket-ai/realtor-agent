import { runListingMatcher } from "../../listings/matcher.js";
import type { JobHandler } from "./index.js";

/** Daily 9:00am: pitch fresh MLS listings that match each active buyer's profile. */
export const listingMatcherHandler: JobHandler = async () => {
  const { buyersMessaged, matches } = await runListingMatcher();
  console.log(`[matcher] ${matches} new listing matches across ${buyersMessaged} buyers`);
};
