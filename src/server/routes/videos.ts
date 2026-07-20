import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { escapeHtml as esc } from "./approvals.js";
import { layout, fmt } from "./dashboard.js";
import { aggregateByPlatform, engagementPct, viewsByVideo } from "../../videos/stats.js";

const STATUSES = ["shot", "editing", "edited", "posted"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABEL: Record<Status, string> = {
  shot: "🎥 Shot — needs edit",
  editing: "✂️ Editing",
  edited: "✅ Edited — ready to post",
  posted: "🚀 Posted",
};

const NEXT_STATUS: Partial<Record<Status, Status>> = {
  shot: "editing",
  editing: "edited",
  edited: "posted",
};

const CATEGORIES: Record<string, string> = {
  listing_tour: "Listing Tour",
  market_update: "Market Update",
  tips_advice: "Tips & Advice",
  behind_the_scenes: "Behind the Scenes",
  client_story: "Client Story",
  neighborhood: "Neighborhood Spotlight",
  other: "Other",
};

const PLATFORMS: Record<string, string> = {
  instagram_reels: "Instagram Reels",
  tiktok: "TikTok",
  youtube: "YouTube",
  youtube_shorts: "YouTube Shorts",
  facebook: "Facebook",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
};

function statusPill(status: string): string {
  const colors: Record<string, string> = {
    shot: "#fee2e2",
    editing: "#ffedd5",
    edited: "#fef9c3",
    posted: "#dcfce7",
  };
  const label = STATUS_LABEL[status as Status] ?? status;
  return `<span class="pill" style="background:${colors[status] ?? "#e5e7eb"}">${esc(label)}</span>`;
}

function options(map: Record<string, string>, selected?: string): string {
  return Object.entries(map)
    .map(([k, v]) => `<option value="${k}"${k === selected ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
}

function toInt(v: unknown): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseDate(v: unknown): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", app.basicAuth);

  // Pipeline board: every video grouped by status.
  app.get("/", async (_req, reply) => {
    const d = db();
    const vids = await d.query.videos.findMany({ orderBy: desc(schema.videos.updatedAt), limit: 500 });
    const posts = vids.length
      ? await d.query.videoPosts.findMany({
          where: inArray(schema.videoPosts.videoId, vids.map((v) => v.id)),
        })
      : [];
    const totals = viewsByVideo(posts);
    const postCount = new Map<string, number>();
    for (const p of posts) postCount.set(p.videoId, (postCount.get(p.videoId) ?? 0) + 1);

    const sections = STATUSES.map((status) => {
      const rows = vids.filter((v) => v.status === status);
      const table = rows.length
        ? `<table><tr><th>Title</th><th>Category</th><th>Shot</th><th>Posts</th><th>Views</th></tr>
          ${rows
            .map(
              (v) => `<tr>
                <td><a href="/admin/videos/${v.id}">${esc(v.title)}</a></td>
                <td>${esc(CATEGORIES[v.category] ?? v.category)}</td>
                <td>${fmt(v.shotAt)}</td>
                <td>${postCount.get(v.id) ?? 0}</td>
                <td>${(totals.get(v.id) ?? 0).toLocaleString("en-CA")}</td>
              </tr>`,
            )
            .join("")}</table>`
        : '<p class="muted">Nothing here.</p>';
      return `<h3>${statusPill(status)} <span class="muted">(${rows.length})</span></h3>${table}`;
    }).join("");

    const body = `
      <p><a href="/admin/videos/analytics">📊 Analytics →</a></p>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
        <h3 style="margin-top:0">Add a video you just shot</h3>
        <form method="post" action="/admin/videos">
          <p><label>Title<br><input type="text" name="title" required placeholder="e.g. Downtown loft tour — 2BR with skyline views"></label></p>
          <p><label>Category<br><select name="category">${options(CATEGORIES)}</select></label>
             <label>Shot on<br><input type="date" name="shotAt"></label></p>
          <p><label>Notes<br><input type="text" name="notes" placeholder="anything to remember for the edit"></label></p>
          <button class="btn approve" type="submit">Add to pipeline</button>
        </form>
      </div>
      ${sections}`;
    reply.type("text/html");
    return layout("Videos", body);
  });

  app.post<{ Body: { title?: string; category?: string; shotAt?: string; notes?: string } }>(
    "/",
    async (req, reply) => {
      const title = (req.body?.title ?? "").trim();
      if (title) {
        const category = req.body?.category && CATEGORIES[req.body.category] ? req.body.category : "other";
        await db()
          .insert(schema.videos)
          .values({
            title,
            category,
            shotAt: parseDate(req.body?.shotAt),
            notes: (req.body?.notes ?? "").trim() || null,
          });
      }
      return reply.redirect("/admin/videos");
    },
  );

  // Analytics: platform totals + top videos, so posting strategy is data-driven.
  app.get("/analytics", async (_req, reply) => {
    const d = db();
    const posts = await d.query.videoPosts.findMany();
    const vids = await d.query.videos.findMany();
    const byPlatform = aggregateByPlatform(posts);
    const maxViews = Math.max(1, ...byPlatform.map((s) => s.views));

    const platformTable = byPlatform.length
      ? `<table><tr><th>Platform</th><th>Posts</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th><th>Engagement</th><th></th></tr>
        ${byPlatform
          .map(
            (s) => `<tr>
              <td>${esc(PLATFORMS[s.platform] ?? s.platform)}</td>
              <td>${s.posts}</td><td>${s.views.toLocaleString("en-CA")}</td>
              <td>${s.likes.toLocaleString("en-CA")}</td><td>${s.comments.toLocaleString("en-CA")}</td>
              <td>${s.shares.toLocaleString("en-CA")}</td><td>${s.saves.toLocaleString("en-CA")}</td>
              <td>${s.engagementPct === null ? "—" : `${s.engagementPct}%`}</td>
              <td style="min-width:120px"><div style="background:#2563eb;height:10px;border-radius:5px;width:${Math.round((s.views / maxViews) * 100)}%"></div></td>
            </tr>`,
          )
          .join("")}</table>`
      : '<p class="muted">No posts logged yet — add posts from a video\'s page.</p>';

    const totals = viewsByVideo(posts);
    const top = vids
      .map((v) => ({ v, views: totals.get(v.id) ?? 0 }))
      .filter((r) => r.views > 0)
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);
    const topTable = top.length
      ? `<table><tr><th>#</th><th>Video</th><th>Category</th><th>Total views</th></tr>
        ${top
          .map(
            (r, i) => `<tr><td>${i + 1}</td>
              <td><a href="/admin/videos/${r.v.id}">${esc(r.v.title)}</a></td>
              <td>${esc(CATEGORIES[r.v.category] ?? r.v.category)}</td>
              <td>${r.views.toLocaleString("en-CA")}</td></tr>`,
          )
          .join("")}</table>`
      : '<p class="muted">No views logged yet.</p>';

    const body = `
      <p><a href="/admin/videos">← Pipeline</a></p>
      <h3>By platform</h3>${platformTable}
      <h3>Top videos by views</h3>${topTable}
      <p class="muted">Engagement = (likes + comments + shares + saves) ÷ views. Update the numbers on each video's page whenever you check your stats.</p>`;
    reply.type("text/html");
    return layout("Video analytics", body);
  });

  // Video detail: edit it, move it through the pipeline, log posts + stats.
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const d = db();
    const video = await d.query.videos.findFirst({ where: eq(schema.videos.id, req.params.id) });
    reply.type("text/html");
    if (!video) return layout("Not found", '<p>Video not found. <a href="/admin/videos">Back</a></p>');

    const posts = await d.query.videoPosts.findMany({
      where: eq(schema.videoPosts.videoId, video.id),
      orderBy: desc(schema.videoPosts.postedAt),
    });

    const next = NEXT_STATUS[video.status as Status];
    const postCards = posts
      .map((p) => {
        const eng = engagementPct(p);
        return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:12px 0">
          <p style="margin-top:0"><strong>${esc(PLATFORMS[p.platform] ?? p.platform)}</strong>
            <span class="muted">posted ${fmt(p.postedAt)}</span>
            ${p.url ? ` — <a href="${esc(p.url)}" target="_blank" rel="noopener">open ↗</a>` : ""}</p>
          ${p.caption ? `<p class="muted">${esc(p.caption)}</p>` : ""}
          <form method="post" action="/admin/videos/posts/${p.id}/stats">
            <p>
              <label>Views <input type="number" name="views" min="0" value="${p.views}" style="width:90px"></label>
              <label>Likes <input type="number" name="likes" min="0" value="${p.likes}" style="width:90px"></label>
              <label>Comments <input type="number" name="comments" min="0" value="${p.comments}" style="width:90px"></label>
              <label>Shares <input type="number" name="shares" min="0" value="${p.shares}" style="width:90px"></label>
              <label>Saves <input type="number" name="saves" min="0" value="${p.saves}" style="width:90px"></label>
            </p>
            <button class="btn neutral" type="submit">Update stats</button>
            <span class="muted">${eng === null ? "" : `engagement ${eng}%`}${p.statsUpdatedAt ? ` · last checked ${fmt(p.statsUpdatedAt)}` : ""}</span>
          </form>
          <form class="inline" method="post" action="/admin/videos/posts/${p.id}/delete"
                onsubmit="return confirm('Delete this post entry?')">
            <button class="btn reject" type="submit">Delete post entry</button>
          </form>
        </div>`;
      })
      .join("");

    const body = `
      <p><a href="/admin/videos">← Pipeline</a></p>
      <p>${statusPill(video.status)}
        ${next ? `<form class="inline" method="post" action="/admin/videos/${video.id}/status">
          <input type="hidden" name="status" value="${next}">
          <button class="btn approve" type="submit">Move to “${esc(STATUS_LABEL[next])}”</button>
        </form>` : ""}
      </p>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
        <h3 style="margin-top:0">Details</h3>
        <form method="post" action="/admin/videos/${video.id}/update">
          <p><label>Title<br><input type="text" name="title" value="${esc(video.title)}" required></label></p>
          <p><label>Category<br><select name="category">${options(CATEGORIES, video.category)}</select></label>
             <label>Status<br><select name="status">${STATUSES.map((s) => `<option value="${s}"${s === video.status ? " selected" : ""}>${esc(STATUS_LABEL[s])}</option>`).join("")}</select></label>
             <label>Shot on<br><input type="date" name="shotAt" value="${video.shotAt ? video.shotAt.toISOString().slice(0, 10) : ""}"></label></p>
          <p><label>Notes<br><textarea name="notes" rows="3">${esc(video.notes ?? "")}</textarea></label></p>
          <button class="btn approve" type="submit">Save</button>
        </form>
      </div>
      <h3>Posts (${posts.length})</h3>
      ${postCards || '<p class="muted">Not posted anywhere yet.</p>'}
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
        <h3 style="margin-top:0">Log a post</h3>
        <p class="muted">Add one entry per platform you publish this video to. Marking a post also moves the video to “Posted”.</p>
        <form method="post" action="/admin/videos/${video.id}/posts">
          <p><label>Platform<br><select name="platform">${options(PLATFORMS)}</select></label>
             <label>Posted on<br><input type="date" name="postedAt"></label></p>
          <p><label>Link<br><input type="text" name="url" placeholder="https://…"></label></p>
          <p><label>Caption / hook used<br><input type="text" name="caption"></label></p>
          <button class="btn approve" type="submit">Log post</button>
        </form>
      </div>
      <form class="inline" method="post" action="/admin/videos/${video.id}/delete"
            onsubmit="return confirm('Delete this video and all its post entries?')">
        <button class="btn reject" type="submit">Delete video</button>
      </form>`;
    return layout(video.title, body);
  });

  app.post<{ Params: { id: string }; Body: { title?: string; category?: string; status?: string; shotAt?: string; notes?: string } }>(
    "/:id/update",
    async (req, reply) => {
      const title = (req.body?.title ?? "").trim();
      const status = STATUSES.includes(req.body?.status as Status) ? (req.body!.status as Status) : undefined;
      const category = req.body?.category && CATEGORIES[req.body.category] ? req.body.category : undefined;
      await db()
        .update(schema.videos)
        .set({
          ...(title ? { title } : {}),
          ...(category ? { category } : {}),
          ...(status ? { status } : {}),
          shotAt: parseDate(req.body?.shotAt),
          notes: (req.body?.notes ?? "").trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(schema.videos.id, req.params.id));
      return reply.redirect(`/admin/videos/${req.params.id}`);
    },
  );

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/:id/status", async (req, reply) => {
    if (STATUSES.includes(req.body?.status as Status)) {
      await db()
        .update(schema.videos)
        .set({ status: req.body!.status as Status, updatedAt: new Date() })
        .where(eq(schema.videos.id, req.params.id));
    }
    return reply.redirect(`/admin/videos/${req.params.id}`);
  });

  app.post<{ Params: { id: string } }>("/:id/delete", async (req, reply) => {
    await db().delete(schema.videos).where(eq(schema.videos.id, req.params.id));
    return reply.redirect("/admin/videos");
  });

  app.post<{ Params: { id: string }; Body: { platform?: string; postedAt?: string; url?: string; caption?: string } }>(
    "/:id/posts",
    async (req, reply) => {
      const d = db();
      const video = await d.query.videos.findFirst({ where: eq(schema.videos.id, req.params.id) });
      if (video) {
        const platform = req.body?.platform && PLATFORMS[req.body.platform] ? req.body.platform : "other";
        await d.insert(schema.videoPosts).values({
          videoId: video.id,
          platform,
          postedAt: parseDate(req.body?.postedAt) ?? new Date(),
          url: (req.body?.url ?? "").trim() || null,
          caption: (req.body?.caption ?? "").trim() || null,
        });
        if (video.status !== "posted") {
          await d
            .update(schema.videos)
            .set({ status: "posted", updatedAt: new Date() })
            .where(eq(schema.videos.id, video.id));
        }
      }
      return reply.redirect(`/admin/videos/${req.params.id}`);
    },
  );

  app.post<{ Params: { postId: string }; Body: Record<string, unknown> }>(
    "/posts/:postId/stats",
    async (req, reply) => {
      const d = db();
      const post = await d.query.videoPosts.findFirst({ where: eq(schema.videoPosts.id, req.params.postId) });
      if (post) {
        await d
          .update(schema.videoPosts)
          .set({
            views: toInt(req.body?.views),
            likes: toInt(req.body?.likes),
            comments: toInt(req.body?.comments),
            shares: toInt(req.body?.shares),
            saves: toInt(req.body?.saves),
            statsUpdatedAt: new Date(),
          })
          .where(eq(schema.videoPosts.id, post.id));
        return reply.redirect(`/admin/videos/${post.videoId}`);
      }
      return reply.redirect("/admin/videos");
    },
  );

  app.post<{ Params: { postId: string } }>("/posts/:postId/delete", async (req, reply) => {
    const d = db();
    const post = await d.query.videoPosts.findFirst({ where: eq(schema.videoPosts.id, req.params.postId) });
    if (post) {
      await d.delete(schema.videoPosts).where(eq(schema.videoPosts.id, post.id));
      return reply.redirect(`/admin/videos/${post.videoId}`);
    }
    return reply.redirect("/admin/videos");
  });
}
