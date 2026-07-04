export interface OfferTerms {
  price: number;
  deposit: number;
  irrevocableDate: string; // e.g. "2026-07-06 11:59 PM"
  completionDate: string; // closing date
  conditions: string[]; // e.g. ["financing (5 business days)", "home inspection"]
  inclusions?: string;
  exclusions?: string;
  notes?: string;
}

const cad = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

/**
 * Renders a terms sheet mapped to the OREA Form 100 (Agreement of Purchase
 * and Sale) sections. This is a summary for the realtor to review — the
 * formal Form 100 is always prepared and signed through the realtor's own
 * forms software.
 */
export function renderOfferSummary(opts: {
  buyerName: string;
  propertyAddress: string;
  mlsNumber?: string | null;
  terms: OfferTerms;
}): string {
  const t = opts.terms;
  const lines = [
    `# Offer Summary — ${opts.propertyAddress}`,
    "",
    opts.mlsNumber ? `MLS®: ${opts.mlsNumber}` : null,
    `Buyer: ${opts.buyerName}`,
    "",
    "## Terms (OREA Form 100 mapping)",
    `- Purchase Price (¶1): ${cad.format(t.price)}`,
    `- Deposit (¶4): ${cad.format(t.deposit)} upon acceptance`,
    `- Irrevocability (¶1): ${t.irrevocableDate}`,
    `- Completion Date (¶2): ${t.completionDate}`,
    `- Conditions (Schedule A): ${t.conditions.length ? t.conditions.join("; ") : "None (firm offer)"}`,
    t.inclusions ? `- Chattels Included (¶5): ${t.inclusions}` : null,
    t.exclusions ? `- Fixtures Excluded (¶6): ${t.exclusions}` : null,
    t.notes ? `- Notes: ${t.notes}` : null,
    "",
    "_Draft prepared by AI assistant — review every field against the formal OREA Form 100 before presenting._",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** Short id used in approval email subjects: [OFFER-xxxxxxxx] */
export function offerShortId(offerId: string): string {
  return offerId.replace(/-/g, "").slice(0, 8).toLowerCase();
}
