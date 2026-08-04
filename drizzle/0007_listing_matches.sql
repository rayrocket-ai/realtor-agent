CREATE TABLE "listing_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"listing_key" text NOT NULL,
	"mls_number" text,
	"address" text,
	"list_price" integer,
	"matched_area" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_matches" ADD CONSTRAINT "listing_matches_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_matches_lead_listing_unique" ON "listing_matches" USING btree ("lead_id","listing_key");