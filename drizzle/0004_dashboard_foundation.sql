-- Compatibility migration for the current dashboard source running on top of
-- the richer Central Command database. All changes are additive and preserve
-- the existing showing, tour, voice, MLS and VOW records.

CREATE TABLE IF NOT EXISTS "pending_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE cascade,
  "channel" text NOT NULL,
  "draft_text" text NOT NULL,
  "sent_text" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "approval_token_hash" text,
  "token_expires_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "decided_via" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "property_address" text NOT NULL,
  "mls_number" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listing_showings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL REFERENCES "listings"("id") ON DELETE cascade,
  "agent_name" text,
  "agent_email" text,
  "agent_phone" text,
  "agent_lead_id" uuid REFERENCES "leads"("id") ON DELETE set null,
  "starts_at" timestamp with time zone,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "buyer_interest" text,
  "feedback_notes" text,
  "cadence_stage" integer DEFAULT 0 NOT NULL,
  "next_followup_at" timestamp with time zone,
  "followup_status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN IF NOT EXISTS "tour_id" uuid;
ALTER TABLE "showings" ADD COLUMN IF NOT EXISTS "lockbox_code" text;
ALTER TABLE "showings" ADD COLUMN IF NOT EXISTS "instructions" text;
ALTER TABLE "showings" ADD COLUMN IF NOT EXISTS "confirmation_status" text;
ALTER TABLE "showings" ADD COLUMN IF NOT EXISTS "travel_minutes_from_prev" integer;
--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN IF NOT EXISTS "lead_id" uuid;
ALTER TABLE "tours" ADD COLUMN IF NOT EXISTS "tour_date" text;
ALTER TABLE "tours" ADD COLUMN IF NOT EXISTS "itinerary_md" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tours" ADD CONSTRAINT "tours_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
