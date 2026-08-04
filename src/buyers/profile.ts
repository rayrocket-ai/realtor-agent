import { desc, eq, sql } from "drizzle-orm";
import { db, pgPool, schema } from "../db/client.js";
import { completeText } from "../agent/client.js";
import type { BuyerProfile, BuyerRequirements, Lead, PropertyReaction } from "../db/schema.js";

const REACTIONS: PropertyReaction["reaction"][] = ["liked", "mixed", "disliked", "no_feedback"];

const PROFILE_SYSTEM = `You analyze a real-estate CRM record for one lead and produce a buyer profile as strict JSON.
The realtor is Ray Ahmadi (Toronto/GTA). The record contains the lead's details, recent conversation
messages, showings, tours, offers, and lead-capture form answers.

Return ONLY a JSON object (no markdown fences, no commentary) with exactly this shape:
{
  "isActiveBuyer": boolean,        // true only if this person is currently looking to BUY (not a seller, cooperating agent, vendor, or dead lead)
  "summary": string,               // 2-3 plain sentences: who they are, what they want, where they stand
  "requirements": {
    "budget": string|null,         // e.g. "$800k-$950k" — only what they actually said
    "areas": string[],             // neighbourhoods/cities mentioned
    "propertyType": string|null,   // condo/detached/townhouse/…
    "bedrooms": string|null,
    "bathrooms": string|null,
    "preApproved": boolean|null,   // null if never discussed
    "timeline": string|null,       // e.g. "next 3 months"
    "mustHaves": string[],
    "dealBreakers": string[]
  },
  "propertyReactions": [           // one entry per property they toured/discussed
    { "address": string, "reaction": "liked"|"mixed"|"disliked"|"no_feedback", "notes": string|null }
  ],
  "nextAction": string             // one concrete suggested next step for Ray
}

Rules: never invent facts — anything not evidenced in the record is null/empty. Base reactions only on
what the buyer actually said after seeing or discussing a property; a showing with no comment afterwards
is "no_feedback". Keep notes short.`;

export interface LeadRecordBundle {
  lead: Lead;
  messages: Array<{ direction: string; channel: string; body: string; createdAt: Date }>;
  showings: Array<{ propertyAddress: string; mlsNumber: string | null; startsAt: Date; status: string }>;
  tours: Array<{ tourDate: string; status: string }>;
  offers: Array<{ propertyAddress: string; status: string; terms: Record<string, unknown>; updatedAt: Date }>;
  submissions: Array<{ intent: string; score: string; answers: Record<string, string>; createdAt: Date }>;
}

export interface ParsedProfile {
  isActiveBuyer: boolean;
  summary: string;
  requirements: BuyerRequirements;
  propertyReactions: PropertyReaction[];
  nextAction: string | null;
}

/** Parse the model's JSON (tolerating markdown fences) into a validated profile. */
export function parseProfileJson(raw: string): ParsedProfile {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  const obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;

  const req = (obj.requirements ?? {}) as Record<string, unknown>;
  const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

  const reactions: PropertyReaction[] = Array.isArray(obj.propertyReactions)
    ? (obj.propertyReactions as Array<Record<string, unknown>>)
        .filter((r) => typeof r?.address === "string" && (r.address as string).trim() !== "")
        .map((r) => ({
          address: (r.address as string).trim(),
          reaction: REACTIONS.includes(r.reaction as PropertyReaction["reaction"])
            ? (r.reaction as PropertyReaction["reaction"])
            : "no_feedback",
          notes: strOrNull(r.notes),
        }))
    : [];

  return {
    isActiveBuyer: obj.isActiveBuyer === true,
    summary: strOrNull(obj.summary) ?? "",
    requirements: {
      budget: strOrNull(req.budget),
      areas: strList(req.areas),
      propertyType: strOrNull(req.propertyType),
      bedrooms: strOrNull(req.bedrooms),
      bathrooms: strOrNull(req.bathrooms),
      preApproved: typeof req.preApproved === "boolean" ? req.preApproved : null,
      timeline: strOrNull(req.timeline),
      mustHaves: strList(req.mustHaves),
      dealBreakers: strList(req.dealBreakers),
    },
    propertyReactions: reactions,
    nextAction: strOrNull(obj.nextAction),
  };
}

