CREATE TABLE "mls_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"requested_start" timestamp with time zone NOT NULL,
	"duration_min" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"lead_id" uuid,
	"showing_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attention_reason" text,
	"mls_number" text,
	"matched_address" text,
	"confirmation_text" text,
	"gcal_event_id" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"submit_attempted_at" timestamp with time zone,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mls_bookings" ADD CONSTRAINT "mls_bookings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_bookings" ADD CONSTRAINT "mls_bookings_showing_id_showings_id_fk" FOREIGN KEY ("showing_id") REFERENCES "public"."showings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mls_bookings_status_idx" ON "mls_bookings" USING btree ("status","created_at");