-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'preparing', 'running', 'paused', 'completed', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('pending', 'sending', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped', 'cancelled');

-- CreateEnum
CREATE TYPE "DripSequenceStatus" AS ENUM ('draft', 'active', 'paused');

-- CreateEnum
CREATE TYPE "DripEnrollmentStatus" AS ENUM ('active', 'completed', 'exited');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "phone_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "audience" JSONB NOT NULL,
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMPTZ(3),
    "timezone" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "pause_code" TEXT,
    "pause_reason" TEXT,
    "reservation_id" UUID,
    "estimate_micros" BIGINT NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "waiting_until" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "estimate_micros" BIGINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "message_id" UUID,
    "message_created_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "replied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_tier_limits" (
    "tier" TEXT NOT NULL,
    "daily_recipients" INTEGER,

    CONSTRAINT "messaging_tier_limits_pkey" PRIMARY KEY ("tier")
);

-- CreateTable
CREATE TABLE "drip_sequences" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DripSequenceStatus" NOT NULL DEFAULT 'draft',
    "phone_id" UUID NOT NULL,
    "exit_on_reply" BOOLEAN NOT NULL DEFAULT true,
    "exit_tag_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drip_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_steps" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "delay_minutes" INTEGER NOT NULL,
    "template_id" UUID NOT NULL,
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "drip_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_enrollments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "DripEnrollmentStatus" NOT NULL DEFAULT 'active',
    "next_step" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ(3),
    "exit_reason" TEXT,
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drip_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_org_id_created_at_id_idx" ON "campaigns"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "campaigns_status_scheduled_at_idx" ON "campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_status_id_idx" ON "campaign_recipients"("campaign_id", "status", "id");

-- CreateIndex
CREATE INDEX "campaign_recipients_message_id_idx" ON "campaign_recipients"("message_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_phone_id_sent_at_idx" ON "campaign_recipients"("phone_id", "sent_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_contact_id_sent_at_idx" ON "campaign_recipients"("contact_id", "sent_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_org_id_idx" ON "campaign_recipients"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_contact_id_key" ON "campaign_recipients"("campaign_id", "contact_id");

-- CreateIndex
CREATE INDEX "drip_sequences_org_id_created_at_id_idx" ON "drip_sequences"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "drip_steps_org_id_idx" ON "drip_steps"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "drip_steps_sequence_id_position_key" ON "drip_steps"("sequence_id", "position");

-- CreateIndex
CREATE INDEX "drip_enrollments_status_next_run_at_idx" ON "drip_enrollments"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "drip_enrollments_contact_id_status_idx" ON "drip_enrollments"("contact_id", "status");

-- CreateIndex
CREATE INDEX "drip_enrollments_org_id_idx" ON "drip_enrollments"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "drip_enrollments_sequence_id_contact_id_key" ON "drip_enrollments"("sequence_id", "contact_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_sequences" ADD CONSTRAINT "drip_sequences_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_sequences" ADD CONSTRAINT "drip_sequences_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_sequences" ADD CONSTRAINT "drip_sequences_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "drip_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_enrollments" ADD CONSTRAINT "drip_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "drip_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_enrollments" ADD CONSTRAINT "drip_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: limits, RLS, and the lookups the scheduler needs.
-- ============================================================================

-- Meta's tiers at the time of writing. Config, not code: change the rows when Meta changes them.
INSERT INTO messaging_tier_limits (tier, daily_recipients) VALUES
  ('TIER_250', 250), ('TIER_1K', 1000), ('TIER_2K', 2000), ('TIER_10K', 10000),
  ('TIER_100K', 100000), ('TIER_UNLIMITED', NULL);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "messaging_tier_limits" FROM app_user;

-- History is not deleted by the app.
REVOKE DELETE ON "campaign_recipients", "drip_enrollments" FROM app_user;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'campaign_recipients', 'drip_sequences', 'drip_steps', 'drip_enrollments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO app_user USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id())',
      t || '_org', t
    );
  END LOOP;
END
$$;

-- The scheduler runs for every tenant, so it starts with no org context. These return only ids.
CREATE POLICY campaigns_definer_read ON "campaigns" FOR SELECT TO app_definer USING (true);
CREATE POLICY drip_sequences_definer_read ON "drip_sequences" FOR SELECT TO app_definer USING (true);
CREATE POLICY drip_enrollments_definer_read ON "drip_enrollments" FOR SELECT TO app_definer USING (true);
GRANT SELECT ON "campaigns", "drip_sequences", "drip_enrollments" TO app_definer;
GRANT CREATE ON SCHEMA public TO app_definer;

-- Due to start, or left behind: a campaign with no progress for 2 minutes lost its job chain.
CREATE FUNCTION campaign_tick_targets(p_now timestamptz)
  RETURNS TABLE (org_id uuid, campaign_id uuid, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $fn$
    SELECT c.org_id, c.id, 'prepare' FROM campaigns c
     WHERE (c.status = 'scheduled' AND c.scheduled_at <= p_now)
        OR (c.status = 'preparing' AND c.updated_at < p_now - interval '2 minutes')
    UNION ALL
    SELECT c.org_id, c.id, 'dispatch' FROM campaigns c
     WHERE c.status = 'running' AND c.updated_at < p_now - interval '2 minutes'
  $fn$;

CREATE FUNCTION drip_due_targets()
  RETURNS TABLE (org_id uuid, sequence_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $fn$
    SELECT DISTINCT e.org_id, e.sequence_id FROM drip_enrollments e
      JOIN drip_sequences s ON s.id = e.sequence_id
     WHERE e.status = 'active' AND e.next_run_at <= now() AND s.status = 'active'
  $fn$;

ALTER FUNCTION campaign_tick_targets(timestamptz) OWNER TO app_definer;
ALTER FUNCTION drip_due_targets() OWNER TO app_definer;
REVOKE ALL ON FUNCTION campaign_tick_targets(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION drip_due_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_tick_targets(timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION drip_due_targets() TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;