/** Every property the buyer was shown appears in the reactions, even without feedback. */
export function mergeShowingsIntoReactions(
  reactions: PropertyReaction[],
  showings: LeadRecordBundle["showings"],
): PropertyReaction[] {
  const norm = (a: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const merged = [...reactions];
  for (const s of showings) {
    if (s.status === "cancelled") continue;
    const existing = merged.find(
      (r) => norm(r.address).includes(norm(s.propertyAddress)) || norm(s.propertyAddress).includes(norm(r.address)),
    );
    if (existing) {
      existing.mlsNumber ??= s.mlsNumber;
      const shownAt = s.startsAt.toISOString().slice(0, 10);
      if (!existing.shownAt || shownAt > existing.shownAt) existing.shownAt = shownAt;
    } else {
      merged.push({
        address: s.propertyAddress,
        mlsNumber: s.mlsNumber,
        reaction: "no_feedback",
        notes: s.status === "confirmed" && s.startsAt > new Date() ? "Showing upcoming" : null,
        shownAt: s.startsAt.toISOString().slice(0, 10),
      });
    }
  }
  return merged;
}

/**
 * Leads that plausibly are buyer clients: anyone with a showing, tour, offer, or a
 * "buying" form submission, or with stored preferences — excluding cooperating
 * agents (contacts created from BrokerBay showings on Ray's own listings) and lost leads.
 */
export async function buyerCandidateLeadIds(): Promise<string[]> {
  const res = await pgPool().query<{ id: string }>(`
    SELECT l.id FROM leads l
    WHERE l.stage <> 'lost'
      AND NOT EXISTS (SELECT 1 FROM listing_showings ls WHERE ls.agent_lead_id = l.id)
      AND (
        EXISTS (SELECT 1 FROM showings s WHERE s.lead_id = l.id)
        OR EXISTS (SELECT 1 FROM tours t WHERE t.lead_id = l.id)
        OR EXISTS (SELECT 1 FROM offers o WHERE o.lead_id = l.id)
        OR EXISTS (SELECT 1 FROM lead_submissions sub WHERE sub.lead_id = l.id AND sub.intent = 'buying')
        OR (l.preferences IS NOT NULL AND l.preferences::text <> '{}')
      )
    ORDER BY l.updated_at DESC`);
  return res.rows.map((r) => r.id);
}

async function loadBundle(leadId: string): Promise<LeadRecordBundle | null> {
  const d = db();
  const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, leadId) });
  if (!lead) return null;
  const [msgs, shows, trs, offs, subs] = await Promise.all([
    d.query.messages.findMany({
      where: eq(schema.messages.leadId, leadId),
      orderBy: desc(schema.messages.createdAt),
      limit: 80,
    }),
    d.query.showings.findMany({ where: eq(schema.showings.leadId, leadId), orderBy: desc(schema.showings.startsAt) }),
    d.query.tours.findMany({ where: eq(schema.tours.leadId, leadId) }),
    d.query.offers.findMany({ where: eq(schema.offers.leadId, leadId) }),
    d.query.leadSubmissions.findMany({ where: eq(schema.leadSubmissions.leadId, leadId) }),
  ]);
  return {
    lead,
    messages: msgs.reverse().map((m) => ({
      direction: m.direction,
      channel: m.channel,
      body: m.body.length > 500 ? `${m.body.slice(0, 500)}…` : m.body,
      createdAt: m.createdAt,
    })),
    showings: shows.map((s) => ({
      propertyAddress: s.propertyAddress,
      mlsNumber: s.mlsNumber,
      startsAt: s.startsAt,
      status: s.status,
    })),
    tours: trs.map((t) => ({ tourDate: t.tourDate, status: t.status })),
    offers: offs.map((o) => ({
      propertyAddress: o.propertyAddress,
      status: o.status,
      terms: o.terms ?? {},
      updatedAt: o.updatedAt,
    })),
    submissions: subs.map((s) => ({ intent: s.intent, score: s.score, answers: s.answers ?? {}, createdAt: s.createdAt })),
  };
}

