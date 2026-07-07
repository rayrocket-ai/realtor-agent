CREATE TABLE "tours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_start" timestamp with time zone NOT NULL,
	"duration_min" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"source" text DEFAULT 'telegram' NOT NULL,
	"notify_telegram_chat_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"itinerary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mls_bookings" ADD COLUMN "tour_id" uuid;--> statement-breakpoint
ALTER TABLE "mls_bookings" ADD COLUMN "tour_stop" integer;--> statement-breakpoint
ALTER TABLE "mls_bookings" ADD CONSTRAINT "mls_bookings_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE set null ON UPDATE no action;