CREATE TABLE "agent_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"draft_text" text NOT NULL,
	"sent_text" text NOT NULL,
	"distilled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"lesson" text NOT NULL,
	"source_type" text DEFAULT 'edit_diff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_showings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"agent_name" text,
	"agent_email" text,
	"agent_phone" text,
	"agent_lead_id" uuid,
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
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_address" text NOT NULL,
	"mls_number" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
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
CREATE TABLE "tours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"tour_date" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"itinerary_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "tour_id" uuid;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "lockbox_code" text;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "confirmation_status" text;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "travel_minutes_from_prev" integer;--> statement-breakpoint
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_showings" ADD CONSTRAINT "listing_showings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_showings" ADD CONSTRAINT "listing_showings_agent_lead_id_leads_id_fk" FOREIGN KEY ("agent_lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_messages" ADD CONSTRAINT "pending_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;