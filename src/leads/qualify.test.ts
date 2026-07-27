import { describe, expect, it } from "vitest";
import { buildSummary, nurtureDelayDays, scoreSubmission, submissionSchema } from "./qualify.js";

const base = { name: "Ahmad Wali", phone: "+1 416 555 0100" };

describe("submissionSchema", () => {
  it("accepts a minimal valid buying submission", () => {
    const r = submissionSchema.safeParse({ ...base, intent: "buying", language: "prs" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.language).toBe("prs");
  });

  it("requires at least a phone or an email", () => {
    const r = submissionSchema.safeParse({ intent: "general", language: "en", name: "X", message: "hi" });
    expect(r.success).toBe(false);
  });

  it("treats empty-string email/phone as missing", () => {
    const r = submissionSchema.safeParse({
      intent: "general",
      name: "X",
      email: "x@example.com",
      phone: "",
      message: "hi",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBeUndefined();
  });

  it("lowercases email and rejects malformed ones", () => {
    const ok = submissionSchema.safeParse({ intent: "general", name: "X", email: "A@B.CO" });
    expect(ok.success && ok.data.email).toBe("a@b.co");
    const bad = submissionSchema.safeParse({ intent: "general", name: "X", email: "not-an-email" });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown intents and oversized answer sets", () => {
    expect(submissionSchema.safeParse({ ...base, intent: "renting" }).success).toBe(false);
    const answers = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, "v"]));
    expect(submissionSchema.safeParse({ ...base, intent: "buying", answers }).success).toBe(false);
  });
});

describe("scoreSubmission", () => {
  const sub = (intent: "buying" | "selling" | "general", answers: Record<string, string>) =>
    submissionSchema.parse({ ...base, intent, answers });

  it("buyer ready soon + pre-approved is hot", () => {
    expect(scoreSubmission(sub("buying", { timeline: "asap", preapproved: "yes" }))).toBe("hot");
    expect(scoreSubmission(sub("buying", { timeline: "0_3", preapproved: "cash" }))).toBe("hot");
  });

  it("buyer just researching without financing is cold", () => {
    expect(scoreSubmission(sub("buying", { timeline: "researching", preapproved: "not_yet" }))).toBe("cold");
  });

  it("everything else buying is warm", () => {
    expect(scoreSubmission(sub("buying", { timeline: "6_12", preapproved: "yes" }))).toBe("warm");
    expect(scoreSubmission(sub("buying", { timeline: "asap", preapproved: "not_yet" }))).toBe("warm");
  });

  it("seller timelines map to hot/warm/cold", () => {
    expect(scoreSubmission(sub("selling", { timeline: "asap" }))).toBe("hot");
    expect(scoreSubmission(sub("selling", { timeline: "1_3" }))).toBe("hot");
    expect(scoreSubmission(sub("selling", { timeline: "3_6" }))).toBe("warm");
    expect(scoreSubmission(sub("selling", { timeline: "curious" }))).toBe("cold");
  });

  it("general inquiries default to warm", () => {
    expect(scoreSubmission(sub("general", {}))).toBe("warm");
  });
});

describe("nurtureDelayDays", () => {
  it("checks in faster the hotter the lead", () => {
    expect(nurtureDelayDays("hot")).toBe(1);
    expect(nurtureDelayDays("warm")).toBe(3);
    expect(nurtureDelayDays("cold")).toBe(7);
    expect(nurtureDelayDays("hot")).toBeLessThan(nurtureDelayDays("warm"));
    expect(nurtureDelayDays("warm")).toBeLessThan(nurtureDelayDays("cold"));
  });
});

describe("buildSummary", () => {
  it("includes intent, language instruction, score, and readable answers", () => {
    const s = submissionSchema.parse({
      ...base,
      intent: "buying",
      language: "prs",
      contactMethod: "whatsapp",
      source: "instagram",
      answers: { timeline: "0_3", preapproved: "yes", budget: "500_750k", areas: "Vaughan" },
      message: "Looking near good schools",
    });
    const out = buildSummary(s, scoreSubmission(s));
    expect(out).toContain("via instagram");
    expect(out).toContain("Intent: Buying");
    expect(out).toContain("Dari (reply in Dari)");
    expect(out).toContain("Qualification: HOT");
    expect(out).toContain("Timeline: 0–3 months");
    expect(out).toContain("Budget: $500k–$750k");
    expect(out).toContain("Areas of interest: Vaughan");
    expect(out).toContain("Message: Looking near good schools");
  });
});
