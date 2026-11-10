-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "awaiting_reply_since" TIMESTAMPTZ(3),
ADD COLUMN     "sla_due_at" TIMESTAMPTZ(3),
ADD COLUMN     "sla_stage" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "available" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "automation_settings" (
    "org_id" UUID NOT NULL,
    "welcome_enabled" BOOLEAN NOT NULL DEFAULT false,
    "welcome_message" TEXT,
    "away_enabled" BOOLEAN NOT NULL DEFAULT false,
    "away_message" TEXT,
    "business_hours" JSONB,
    "away_cooldown_minutes" INTEGER NOT NULL DEFAULT 720,
    "default_assignment" TEXT NOT NULL DEFAULT 'none',
    "last_assigned_user_id" UUID,
    "sla_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sla_first_response_minutes" INTEGER NOT NULL DEFAULT 60,
    "sla_escalate_after_minutes" INTEGER,
    "sla_reassign_on_escalate" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "auto_reply_rules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "match_type" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pattern" TEXT,
    "reply" TEXT NOT NULL,
    "phone_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auto_reply_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "strategy" TEXT NOT NULL,
    "tag_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "phone_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agent_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "skill" TEXT,
    "last_assigned_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "conversation_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auto_reply_rules_org_id_priority_idx" ON "auto_reply_rules"("org_id", "priority");

-- CreateIndex
CREATE INDEX "assignment_rules_org_id_priority_idx" ON "assignment_rules"("org_id", "priority");

-- CreateIndex
CREATE INDEX "notifications_org_id_user_id_id_idx" ON "notifications"("org_id", "user_id", "id" DESC);

-- CreateIndex
CREATE INDEX "conversations_sla_due_at_idx" ON "conversations"("sla_due_at");

-- AddForeignKey
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_reply_rules" ADD CONSTRAINT "auto_reply_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ grants

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_settings, auto_reply_rules, assignment_rules TO app_user;
-- Notifications are read and marked read, never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON notifications TO app_user;
REVOKE DELETE, TRUNCATE ON notifications FROM app_user;

-- ------------------------------------------------------------------ row level security

ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE auto_reply_rules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_reply_rules    FORCE ROW LEVEL SECURITY;
ALTER TABLE assignment_rules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_rules    FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       FORCE ROW LEVEL SECURITY;

CREATE POLICY automation_settings_org ON automation_settings FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY auto_reply_rules_org ON auto_reply_rules FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY assignment_rules_org ON assignment_rules FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- Anyone working in the org (the worker included) may notify a member of it. Only that member,
-- in that org, can read or mark it.
CREATE POLICY notifications_insert ON notifications FOR INSERT TO app_user
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY notifications_own ON notifications FOR SELECT TO app_user
  USING (org_id = app_current_org_id() AND user_id = app_current_user_id());
CREATE POLICY notifications_own_update ON notifications FOR UPDATE TO app_user
  USING (org_id = app_current_org_id() AND user_id = app_current_user_id())
  WITH CHECK (org_id = app_current_org_id() AND user_id = app_current_user_id());

-- ------------------------------------------------------------------ definer functions

GRANT SELECT ON conversations TO app_definer;
CREATE POLICY conversations_definer ON conversations FOR SELECT TO app_definer USING (true);

GRANT CREATE ON SCHEMA public TO app_definer;

/* Conversations whose SLA needs checking now, across every org. Only ids. */
CREATE FUNCTION sla_due_conversations(p_limit int)
  RETURNS TABLE (org_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.org_id, c.id FROM conversations c
    WHERE c.sla_due_at IS NOT NULL AND c.sla_due_at <= now()
    ORDER BY c.sla_due_at
    LIMIT LEAST(p_limit, 1000)
  $$;

ALTER FUNCTION sla_due_conversations(int) OWNER TO app_definer;
REVOKE ALL ON FUNCTION sla_due_conversations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sla_due_conversations(int) TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;
