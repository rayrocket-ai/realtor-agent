CREATE TABLE "lead_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"score" text DEFAULT 'warm' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_submissions_lead_idx" ON "lead_submissions" USING btree ("lead_id");