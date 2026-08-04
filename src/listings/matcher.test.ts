import { describe, expect, it } from "vitest";
import {
  criteriaForRequirements,
  filterFreshListings,
  parseBudget,
  parseMinBedrooms,
} from "./matcher.js";
import type { MlsListing } from "./reso.js";

describe("parseBudget", () => {
  it("parses explicit ranges", () => {
    expect(parseBudget("$700k-$800k")).toEqual({ minPrice: 700_000, maxPrice: 800_000 });
    expect(parseBudget("700 to 900k")).toEqual({ minPrice: 700_000, maxPrice: 900_000 });
    expect(parseBudget("$1.2M - $1.5M")).toEqual({ minPrice: 1_200_000, maxPrice: 1_500_000 });
    // Low bound without a suffix inherits a plausible magnitude.
    expect(parseBudget("$700-800k")).toEqual({ minPrice: 700_000, maxPrice: 800_000 });
  });

  it("parses ceilings and floors", () => {
    expect(parseBudget("under $1.2M")).toEqual({ maxPrice: 1_200_000 });
    expect(parseBudget("max 850k")).toEqual({ maxPrice: 850_000 });
    expect(parseBudget("up to $900,000")).toEqual({ maxPrice: 900_000 });
    expect(parseBudget("at least 600k")).toEqual({ minPrice: 600_000 });
  });

  it("treats a lone figure as a target band, not a ceiling", () => {
    const band = parseBudget("around $800k");
    expect(band.minPrice).toBe(680_000);
    expect(band.maxPrice).toBe(880_000);
  });

  it("returns empty for missing or unparseable budgets", () => {
    expect(parseBudget(null)).toEqual({});
    expect(parseBudget("flexible")).toEqual({});
  });
});

describe("parseMinBedrooms", () => {
  it("extracts the minimum count", () => {
    expect(parseMinBedrooms("2")).toBe(2);
    expect(parseMinBedrooms("3+")).toBe(3);
    expect(parseMinBedrooms("3-4 bedrooms")).toBe(3);
    expect(parseMinBedrooms(null)).toBeUndefined();
    expect(parseMinBedrooms("studio")).toBeUndefined();
  });
});

describe("criteriaForRequirements", () => {
  it("builds one search per area with the parsed budget", () => {
    const searches = criteriaForRequirements({
      budget: "$700k-$800k",
      areas: ["Mississauga", "Oakville"],
      propertyType: "condo",
      bedrooms: "2+",
    });
    expect(searches).toHaveLength(2);
    expect(searches[0]).toMatchObject({
      area: "Mississauga",
      criteria: {
        city: "Mississauga",
        minPrice: 700_000,
        maxPrice: 800_000,
        minBedrooms: 2,
        propertyType: "condo",
        transactionType: "sale",
      },
    });
  });

  it("defaults to a Toronto-wide search when a budget exists but no areas", () => {
    const searches = criteriaForRequirements({ budget: "under 900k" });
    expect(searches).toHaveLength(1);
    expect(searches[0]!.criteria.city).toBe("Toronto");
  });

  it("produces nothing for buyers with neither budget ceiling nor areas", () => {
    expect(criteriaForRequirements({})).toEqual([]);
    expect(criteriaForRequirements({ budget: "over 500k" })).toEqual([]);
  });

  it("caps the number of area searches", () => {
    const searches = criteriaForRequirements({
      budget: "under 1M",
      areas: ["A", "B", "C", "D", "E"],
    });
    expect(searches).toHaveLength(3);
  });
});

describe("filterFreshListings", () => {
  const listing = (key: string, address: string): MlsListing =>
    ({ listingKey: key, address }) as MlsListing;

  it("drops already-pitched listing keys and already-seen addresses", () => {
    const fresh = filterFreshListings(
      [listing("K1", "12 Main St, Toronto"), listing("K2", "99 New Ave, Toronto"), listing("K3", "55 Oak St, Toronto")],
      {
        knownListingKeys: new Set(["K1"]),
        knownAddresses: ["55 Oak St"],
      },
    );
    expect(fresh.map((l) => l.listingKey)).toEqual(["K2"]);
  });

  it("dedupes repeated keys within one batch and drops keyless rows", () => {
    const fresh = filterFreshListings(
      [listing("K1", "1 A St"), listing("K1", "1 A St"), { listingKey: null, address: "2 B St" } as MlsListing],
      { knownListingKeys: new Set(), knownAddresses: [] },
    );
    expect(fresh).toHaveLength(1);
  });
});
