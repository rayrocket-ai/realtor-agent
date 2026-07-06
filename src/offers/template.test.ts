import { describe, expect, it } from "vitest";
import { renderOfferSummary, offerShortId } from "./template.js";

describe("renderOfferSummary", () => {
  it("renders all provided terms with OREA section mapping", () => {
    const md = renderOfferSummary({
      buyerName: "Jane Buyer",
      propertyAddress: "12 Main St, Toronto",
      mlsNumber: "C1234567",
      terms: {
        price: 850000,
        deposit: 40000,
        irrevocableDate: "2026-07-06 11:59 PM",
        completionDate: "2026-09-15",
        conditions: ["financing (5 business days)", "home inspection"],
        inclusions: "fridge, stove",
      },
    });
    expect(md).toContain("12 Main St, Toronto");
    expect(md).toContain("MLS®: C1234567");
    expect(md).toContain("$850,000");
    expect(md).toContain("$40,000");
    expect(md).toContain("financing (5 business days); home inspection");
    expect(md).toContain("OREA Form 100");
    expect(md).toContain("fridge, stove");
  });

  it("marks a firm offer when there are no conditions", () => {
    const md = renderOfferSummary({
      buyerName: "B",
      propertyAddress: "1 A St",
      terms: {
        price: 500000,
        deposit: 25000,
        irrevocableDate: "x",
        completionDate: "y",
        conditions: [],
      },
    });
    expect(md).toContain("None (firm offer)");
  });
});

describe("offerShortId", () => {
  it("is 8 lowercase hex chars, stable for a given uuid", () => {
    const id = "A1B2C3D4-E5F6-7890-ABCD-EF0123456789";
    expect(offerShortId(id)).toBe("a1b2c3d4");
    expect(offerShortId(id)).toBe(offerShortId(id));
  });
});
