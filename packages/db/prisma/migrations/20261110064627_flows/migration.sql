-- CreateTable
CREATE TABLE "flows" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "trigger_type" TEXT NOT NULL DEFAULT 'manual',
    "trigger" JSONB NOT NULL DEFAULT '{"type":"manual"}',
    "draft" JSONB NOT NULL,
    "published_version_id" UUID,
    "created_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_runs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "conversation_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'running',
    "current_node_id" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "trigger" JSONB NOT NULL DEFAULT '{}',
    "awaiting" JSONB,
    "input" JSONB,
    "wake_at" TIMESTAMPTZ(3),
    "steps" INTEGER NOT NULL DEFAULT 0,
    "steps_since_wait" INTEGER NOT NULL DEFAULT 0,
    "end_reason" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_run_steps" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "flows_published_version_id_key" ON "flows"("published_version_id");

-- CreateIndex
CREATE INDEX "flows_org_id_active_trigger_type_idx" ON "flows"("org_id", "active", "trigger_type");

-- CreateIndex
CREATE INDEX "flow_versions_org_id_idx" ON "flow_versions"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "flow_versions_flow_id_version_key" ON "flow_versions"("flow_id", "version");

-- CreateIndex
CREATE INDEX "flow_runs_status_wake_at_idx" ON "flow_runs"("status", "wake_at");

-- CreateIndex
CREATE INDEX "flow_runs_org_id_flow_id_id_idx" ON "flow_runs"("org_id", "flow_id", "id" DESC);

-- CreateIndex
CREATE INDEX "flow_runs_contact_id_flow_id_idx" ON "flow_runs"("contact_id", "flow_id");

-- CreateIndex
CREATE INDEX "flow_run_steps_run_id_id_idx" ON "flow_run_steps"("run_id", "id");

-- CreateIndex
CREATE INDEX "flow_run_steps_org_id_idx" ON "flow_run_steps"("org_id");

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "flow_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ checks

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_status_check
  CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled'));

-- One run under way per conversation. Messages go to that run; triggers wait for it to end.
CREATE UNIQUE INDEX flow_runs_one_active_per_conversation ON flow_runs (conversation_id)
  WHERE status IN ('running', 'waiting');

-- ------------------------------------------------------------------ grants

GRANT SELECT, INSERT, UPDATE ON flows, flow_runs TO app_user;
REVOKE DELETE, TRUNCATE ON flows, flow_runs FROM app_user;
-- A published version never changes, and the run history is append-only.
GRANT SELECT, INSERT ON flow_versions, flow_run_steps TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON flow_versions, flow_run_steps FROM app_user;

-- ------------------------------------------------------------------ row level security

ALTER TABLE flows          ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows          FORCE ROW LEVEL SECURITY;
ALTER TABLE flow_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_versions  FORCE ROW LEVEL SECURITY;
ALTER TABLE flow_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_runs      FORCE ROW LEVEL SECURITY;
ALTER TABLE flow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_run_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY flows_org ON flows FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY flow_versions_org ON flow_versions FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY flow_runs_org ON flow_runs FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY flow_run_steps_org ON flow_run_steps FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- ------------------------------------------------------------------ definer functions

GRANT SELECT ON flow_runs TO app_definer;
CREATE POLICY flow_runs_definer ON flow_runs FOR SELECT TO app_definer USING (true);

GRANT CREATE ON SCHEMA public TO app_definer;

/* Runs to pick up, across every org: due to wake, or left running by a crash. Only ids. */
CREATE FUNCTION flow_due_runs(p_stalled_before timestamptz, p_limit int)
  RETURNS TABLE (org_id uuid, id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    (SELECT r.org_id, r.id, r.status FROM flow_runs r
      WHERE r.status = 'waiting' AND r.wake_at <= now()
      ORDER BY r.wake_at
      LIMIT LEAST(p_limit, 1000))
    UNION ALL
    (SELECT r.org_id, r.id, r.status FROM flow_runs r
      WHERE r.status = 'running' AND r.updated_at < p_stalled_before
      ORDER BY r.updated_at
      LIMIT LEAST(p_limit, 1000))
  $$;
ALTER FUNCTION flow_due_runs(timestamptz, int) OWNER TO app_definer;
REVOKE ALL ON FUNCTION flow_due_runs(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION flow_due_runs(timestamptz, int) TO app_user;

/*
 * Outbound messages still queued a while after they were created: the job that should send them
 * was never queued (a crash between commit and enqueue). Ids only; queueing again is a no-op for
 * a message whose job exists, since the job id is the message id. A day back at most, which also
 * bounds the partitions read.
 */
GRANT SELECT ON messages TO app_definer;
CREATE POLICY messages_definer ON messages FOR SELECT TO app_definer USING (true);
CREATE FUNCTION outbound_stuck_messages(p_before timestamptz, p_limit int)
  RETURNS TABLE (org_id uuid, id uuid, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.org_id, m.id, m.created_at FROM messages m
    WHERE m.direction = 'outbound' AND m.status = 'queued'
      AND m.created_at > now() - interval '1 day' AND m.created_at < p_before
      -- Campaigns and drips send in their own jobs and recover their own sends.
      AND NOT COALESCE(m.content ?| array['campaignId', 'dripSequenceId'], false)
    ORDER BY m.created_at
    LIMIT LEAST(p_limit, 1000)
  $$;
ALTER FUNCTION outbound_stuck_messages(timestamptz, int) OWNER TO app_definer;
REVOKE ALL ON FUNCTION outbound_stuck_messages(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_stuck_messages(timestamptz, int) TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;

-- ------------------------------------------------------------------ plans

-- Flows are on every paid plan. Plans are config: pnpm plans:import changes them later.
UPDATE plans SET features = features || '["flows"]'::jsonb
  WHERE code IN ('starter', 'growth', 'scale') AND NOT features ? 'flows';
