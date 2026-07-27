import { z } from "zod";

/**
 * Public lead-capture form (/connect): payload validation, auto-qualification
 * scoring, and the English summary that goes on the lead's timeline so the
 * agent (and Ray) can pick the conversation up from it.
 */

export const INTENTS = ["buying", "selling", "general"] as const;
export const LANGUAGES = ["en", "prs"] as const; // prs = Dari

export const submissionSchema = z
  .object({
    intent: z.enum(INTENTS),
    language: z.enum(LANGUAGES).default("en"),
    name: z.string().trim().min(1).max(200),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .max(320)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    phone: z
      .string()
      .trim()
      .max(40)
      .regex(/^[+\d][\d\s()\-.]{6,}$/, "invalid phone")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    contactMethod: z.enum(["whatsapp", "call", "email", "telegram"]).optional(),
    answers: z.record(z.string().max(500)).default({}),
    message: z.string().trim().max(5000).optional(),
    source: z.string().trim().max(100).optional(),
  })
  .refine((s) => s.email || s.phone, {
    message: "Provide at least a phone number or an email address.",
  })
  .refine((s) => Object.keys(s.answers).length <= 12, { message: "Too many answers." });

export type SubmissionInput = z.infer<typeof submissionSchema>;

export type Score = "hot" | "warm" | "cold";

/** Rule-based qualification from the form answers. */
export function scoreSubmission(s: SubmissionInput): Score {
  const a = s.answers;
  if (s.intent === "buying") {
    const soon = a.timeline === "asap" || a.timeline === "0_3";
    const funded = a.preapproved === "yes" || a.preapproved === "cash";
    if (soon && funded) return "hot";
    if (a.timeline === "researching" && !funded) return "cold";
    return "warm";
  }
  if (s.intent === "selling") {
    if (a.timeline === "asap" || a.timeline === "1_3") return "hot";
    if (a.timeline === "curious") return "cold";
    return "warm";
  }
  return "warm";
}

/** Days until the first automatic nurture check-in, by qualification. */
export function nurtureDelayDays(score: Score): number {
  return score === "hot" ? 1 : score === "warm" ? 3 : 7;
}

const LABELS: Record<string, string> = {
  timeline: "Timeline",
  preapproved: "Mortgage pre-approval",
  budget: "Budget",
  propertyType: "Property type",
  areas: "Areas of interest",
  address: "Property location",
  alsoBuying: "Also needs to buy",
};

const VALUES: Record<string, string> = {
  asap: "as soon as possible",
  "0_3": "0–3 months",
  "1_3": "1–3 months",
  "3_6": "3–6 months",
  "6_12": "6–12 months",
  researching: "just researching",
  curious: "just curious about home value",
  yes: "yes",
  no: "no",
  not_yet: "not yet",
  need_help: "needs help getting pre-approved",
  not_sure: "not sure",
  cash: "buying with cash",
  under_500k: "under $500k",
  "500_750k": "$500k–$750k",
  "750k_1m": "$750k–$1M",
  over_1m: "over $1M",
  condo: "condo",
  townhouse: "townhouse",
  detached: "detached/semi",
  any: "any",
  other: "other",
};

export function labelAnswer(key: string, value: string): { label: string; value: string } {
  return { label: LABELS[key] ?? key, value: VALUES[value] ?? value };
}

const INTENT_LABEL: Record<SubmissionInput["intent"], string> = {
  buying: "Buying",
  selling: "Selling",
  general: "General inquiry",
};

/**
 * English timeline/notification summary. Always English so the agent and Ray
 * can read it; the lead's preferred reply language is stated explicitly.
 */
export function buildSummary(s: SubmissionInput, score: Score): string {
  const lines = [
    `[Lead form submission${s.source ? ` — via ${s.source}` : ""}]`,
    `Intent: ${INTENT_LABEL[s.intent]}`,
    `Preferred language: ${s.language === "prs" ? "Dari (reply in Dari)" : "English"}`,
    `Qualification: ${score.toUpperCase()}`,
  ];
  for (const [key, value] of Object.entries(s.answers)) {
    if (!value) continue;
    const { label, value: v } = labelAnswer(key, value);
    lines.push(`${label}: ${v}`);
  }
  if (s.contactMethod) lines.push(`Preferred contact method: ${s.contactMethod}`);
  if (s.phone) lines.push(`Phone: ${s.phone}`);
  if (s.message) lines.push(`Message: ${s.message}`);
  return lines.join("\n");
}
