import type { VideoPost } from "../db/schema.js";

export interface PlatformStats {
  platform: string;
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagementPct: number | null; // null when there are no views yet
}

/** (likes + comments + shares + saves) / views, as a percentage rounded to 0.1. */
export function engagementPct(p: Pick<VideoPost, "views" | "likes" | "comments" | "shares" | "saves">): number | null {
  if (p.views <= 0) return null;
  return Math.round(((p.likes + p.comments + p.shares + p.saves) / p.views) * 1000) / 10;
}

export function aggregateByPlatform(posts: VideoPost[]): PlatformStats[] {
  const byPlatform = new Map<string, PlatformStats>();
  for (const p of posts) {
    let s = byPlatform.get(p.platform);
    if (!s) {
      s = { platform: p.platform, posts: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, engagementPct: null };
      byPlatform.set(p.platform, s);
    }
    s.posts += 1;
    s.views += p.views;
    s.likes += p.likes;
    s.comments += p.comments;
    s.shares += p.shares;
    s.saves += p.saves;
  }
  for (const s of byPlatform.values()) s.engagementPct = engagementPct(s);
  return [...byPlatform.values()].sort((a, b) => b.views - a.views);
}

/** Total views per video id, for ranking top videos. */
export function viewsByVideo(posts: VideoPost[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const p of posts) totals.set(p.videoId, (totals.get(p.videoId) ?? 0) + p.views);
  return totals;
}
