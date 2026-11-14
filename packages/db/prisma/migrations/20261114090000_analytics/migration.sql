-- Phase 4.3: analytics aggregates, response and resolution records, conversions, report schedules.
-- Reports read these tables, never messages.


-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "analytics_hourly" (
    "org_id" UUID NOT NULL,
    "hour" TIMESTAMP(0) NOT NULL,
    "channel_id" UUID NOT NULL,
    "inbound" INTEGER NOT NULL DEFAULT 0,
    "outbound_human" INTEGER NOT NULL DEFAULT 0,
    "outbound_automated" INTEGER NOT NULL DEFAULT 0,
    "notes" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "new_conversations" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_hourly_pkey" PRIMARY KEY ("org_id","hour","channel_id")
);

-- CreateTable
CREATE TABLE "analytics_agent_hourly" (
    "org_id" UUID NOT NULL,
    "hour" TIMESTAMP(0) NOT NULL,
    "user_id" UUID NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "notes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_agent_hourly_pkey" PRIMARY KEY ("org_id","hour","user_id")
);

-- CreateTable
CREATE TABLE "analytics_template_hourly" (
    "org_id" UUID NOT NULL,
    "hour" TIMESTAMP(0) NOT NULL,
    "template_id" UUID NOT NULL,
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "replied" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_template_hourly_pkey" PRIMARY KEY ("org_id","hour","template_id")
);

-- CreateTable
CREATE TABLE "analytics_responses" (
    "org_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "customer_at" TIMESTAMPTZ(3) NOT NULL,
    "responded_at" TIMESTAMPTZ(3) NOT NULL,
    "seconds" INTEGER NOT NULL,

    CONSTRAINT "analytics_responses_pkey" PRIMARY KEY ("org_id","message_id")
);

-- CreateTable
CREATE TABLE "conversation_resolutions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "assignee_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "seconds" INTEGER NOT NULL,

    CONSTRAINT "conversation_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "campaign_id" UUID,
    "ad_source_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "recipient_ids" UUID[],
    "hour" INTEGER NOT NULL DEFAULT 8,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_template_hourly_org_id_template_id_idx" ON "analytics_template_hourly"("org_id", "template_id");

-- CreateIndex
CREATE INDEX "analytics_responses_org_id_responded_at_idx" ON "analytics_responses"("org_id", "responded_at");

-- CreateIndex
CREATE INDEX "analytics_responses_conversation_id_responded_at_idx" ON "analytics_responses"("conversation_id", "responded_at");

-- CreateIndex
CREATE INDEX "conversation_resolutions_org_id_closed_at_idx" ON "conversation_resolutions"("org_id", "closed_at");

-- CreateIndex
CREATE INDEX "conversions_org_id_occurred_at_idx" ON "conversions"("org_id", "occurred_at");

-- CreateIndex
CREATE INDEX "conversions_org_id_campaign_id_idx" ON "conversions"("org_id", "campaign_id");

-- CreateIndex
CREATE INDEX "conversions_org_id_ad_source_id_idx" ON "conversions"("org_id", "ad_source_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversions_org_id_source_reference_key" ON "conversions"("org_id", "source", "reference");

-- CreateIndex
CREATE INDEX "report_schedules_org_id_idx" ON "report_schedules"("org_id");

-- CreateIndex
CREATE INDEX "report_schedules_active_next_run_at_idx" ON "report_schedules"("active", "next_run_at");

-- CreateIndex
CREATE INDEX "conversations_last_message_at_idx" ON "conversations"("last_message_at");

-- CreateIndex
CREATE INDEX "messages_org_id_created_at_idx" ON "messages"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ------------------------------------------------------------------ backfill

-- Open conversations count from when they were made; closed ones are reset when reopened.
UPDATE conversations SET opened_at = created_at;

-- ------------------------------------------------------------------ resolutions

-- Every path that closes or reopens a conversation (inbox, API, rules, flows) goes through this,
-- so no caller can forget to record it. Runs as the caller, under its RLS context.
CREATE FUNCTION conversation_resolution_track() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'closed' THEN
        INSERT INTO conversation_resolutions
          (id, org_id, conversation_id, channel_id, assignee_id, opened_at, closed_at, seconds)
        VALUES
          (gen_random_uuid(), NEW.org_id, NEW.id, NEW.channel_id, NEW.assignee_id, NEW.opened_at,
           now(), GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - NEW.opened_at))))::int);
      ELSIF OLD.status = 'closed' THEN
        NEW.opened_at := now();
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER conversation_resolution BEFORE UPDATE OF status ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversation_resolution_track();

-- ------------------------------------------------------------------ RLS

ALTER TABLE analytics_hourly          ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_hourly          FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics_agent_hourly    ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_agent_hourly    FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics_template_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_template_hourly FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics_responses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_responses       FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_resolutions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_resolutions  FORCE ROW LEVEL SECURITY;
ALTER TABLE conversions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversions               FORCE ROW LEVEL SECURITY;
ALTER TABLE report_schedules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules          FORCE ROW LEVEL SECURITY;

CREATE POLICY analytics_hourly_org ON analytics_hourly FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY analytics_agent_hourly_org ON analytics_agent_hourly FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY analytics_template_hourly_org ON analytics_template_hourly FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY analytics_responses_org ON analytics_responses FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY conversation_resolutions_org ON conversation_resolutions FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY conversions_org ON conversions FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY report_schedules_org ON report_schedules FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- Records of what happened are append-only. The hourly tables and responses are derived and
-- rewritten by the rollup, so they keep the default grants.
REVOKE UPDATE, DELETE ON conversation_resolutions FROM app_user;
REVOKE UPDATE, DELETE ON conversions FROM app_user;

-- ------------------------------------------------------------------ pre-tenant functions

GRANT SELECT ON report_schedules TO app_definer;
CREATE POLICY report_schedules_definer ON report_schedules FOR SELECT TO app_definer USING (true);

GRANT CREATE ON SCHEMA public TO app_definer;

-- Workspaces with messages since a time: the rollup's work list. Ids only.
CREATE FUNCTION analytics_rollup_targets(p_since timestamptz)
  RETURNS TABLE (org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT c.org_id FROM conversations c WHERE c.last_message_at >= p_since
  $$;
ALTER FUNCTION analytics_rollup_targets(timestamptz) OWNER TO app_definer;
REVOKE ALL ON FUNCTION analytics_rollup_targets(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_rollup_targets(timestamptz) TO app_user;

-- Report schedules that are due. Ids only.
CREATE FUNCTION report_schedules_due(p_now timestamptz, p_limit int)
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT s.id, s.org_id FROM report_schedules s
    WHERE s.active AND s.next_run_at <= p_now
    ORDER BY s.next_run_at
    LIMIT LEAST(p_limit, 500)
  $$;
ALTER FUNCTION report_schedules_due(timestamptz, int) OWNER TO app_definer;
REVOKE ALL ON FUNCTION report_schedules_due(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_schedules_due(timestamptz, int) TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;

-- ------------------------------------------------------------------ plans

UPDATE plans SET features = features || '["reports"]'::jsonb
  WHERE code IN ('starter', 'growth', 'scale') AND NOT features ? 'reports';
