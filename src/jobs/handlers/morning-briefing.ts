import { desc, eq, gte } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { completeText } from "../../agent/client.js";
import { notifyRealtor } from "../../channels/gmail/send.js";
import type { JobHandler } from "./index.js";

const DAY = 24 * 60 * 60 * 1000;

/** Daily 7:30am digest: what the agents did, what needs Ray, what's coming. */
export const morningBriefingHandler: JobHandler = async () => {
  const d = db();
  const c = config();
  const since = new Date(Date.now() - DAY);

  const [runs, pendingMsgs, pendingOffers, upcoming, feedbackDue, recentLeads, reactivations, listingMatches] = await Promise.all([
    d.query.agentRuns.findMany({ where: gte(schema.agentRuns.createdAt, since), limit: 200 }),
    d.query.pendingMessages.findMany({ where: eq(schema.pendingMessages.status, "pending") }),
    d.query.offers.findMany({ where: eq(schema.offers.status, "pending_approval") }),
    d.query.showings.findMany({
      where: gte(schema.showings.startsAt, new Date()),
      orderBy: schema.showings.startsAt,
      limit: 10,
    }),
    d.query.listingShowings.findMany({ where: eq(schema.listingShowings.followupStatus, "active"), limit: 50 }),
    d.query.leads.findMany({ orderBy: desc(schema.leads.updatedAt), limit: 15 }),
    d.query.leadReactivations.findMany({ where: gte(schema.leadReactivations.createdAt, since), limit: 20 }),
    d.query.listingMatches.findMany({ where: gte(schema.listingMatches.createdAt, since), limit: 30 }),
  ]);

  const facts = {
    agentTurnsLast24h: runs.length,
    errorsLast24h: runs.filter((r) => r.error).length,
    awaitingYourApproval: {
      draftReplies: pendingMsgs.length,
      offers: pendingOffers.map((o) => `${o.propertyAddress} (${JSON.stringify((o.terms as { price?: number })?.price ?? "")})`),
    },
    upcomingShowings: upcoming
      .filter((s) => s.status === "confirmed")
      .map((s) => `${s.propertyAddress} @ ${s.startsAt.toISOString()}${s.lockboxCode ? " (lockbox on file)" : ""}`),
    activeListingFeedbackPipelines: feedbackDue.length,
    recentlyActiveLeads: recentLeads.map((l) => `${l.name ?? l.email ?? l.phone ?? "?"} [${l.stage}]${l.paused ? " PAUSED" : ""}`),
    quietLeadsReengagedLast24h: reactivations.map(
      (r) => `${r.tier}-day tier, ${r.outcome === "realtor_notified" ? "no channel — Ray notified" : "check-in drafted"}`,
    ),
    newListingMatchesLast24h: listingMatches.map(
      (m) => `${m.address ?? m.mlsNumber ?? m.listingKey}${m.listPrice ? ` ($${m.listPrice.toLocaleString("en-CA")})` : ""}`,
    ),
  };

  let body: string;
  try {
    body = await completeText(
      `You write a crisp morning briefing for ${c.REALTOR_NAME}, a Toronto realtor, about what his AI assistant did and what needs him today. Plain text, short sections, no fluff. Lead with anything that needs HIS action.`,
      JSON.stringify(facts, null, 2),
      1200,
    );
  } catch {
    body = `Raw numbers (model unavailable):\n${JSON.stringify(facts, null, 2)}`;
  }

  body += `\n\nDashboard: ${c.APP_BASE_URL}/admin  ·  Approvals: ${c.APP_BASE_URL}/admin/approvals`;

  if (c.gmailEnabled) {
    await notifyRealtor(`Morning briefing — ${new Date().toDateString()}`, body);
  } else {
    console.log(`[briefing]\n${body}`);
  }
};
