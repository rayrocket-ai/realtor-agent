-- Buyer agent: AI-built buyer client profiles (requirements, homes seen with
-- reactions, next actions) behind /admin/buyers and the Monday weekly update.
-- Idempotent and additive, matching the 0003/0004 convention; the VOW tables
-- already exist in production and are intentionally not touched here.

CREATE TABLE IF NOT EXISTS "buyer_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lead_id" uuid NOT NULL,
  "is_active_buyer" boolean DEFAULT true NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "property_reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "next_action" text,
  "source_activity_at" timestamp with time zone,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buyer_profiles" ADD CONSTRAINT "buyer_profiles_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buyer_profiles_lead_unique" ON "buyer_profiles" USING btree ("lead_id");
