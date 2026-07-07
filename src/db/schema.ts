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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export interface BookingLogEntry {
  t: string; // ISO timestamp
  step: string;
  note?: string;
}

/**
 * A multi-home showing tour: several listings booked back-to-back starting at
 * one time, ordered by driving distance. Each stop becomes an mls_bookings row.
 */
export const tours = pgTable("tours", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Listing refs as given: addresses and/or MLS numbers. */
  refs: jsonb("refs").$type<string[]>().notNull().default([]),
  requestedStart: timestamp("requested_start", { withTimezone: true }).notNull(),
  durationMin: integer("duration_min").notNull().default(30), // per stop
  notes: text("notes"),
  source: text("source").notNull().default("telegram"),
  notifyTelegramChatId: text("notify_telegram_chat_id"),
  // pending|planning|booked|failed|needs_attention|cancelled
  status: text("status").notNull().default("pending"),
  /** Resolved plan: ordered stops with addresses, times, distances. */
  itinerary: jsonb("itinerary").$type<TourStopPlan[]>().notNull().default([]),
  error: text("error"),
  dryRun: boolean("dry_run").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface TourStopPlan {
  ref: string; // as given
  address: string; // resolved
  mlsNumber?: string | null;
  lat?: number;
  lng?: number;
  startsAt: string; // ISO
  travelMinFromPrev?: number;
  distanceKmFromPrev?: number;
}

/**
 * A request to book a showing on the MLS side: search REALM for the listing,
 * follow its "Book Showing" handoff into BrokerBay, and book the requested slot.
 */
export const mlsBookings = pgTable(
  "mls_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull(), // as given by the realtor
    requestedStart: timestamp("requested_start", { withTimezone: true }).notNull(),
    durationMin: integer("duration_min").notNull().default(30),
    notes: text("notes"),
    source: text("source").notNull().default("dashboard"), // dashboard|cli|agent|telegram
    // When set, booking updates are also sent to this Telegram chat.
    notifyTelegramChatId: text("notify_telegram_chat_id"),
    // Set when this booking is one stop of a multi-home tour.
    tourId: uuid("tour_id").references(() => tours.id, { onDelete: "set null" }),
    tourStop: integer("tour_stop"), // 1-based position in the tour
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    showingId: uuid("showing_id").references(() => showings.id, { onDelete: "set null" }),
    // pending|running|submitted|confirmed|needs_attention|failed|dry_run|cancelled
    status: text("status").notNull().default("pending"),
    attentionReason: text("attention_reason"),
    mlsNumber: text("mls_number"),
    matchedAddress: text("matched_address"), // the listing REALM actually matched
    confirmationText: text("confirmation_text"), // what BrokerBay said after submit
    gcalEventId: text("gcal_event_id"),
    dryRun: boolean("dry_run").notNull().default(false),
    // Set right before the final BrokerBay submit click — guards against double-booking on retry.
    submitAttemptedAt: timestamp("submit_attempted_at", { withTimezone: true }),
    log: jsonb("log").$type<BookingLogEntry[]>().notNull().default([]),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mls_bookings_status_idx").on(t.status, t.createdAt)],
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

export type Lead = typeof leads.$inferSelect;
export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Showing = typeof showings.$inferSelect;
export type MlsBooking = typeof mlsBookings.$inferSelect;
export type Tour = typeof tours.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type Job = typeof jobs.$inferSelect;
