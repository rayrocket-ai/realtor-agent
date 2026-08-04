import { describe, expect, it } from "vitest";
import { mergeShowingsIntoReactions, parseProfileJson } from "./profile.js";
import type { PropertyReaction } from "../db/schema.js";

describe("parseProfileJson", () => {
  it("parses a clean JSON profile", () => {
    const parsed = parseProfileJson(
      JSON.stringify({
        isActiveBuyer: true,
        summary: "First-time buyer looking for a condo downtown.",
        requirements: {
          budget: "$700k-$800k",
          areas: ["Liberty Village", "King West"],
          propertyType: "condo",
          bedrooms: "2",
          bathrooms: null,
          preApproved: true,
          timeline: "next 3 months",
          mustHaves: ["parking"],
          dealBreakers: ["ground floor"],
        },
        propertyReactions: [
          { address: "12 Main St", reaction: "liked", notes: "Loved the light" },
          { address: "88 Queen St W", reaction: "disliked", notes: "Too small" },
        ],
        nextAction: "Send new Liberty Village listings",
      }),
    );
    expect(parsed.isActiveBuyer).toBe(true);
    expect(parsed.requirements.budget).toBe("$700k-$800k");
    expect(parsed.requirements.preApproved).toBe(true);
    expect(parsed.propertyReactions).toHaveLength(2);
    expect(parsed.propertyReactions[0].reaction).toBe("liked");
    expect(parsed.nextAction).toBe("Send new Liberty Village listings");
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const parsed = parseProfileJson(
      'Here is the profile:\n```json\n{"isActiveBuyer": false, "summary": "Cooperating agent, not a buyer.", "requirements": {}, "propertyReactions": [], "nextAction": null}\n```',
    );
    expect(parsed.isActiveBuyer).toBe(false);
    expect(parsed.summary).toContain("Cooperating agent");
    expect(parsed.nextAction).toBeNull();
  });

  it("normalizes invalid reactions and drops entries without an address", () => {
    const parsed = parseProfileJson(
      JSON.stringify({
        isActiveBuyer: true,
        summary: "x",
        requirements: { areas: ["Scarborough", 42], preApproved: "yes" },
        propertyReactions: [
          { address: "1 Elm Ave", reaction: "loved-it", notes: 7 },
          { reaction: "liked" },
        ],
        nextAction: "",
      }),
    );
    expect(parsed.requirements.areas).toEqual(["Scarborough"]);
    expect(parsed.requirements.preApproved).toBeNull();
    expect(parsed.propertyReactions).toEqual([
      { address: "1 Elm Ave", reaction: "no_feedback", notes: null },
    ]);
    expect(parsed.nextAction).toBeNull();
  });

  it("throws on output with no JSON object", () => {
    expect(() => parseProfileJson("I could not build a profile.")).toThrow();
  });
});

describe("mergeShowingsIntoReactions", () => {
  const showing = (address: string, daysFromNow: number, status = "completed") => ({
    propertyAddress: address,
    mlsNumber: null,
    startsAt: new Date(Date.now() + daysFromNow * 24 * 3600_000),
    status,
  });

  it("adds shown properties the model did not mention as no_feedback", () => {
    const merged = mergeShowingsIntoReactions([], [showing("55 Oak St, Toronto", -3)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].reaction).toBe("no_feedback");
    expect(merged[0].shownAt).toBe(new Date(Date.now() - 3 * 24 * 3600_000).toISOString().slice(0, 10));
  });

  it("attaches showing dates to matching model reactions instead of duplicating", () => {
    const reactions: PropertyReaction[] = [{ address: "55 Oak St", reaction: "liked", notes: null }];
    const merged = mergeShowingsIntoReactions(reactions, [showing("55 Oak St, Toronto", -3)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].reaction).toBe("liked");
    expect(merged[0].shownAt).toBeTruthy();
  });

  it("skips cancelled showings and marks future ones upcoming", () => {
    const merged = mergeShowingsIntoReactions(
      [],
      [showing("1 Yonge St", -1, "cancelled"), showing("2 Bloor St", 2, "confirmed")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].address).toBe("2 Bloor St");
    expect(merged[0].notes).toBe("Showing upcoming");
  });
});
