import { and, desc, eq, gt } from "drizzle-orm";
import { db, pgPool, schema } from "../db/client.js";
import { config } from "../config.js";
import { runAgentTurn } from "../agent/loop.js";
import { leadReachable } from "../channels/outbound.js";
import { enqueue } from "../jobs/queue.js";
import type { BuyerRequirements } from "../db/schema.js";

/** Days of silence that trigger each re-engagement attempt (one message per tier). */
export const REACTIVATION_TIERS = [30, 60, 90] as const;

/** Safety valve: max leads reactivated per daily run (relevant mostly on the first run). */
export const DAILY_REACTIVATION_CAP = 10;

const DAY_MS = 24 * 3600_000;

/**
 * Which tier (if any) is due for a lead. `attemptTiers` are the tiers of
 * attempts made SINCE the lead's latest engagement — attempts before an
 * engagement are stale history and must not be passed in. Returns the highest
 * due tier not yet attempted this cycle, or null.
 */
export function dueTier(lastEngagementAt: Date, attemptTiers: number[], now: Date = new Date()): number | null {
  const daysQuiet = (now.getTime() - lastEngagementAt.getTime()) / DAY_MS;
  const highestAttempted = Math.max(0, ...attemptTiers);
  let due: number | null = null;
  for (const tier of REACTIVATION_TIERS) {
    if (daysQuiet >= tier && tier > highestAttempted) due = tier;
  }
  return due;
}

export interface ReactivationCandidate {
  leadId: string;
  lastEngagementAt: Date;
}

/**
 * Active-pipeline leads with no engagement for at least the first tier.
 * Engagement = last inbound message, last showing, last offer update, or lead
 * creation — whichever is latest. Outbound messages deliberately do NOT count,
 * so our own reactivation attempts don't reset the clock. Excludes paused
 * leads, closed/lost stages, cooperating agents, leads the followup system
 * already owns (followup_at set), and leads with a draft awaiting approval.
 */
export async function reactivationCandidates(): Promise<ReactivationCandidate[]> {
  const res = await pgPool().query<{ lead_id: string; last_engagement_at: Date }>(
    `SELECT l.id AS lead_id,
            GREATEST(
              l.created_at,
              COALESCE((SELECT max(m.created_at) FROM messages m
                        WHERE m.lead_id = l.id AND m.direction = 'inbound'), l.created_at),
              COALESCE((SELECT max(s.starts_at) FROM showings s
                        WHERE s.lead_id = l.id AND s.starts_at <= now()), l.created_at),
              COALESCE((SELECT max(o.updated_at) FROM offers o WHERE o.lead_id = l.id), l.created_at)
            ) AS last_engagement_at
     FROM leads l
     WHERE l.paused = false
       AND l.stage NOT IN ('closed', 'lost')
       AND l.followup_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM listing_showings ls WHERE ls.agent_lead_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM pending_messages pm
                       WHERE pm.lead_id = l.id AND pm.status = 'pending')
     ORDER BY l.updated_at ASC`,
  );
  const first = REACTIVATION_TIERS[0];
  const now = Date.now();
  return res.rows
    .filter((r) => now - new Date(r.last_engagement_at).getTime() >= first * DAY_MS)
    .map((r) => ({ leadId: r.lead_id, lastEngagementAt: new Date(r.last_engagement_at) }));
}

function requirementsLine(req: BuyerRequirements | undefined): string {
  if (!req) return "";
  const bits = [
    req.propertyType,
    req.bedrooms ? `${req.bedrooms} bed` : "",
    req.budget,
    req.areas?.length ? `in ${req.areas.join("/")}` : "",
  ].filter(Boolean);
  return bits.length ? bits.join(", ") : "";
}

/**
 * Process one candidate: decide the due tier, then either run a re-engagement
 * agent turn (reachable leads) or email Ray (unreachable ones). Records the
 * attempt. Returns what happened, for the daily run's log line.
 */
export async function reactivateLead(
  candidate: ReactivationCandidate,
  now: Date = new Date(),
): Promise<"drafted" | "notified_realtor" | "skipped"> {
  const d = db();
  const attempts = await d.query.leadReactivations.findMany({
    where: and(
      eq(schema.leadReactivations.leadId, candidate.leadId),
      gt(schema.leadReactivations.createdAt, candidate.lastEngagementAt),
    ),
  });
  const tier = dueTier(candidate.lastEngagementAt, attempts.map((a) => a.tier), now);
  if (tier === null) return "skipped";

  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, candidate.leadId) });
  if (!lead) return "skipped";
  const c = config();

  if (!(await leadReachable(lead))) {
    await enqueue({
      type: "notify-realtor",
      payload: {
        subject: `Gone quiet ${tier}+ days: ${lead.name ?? lead.phone ?? "lead"} — needs a personal touch`,
        body:
          `This lead has been quiet for over ${tier} days and has no email or messaging channel, ` +
          `so the AI can't re-engage them — a call or WhatsApp from you is the only way.\n\n` +
          `Phone: ${lead.phone ?? "unknown"}\n` +
          `Stage: ${lead.stage}\n\n` +
          `Open: ${c.APP_BASE_URL}/admin/leads/${lead.id}`,
      },
      dedupeKey: `reactivation-notify:${lead.id}:${tier}`,
    });
    await d.insert(schema.leadReactivations).values({
      leadId: lead.id,
      tier,
      outcome: "realtor_notified",
    });
    return "notified_realtor";
  }

  const [profile, submission] = await Promise.all([
    d.query.buyerProfiles.findFirst({ where: eq(schema.buyerProfiles.leadId, lead.id) }),
    d.query.leadSubmissions.findFirst({
      where: eq(schema.leadSubmissions.leadId, lead.id),
      orderBy: desc(schema.leadSubmissions.createdAt),
    }),
  ]);
  const wants = requirementsLine(profile?.requirements);
  const note = [
    `Re-engagement due: this lead has been quiet for over ${tier} days.`,
    `Write ONE short, warm, personal check-in — not a sales blast.`,
    tier >= 90
      ? `This is the final automated attempt: gently give them an easy out ("no worries if the timing changed — just say the word and I'll stop checking in").`
      : `Offer something genuinely useful: a quick market pulse for their area, or an offer to send fresh listings that match what they wanted.`,
    wants ? `They were looking for: ${wants}.` : "",
    submission?.language === "prs" ? `This lead prefers Dari (دری) — write the message in Dari.` : "",
    `Match the language and tone of their previous messages. Do not guilt-trip them about the silence, and do not stack multiple questions.`,
  ]
    .filter(Boolean)
    .join(" ");

  await d.insert(schema.messages).values({
    leadId: lead.id,
    channel: "gmail",
    direction: "internal_note",
    body: note,
  });
  await d.insert(schema.leadReactivations).values({
    leadId: lead.id,
    tier,
    outcome: "message_drafted",
  });
  await runAgentTurn(lead.id, "reactivation");
  return "drafted";
}
