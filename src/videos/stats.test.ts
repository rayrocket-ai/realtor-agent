import { describe, expect, it } from "vitest";
import { aggregateByPlatform, engagementPct, viewsByVideo } from "./stats.js";
import type { VideoPost } from "../db/schema.js";

function post(overrides: Partial<VideoPost>): VideoPost {
  return {
    id: "p1",
    videoId: "v1",
    platform: "tiktok",
    url: null,
    caption: null,
    postedAt: new Date(),
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    statsUpdatedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("engagementPct", () => {
  it("computes (likes+comments+shares+saves)/views as a percentage", () => {
    expect(engagementPct(post({ views: 1000, likes: 80, comments: 10, shares: 5, saves: 5 }))).toBe(10);
  });

  it("returns null when there are no views (no divide-by-zero)", () => {
    expect(engagementPct(post({ views: 0, likes: 50 }))).toBeNull();
  });

  it("rounds to one decimal place", () => {
    expect(engagementPct(post({ views: 300, likes: 10 }))).toBe(3.3);
  });
});

describe("aggregateByPlatform", () => {
  it("sums per platform and sorts by views descending", () => {
    const rows = aggregateByPlatform([
      post({ platform: "instagram_reels", views: 100, likes: 10 }),
      post({ platform: "tiktok", views: 500, likes: 20 }),
      post({ platform: "instagram_reels", views: 300, comments: 5 }),
    ]);
    expect(rows.map((r) => r.platform)).toEqual(["tiktok", "instagram_reels"]);
    expect(rows[1]).toMatchObject({ posts: 2, views: 400, likes: 10, comments: 5 });
    expect(rows[1].engagementPct).toBe(3.8); // 15 / 400
  });

  it("returns an empty array for no posts", () => {
    expect(aggregateByPlatform([])).toEqual([]);
  });
});

describe("viewsByVideo", () => {
  it("totals views across a video's posts", () => {
    const totals = viewsByVideo([
      post({ videoId: "a", views: 100 }),
      post({ videoId: "a", views: 50 }),
      post({ videoId: "b", views: 10 }),
    ]);
    expect(totals.get("a")).toBe(150);
    expect(totals.get("b")).toBe(10);
  });
});