/** Most recent activity timestamp across the bundle — the profile's freshness watermark. */
export function latestActivityAt(bundle: LeadRecordBundle): Date {
  const times = [
    bundle.lead.updatedAt.getTime(),
    ...bundle.messages.map((m) => m.createdAt.getTime()),
    ...bundle.offers.map((o) => o.updatedAt.getTime()),
    ...bundle.submissions.map((s) => s.createdAt.getTime()),
  ];
  return new Date(Math.max(...times));
}

/** Build (or skip, when nothing changed) the profile for one lead. Returns what happened. */
export async function refreshProfileForLead(
  leadId: string,
  opts: { force?: boolean } = {},
): Promise<"updated" | "skipped" | "failed"> {
  const bundle = await loadBundle(leadId);
  if (!bundle) return "failed";
  const d = db();
  const activityAt = latestActivityAt(bundle);
  const existing = await d.query.buyerProfiles.findFirst({
    where: eq(schema.buyerProfiles.leadId, leadId),
  });
  if (
    !opts.force &&
    existing?.sourceActivityAt &&
    existing.sourceActivityAt.getTime() >= activityAt.getTime()
  ) {
    return "skipped";
  }

  const record = {
    lead: {
      name: bundle.lead.name,
      email: bundle.lead.email,
      phone: bundle.lead.phone,
      stage: bundle.lead.stage,
      notes: bundle.lead.notes,
      preferences: bundle.lead.preferences,
    },
    formSubmissions: bundle.submissions,
    showings: bundle.showings,
    tours: bundle.tours,
    offers: bundle.offers,
    conversation: bundle.messages.map((m) => `[${m.direction}/${m.channel}] ${m.body}`),
  };

  let parsed: ParsedProfile;
  try {
    const raw = await completeText(PROFILE_SYSTEM, JSON.stringify(record, null, 1), 2000);
    parsed = parseProfileJson(raw);
  } catch (err) {
    console.error(`[buyers] profile build failed for lead ${leadId}:`, (err as Error).message);
    return "failed";
  }

  const reactions = mergeShowingsIntoReactions(parsed.propertyReactions, bundle.showings);
  const values = {
    isActiveBuyer: parsed.isActiveBuyer,
    summary: parsed.summary,
    requirements: parsed.requirements,
    propertyReactions: reactions,
    nextAction: parsed.nextAction,
    sourceActivityAt: activityAt,
    generatedAt: new Date(),
    updatedAt: new Date(),
  };
  await d
    .insert(schema.buyerProfiles)
    .values({ leadId, ...values })
    .onConflictDoUpdate({ target: schema.buyerProfiles.leadId, set: values });
  return "updated";
}

/** Refresh all buyer candidates. Returns counts for logging/briefing. */
export async function refreshAllBuyerProfiles(
  opts: { force?: boolean } = {},
): Promise<{ updated: number; skipped: number; failed: number }> {
  const ids = await buyerCandidateLeadIds();
  const counts = { updated: 0, skipped: 0, failed: 0 };
  for (const id of ids) {
    counts[await refreshProfileForLead(id, opts)]++;
  }
  return counts;
}

/** Active buyer profiles joined with their lead, newest activity first — for dashboard + weekly email. */
export async function activeBuyerProfiles(): Promise<Array<{ profile: BuyerProfile; lead: Lead }>> {
  const d = db();
  const rows = await d
    .select({ profile: schema.buyerProfiles, lead: schema.leads })
    .from(schema.buyerProfiles)
    .innerJoin(schema.leads, eq(schema.buyerProfiles.leadId, schema.leads.id))
    .where(sql`${schema.buyerProfiles.isActiveBuyer} = true AND ${schema.leads.stage} NOT IN ('closed', 'lost')`)
    .orderBy(desc(schema.buyerProfiles.sourceActivityAt));
  return rows;
}
