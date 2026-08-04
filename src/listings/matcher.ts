import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { runAgentTurn } from "../agent/loop.js";
import { leadReachable } from "../channels/outbound.js";
import { activeBuyerProfiles } from "../buyers/profile.js";
import { searchListings, type ListingSearchCriteria, type MlsListing } from "./reso.js";
import { listingsForModel } from "./field-policy.js";
import type { BuyerRequirements, PropertyReaction } from "../db/schema.js";

/** Max fresh listings pitched to one buyer in one daily run. */
export const MATCHES_PER_BUYER = 3;
/** Max areas queried per buyer (one MLS query each). */
export const AREAS_PER_BUYER = 3;
/** Max buyers messaged per run, so a criteria change can't flood the approval queue. */
export const BUYERS_PER_RUN = 10;

export interface BudgetRange {
  minPrice?: number;
  maxPrice?: number;
}

const MULTIPLIERS: Record<string, number> = { k: 1_000, m: 1_000_000, mm: 1_000_000 };

function parseAmount(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^\$?\s*([\d.,]+)\s*(k|m|mm)?$/);
  if (!m) return null;
  const digits = Number(m[1]!.replaceAll(",", ""));
  if (!Number.isFinite(digits) || digits <= 0) return null;
  let value = digits * (m[2] ? MULTIPLIERS[m[2]]! : 1);
  // "1.2" with no suffix means $1.2M; "800" means $800k. Real GTA purchase
  // budgets are never under $10k, so scale bare numbers up to plausibility.
  while (value < 10_000) value *= 1_000;
  return Math.round(value);
}

/**
 * Turn a free-text budget ("$700k-$800k", "under 1.2M", "around 900k", "max
 * $850,000") into a min/max price range. Unparseable input → empty range.
 */
export function parseBudget(budget: string | null | undefined): BudgetRange {
  if (!budget?.trim()) return {};
  const text = budget.trim().toLowerCase();

  const range = text.match(/([\d.,]+\s*(?:k|m|mm)?)\s*(?:-|–|—|\bto\b)\s*\$?\s*([\d.,]+\s*(?:k|m|mm)?)/);
  if (range) {
    const low = parseAmount(range[1]!);
    const high = parseAmount(range[2]!);
    if (low != null && high != null) {
      return low <= high ? { minPrice: low, maxPrice: high } : { minPrice: high, maxPrice: low };
    }
  }

  const single = text.match(/\$?\s*[\d.,]+\s*(?:k|m|mm)?/);
  const value = single ? parseAmount(single[0]!) : null;
  if (value == null) return {};

  if (/\b(under|below|up to|max(?:imum)?|no more than|less than)\b|<|≤/.test(text)) {
    return { maxPrice: value };
  }
  if (/\b(over|above|min(?:imum)?|at least|starting|more than)\b|>|≥/.test(text)) {
    return { minPrice: value };
  }
  // A lone figure ("$800k", "around 900k") is a target, not a ceiling:
  // search a bit below and a bit above it.
  return { minPrice: Math.round(value * 0.85), maxPrice: Math.round(value * 1.1) };
}

