CREATE TABLE "lead_reactivations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"tier" integer NOT NULL,
	"outcome" text DEFAULT 'message_drafted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_reactivations" ADD CONSTRAINT "lead_reactivations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_reactivations_lead_created_idx" ON "lead_reactivations" USING btree ("lead_id","created_at");