import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  stage: text("stage").notNull().default("new"), // new|engaged|showing_booked|offer_prep|offer_sent|closed|lost
  notes: text("notes"),
  preferences: jsonb("preferences").$type<Record<string, unknown>>().default({}),
  paused: boolean("paused").notNull().default(false),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  autoApprove: boolean("auto_approve").notNull().default(false),
  followupAt: timestamp("followup_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // gmail|whatsapp|instagram|telegram
    externalId: text("external_id").notNull(), // email address | boosend contact id
    threadRef: text("thread_ref"), // gmail threadId | boosend conversation id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("channel_identity_unique").on(t.channel, t.externalId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    direction: text("direction").notNull(), // inbound|outbound|internal_note
    body: text("body").notNull(),
    externalMsgId: text("external_msg_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_external_msg_id_unique").on(t.externalMsgId),
    index("messages_lead_created_idx").on(t.leadId, t.createdAt),
  ],
);

export const showings = pgTable("showings", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  propertyAddress: text("property_address").notNull(),
  mlsNumber: text("mls_number"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  gcalEventId: text("gcal_event_id"),
  status: text("status").notNull().default("confirmed"), // proposed|confirmed|cancelled|completed
  remindersScheduled: boolean("reminders_scheduled").notNull().default(false),
  tourId: uuid("tour_id"),
  lockboxCode: text("lockbox_code"),
  instructions: text("instructions"),
  confirmationStatus: text("confirmation_status"), // pending|confirmed|declined (from BrokerBay)
  travelMinutesFromPrev: integer("travel_minutes_from_prev"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tours = pgTable("tours", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  tourDate: text("tour_date").notNull(), // YYYY-MM-DD in office timezone
  status: text("status").notNull().default("proposed"), // proposed|booked|confirmed|completed|cancelled
  itineraryMd: text("itinerary_md"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Messages awaiting the realtor's review before they are sent (training wheels).
export const pendingMessages = pgTable("pending_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  draftText: text("draft_text").notNull(),
  sentText: text("sent_text"),
  status: text("status").notNull().default("pending"), // pending|approved|rejected|expired
  approvalTokenHash: text("approval_token_hash"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedVia: text("decided_via"), // link|email_reply|dashboard
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Distilled standing instructions the agent learned from Ray's edits/corrections.
export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: text("category").notNull().default("general"),
  lesson: text("lesson").notNull(),
  sourceType: text("source_type").notNull().default("edit_diff"), // edit_diff|correction|instruction
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Raw draft-vs-sent evidence, distilled nightly into lessons.
export const agentFeedback = pgTable("agent_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  draftText: text("draft_text").notNull(),
  sentText: text("sent_text").notNull(),
  distilled: boolean("distilled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Ray's own listings (sell side).
export const listings = pgTable("listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  propertyAddress: text("property_address").notNull(),
  mlsNumber: text("mls_number"),
  status: text("status").notNull().default("active"), // active|sold|leased|suspended
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Outside agents' showings ON Ray's listings (parsed from BrokerBay emails).
export const listingShowings = pgTable("listing_showings", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id")
    .notNull()
    .references(() => listings.id, { onDelete: "cascade" }),
  agentName: text("agent_name"),
  agentEmail: text("agent_email"),
  agentPhone: text("agent_phone"),
  agentLeadId: uuid("agent_lead_id").references(() => leads.id, { onDelete: "set null" }),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  status: text("status").notNull().default("confirmed"), // requested|confirmed|declined|cancelled|completed
  buyerInterest: text("buyer_interest"), // hot|warm|fifty_fifty|cold|no_response
  feedbackNotes: text("feedback_notes"),
  cadenceStage: integer("cadence_stage").notNull().default(0),
  nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
  followupStatus: text("followup_status").notNull().default("active"), // active|closed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  propertyAddress: text("property_address").notNull(),
  mlsNumber: text("mls_number"),
  terms: jsonb("terms").$type<Record<string, unknown>>().notNull().default({}),
  summaryMd: text("summary_md").notNull().default(""),
  draftEmailSubject: text("draft_email_subject").notNull().default(""),
  draftEmailBody: text("draft_email_body").notNull().default(""),
  recipientEmail: text("recipient_email"),
  status: text("status").notNull().default("pending_approval"), // draft|pending_approval|approved_sent|rejected|expired
  approvalTokenHash: text("approval_token_hash"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedVia: text("decided_via"), // link|email_reply|dashboard
  rejectionFeedback: text("rejection_feedback"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Lead-capture form submissions from the public /connect page (social media bio link).
export const leadSubmissions = pgTable(
  "lead_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    intent: text("intent").notNull(), // buying|selling|general
    language: text("language").notNull().default("en"), // en|prs (Dari)
    score: text("score").notNull().default("warm"), // hot|warm|cold
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    source: text("source"), // ?src= tag on the shared link, e.g. instagram|tiktok
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_submissions_lead_idx").on(t.leadId)],
);

// AI-built profile of each buyer client: requirements, homes seen and reactions,
// pending offers context, and the suggested next action. Refreshed daily and
// on demand from the dashboard; feeds the Monday weekly buyer update email.
export const buyerProfiles = pgTable(
  "buyer_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    isActiveBuyer: boolean("is_active_buyer").notNull().default(true),
    summary: text("summary").notNull().default(""),
    requirements: jsonb("requirements").$type<BuyerRequirements>().notNull().default({}),
    propertyReactions: jsonb("property_reactions").$type<PropertyReaction[]>().notNull().default([]),
    nextAction: text("next_action"),
    // Latest lead/message/showing/offer activity the profile was built from —
    // used to skip the model call when nothing changed.
    sourceActivityAt: timestamp("source_activity_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("buyer_profiles_lead_unique").on(t.leadId)],
);

export interface BuyerRequirements {
  budget?: string | null;
  areas?: string[];
  propertyType?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  preApproved?: boolean | null;
  timeline?: string | null;
  mustHaves?: string[];
  dealBreakers?: string[];
}

export interface PropertyReaction {
  address: string;
  mlsNumber?: string | null;
  reaction: "liked" | "mixed" | "disliked" | "no_feedback";
  notes?: string | null;
  shownAt?: string | null; // ISO date of the (latest) showing, when known
}

// One row per re-engagement attempt by the lead-reactivation agent. Attempts
// made before the lead's latest engagement don't count against new cycles, so
// tiers reset naturally when a lead replies and goes quiet again.
export const leadReactivations = pgTable(
  "lead_reactivations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    tier: integer("tier").notNull(), // days quiet when triggered: 30|60|90
    outcome: text("outcome").notNull().default("message_drafted"), // message_drafted|realtor_notified
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_reactivations_lead_created_idx").on(t.leadId, t.createdAt)],
);

// New MLS listings the matcher agent has already surfaced to a buyer, so the
// same property is never pitched to the same lead twice.
export const listingMatches = pgTable(
  "listing_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    listingKey: text("listing_key").notNull(),
    mlsNumber: text("mls_number"),
    address: text("address"),
    listPrice: integer("list_price"),
    matchedArea: text("matched_area"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listing_matches_lead_listing_unique").on(t.leadId, t.listingKey)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("pending"), // pending|running|done|failed|cancelled
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_status_run_at_idx").on(t.status, t.runAt),
    // Only one *pending* job per dedupe key; done/failed jobs don't block new ones.
    uniqueIndex("jobs_dedupe_pending_unique")
      .on(t.dedupeKey)
      .where(sql`status = 'pending'`),
  ],
);

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  trigger: text("trigger").notNull(),
  toolCalls: jsonb("tool_calls").$type<unknown[]>().notNull().default([]),
  output: text("output"),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Authenticated consumer property-search accounts. The VOW routes deliberately
// keep this identity and audit trail separate from CRM leads.
export const vowConsumers = pgTable(
  "vow_consumers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordExpiresAt: timestamp("password_expires_at", { withTimezone: true }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    verificationTokenHash: text("verification_token_hash"),
    verificationExpiresAt: timestamp("verification_expires_at", { withTimezone: true }),
    termsVersion: text("terms_version").notNull(),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }).notNull(),
    brokerRelationshipAcknowledged: boolean("broker_relationship_acknowledged").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vow_consumers_email_unique").on(t.email),
    uniqueIndex("vow_consumers_username_unique").on(t.username),
  ],
);

export const vowSessions = pgTable(
  "vow_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consumerId: uuid("consumer_id").notNull().references(() => vowConsumers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vow_sessions_token_unique").on(t.tokenHash),
    index("vow_sessions_consumer_idx").on(t.consumerId),
  ],
);

export const vowAuditLog = pgTable(
  "vow_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consumerId: uuid("consumer_id").references(() => vowConsumers.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vow_audit_consumer_created_idx").on(t.consumerId, t.createdAt)],
);

export type Lead = typeof leads.$inferSelect;
export type BuyerProfile = typeof buyerProfiles.$inferSelect;
export type LeadReactivation = typeof leadReactivations.$inferSelect;
export type ListingMatch = typeof listingMatches.$inferSelect;
export type Tour = typeof tours.$inferSelect;
export type PendingMessage = typeof pendingMessages.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type ListingShowing = typeof listingShowings.$inferSelect;
export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type LeadSubmission = typeof leadSubmissions.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Showing = typeof showings.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type Job = typeof jobs.$inferSelect;