/** "2", "2+", "3-4 bedrooms" → the minimum bedroom count. */
export function parseMinBedrooms(bedrooms: string | null | undefined): number | undefined {
  const m = bedrooms?.match(/\d+/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 && n < 20 ? n : undefined;
}

/**
 * One MLS search per area (up to AREAS_PER_BUYER), or a single Toronto-wide
 * search when the buyer named no areas. Buyers with neither budget nor areas
 * produce no criteria — too vague to match honestly.
 */
export function criteriaForRequirements(req: BuyerRequirements): Array<{ area: string; criteria: ListingSearchCriteria }> {
  const { minPrice, maxPrice } = parseBudget(req.budget);
  const minBedrooms = parseMinBedrooms(req.bedrooms);
  if (maxPrice == null && !(req.areas?.length)) return [];
  const base: ListingSearchCriteria = {
    minPrice,
    maxPrice,
    minBedrooms,
    propertyType: req.propertyType ?? undefined,
    transactionType: "sale",
    limit: 25,
  };
  const areas = (req.areas ?? []).slice(0, AREAS_PER_BUYER);
  if (!areas.length) return [{ area: "Toronto", criteria: { ...base, city: "Toronto" } }];
  return areas.map((area) => ({ area, criteria: { ...base, city: area } }));
}

function normAddress(a: string | null | undefined): string {
  return (a ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Listings the buyer has already seen, reacted to, or been pitched are not "new" to them. */
export function filterFreshListings(
  listings: MlsListing[],
  opts: { knownListingKeys: Set<string>; knownAddresses: string[] },
): MlsListing[] {
  const knownAddr = opts.knownAddresses.map(normAddress).filter(Boolean);
  const seenKeys = new Set<string>();
  const fresh: MlsListing[] = [];
  for (const l of listings) {
    if (!l.listingKey || opts.knownListingKeys.has(l.listingKey) || seenKeys.has(l.listingKey)) continue;
    const addr = normAddress(l.address);
    if (addr && knownAddr.some((k) => k.includes(addr) || addr.includes(k))) continue;
    seenKeys.add(l.listingKey);
    fresh.push(l);
  }
  return fresh;
}

/**
 * Match one buyer against the live feed. Queries per-area, drops anything the
 * buyer already knows, records the matches, and (when reachable) drafts an
 * outreach message through the normal agent turn so approval mode applies.
 */
export async function matchBuyer(leadId: string, req: BuyerRequirements, reactions: PropertyReaction[]): Promise<number> {
  const searches = criteriaForRequirements(req);
  if (!searches.length) return 0;
  const d = db();

  const [lead, priorMatches, pendingDraft] = await Promise.all([
    d.query.leads.findFirst({ where: eq(schema.leads.id, leadId) }),
    d.query.listingMatches.findMany({ where: eq(schema.listingMatches.leadId, leadId) }),
    d.query.pendingMessages.findFirst({
      where: and(eq(schema.pendingMessages.leadId, leadId), eq(schema.pendingMessages.status, "pending")),
    }),
  ]);
  if (!lead || lead.paused || pendingDraft) return 0;

  const collected: Array<{ listing: MlsListing; area: string }> = [];
  for (const { area, criteria } of searches) {
    if (collected.length >= MATCHES_PER_BUYER) break;
    let rows: MlsListing[];
    try {
      rows = await searchListings(criteria);
    } catch (err) {
      console.error(`[matcher] MLS search failed for area "${area}":`, (err as Error).message);
      continue;
    }
    const fresh = filterFreshListings(rows, {
      knownListingKeys: new Set([
        ...priorMatches.map((m) => m.listingKey),
        ...collected.map((c) => c.listing.listingKey!),
      ]),
      knownAddresses: reactions.map((r) => r.address),
    });
    for (const listing of fresh) {
      if (collected.length >= MATCHES_PER_BUYER) break;
      collected.push({ listing, area });
    }
  }
  if (!collected.length) return 0;

  await d
    .insert(schema.listingMatches)
    .values(
      collected.map(({ listing, area }) => ({
        leadId,
        listingKey: listing.listingKey!,
        mlsNumber: listing.mlsNumber,
        address: listing.address,
        listPrice: listing.listPrice == null ? null : Math.round(listing.listPrice),
        matchedArea: area,
      })),
    )
    .onConflictDoNothing();

  if (!(await leadReachable(lead))) return collected.length;

  const safe = listingsForModel(collected.map((c) => c.listing));
  const summary = safe
    .map(
      (l) =>
        `- ${l.address ?? "Address on file"}${l.mlsNumber ? ` (MLS ${l.mlsNumber})` : ""}: ` +
        `${l.listPrice != null ? `$${l.listPrice.toLocaleString("en-CA")}` : "price on request"}, ` +
        `${l.bedrooms ?? "?"} bed / ${l.bathrooms ?? "?"} bath ${l.propertySubType ?? l.propertyType ?? ""}`.trim(),
    )
    .join("\n");
  await d.insert(schema.messages).values({
    leadId,
    channel: "gmail",
    direction: "internal_note",
    body:
      `New MLS listings match what this buyer is looking for. Write ONE short, personal message sharing them — ` +
      `lead with why each fits their criteria, offer to book a showing, and ask nothing else. ` +
      `Mention only the facts below (address, price, beds/baths, type); do not invent details, photos, or links. ` +
      `Match the buyer's language from the conversation.\n${summary}`,
  });
  await runAgentTurn(leadId, "listing-match");
  return collected.length;
}

/** Daily run across all active buyer profiles. Returns totals for the log line. */
export async function runListingMatcher(): Promise<{ buyersMessaged: number; matches: number }> {
  if (!config().mlsEnabled) {
    console.log("[matcher] PropTx MLS is not configured — skipping listing matcher run");
    return { buyersMessaged: 0, matches: 0 };
  }
  const buyers = await activeBuyerProfiles();
  let buyersMessaged = 0;
  let matches = 0;
  for (const { profile, lead } of buyers) {
    if (buyersMessaged >= BUYERS_PER_RUN) break;
    const found = await matchBuyer(lead.id, profile.requirements, profile.propertyReactions);
    if (found > 0) {
      buyersMessaged++;
      matches += found;
    }
  }
  return { buyersMessaged, matches };
}

/** Recent matches per lead, for the Buyers dashboard cards. */
export async function recentMatchesByLead(leadIds: string[]): Promise<Map<string, Array<typeof schema.listingMatches.$inferSelect>>> {
  if (!leadIds.length) return new Map();
  const rows = await db().query.listingMatches.findMany({
    where: inArray(schema.listingMatches.leadId, leadIds),
    orderBy: desc(schema.listingMatches.createdAt),
  });
  const byLead = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byLead.get(row.leadId) ?? [];
    if (list.length < 3) list.push(row);
    byLead.set(row.leadId, list);
  }
  return byLead;
}
