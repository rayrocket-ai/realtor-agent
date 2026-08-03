import type { MlsListing } from "./reso.js";

export type MlsPurpose = "consumer_search" | "property_research" | "comparable_analysis" | "showing_workflow";

/**
 * Fields safe to expose to the general conversation model. Private showing and
 * offer instructions are deliberately available only to purpose-built,
 * human-authorized workflows.
 */
export function listingForModel(listing: MlsListing): Omit<MlsListing, "showingRequirements" | "offerRemarks"> {
  const { showingRequirements: _showing, offerRemarks: _offer, ...safe } = listing;
  return safe;
}

export function listingsForModel(listings: MlsListing[]) {
  return listings.map(listingForModel);
}

export function assertPrivateFieldPurpose(purpose: MlsPurpose): void {
  if (purpose !== "showing_workflow") {
    throw new Error("Private MLS instructions require an authorized showing workflow.");
  }
}

