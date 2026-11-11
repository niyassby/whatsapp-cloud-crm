-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connector_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "credentials_enc" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "webhook_token" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "last_health_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "sync_every_minutes" INTEGER,
    "sync_cursor" JSONB,
    "last_sync_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "type" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_event_claims" (
    "connection_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "org_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_event_claims_pkey" PRIMARY KEY ("connection_id","external_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_webhook_token_key" ON "integration_connections"("webhook_token");

-- CreateIndex
CREATE INDEX "integration_connections_org_id_connector_key_idx" ON "integration_connections"("org_id", "connector_key");

-- CreateIndex
CREATE INDEX "integration_events_org_id_connection_id_id_idx" ON "integration_events"("org_id", "connection_id", "id" DESC);

-- CreateIndex
CREATE INDEX "integration_events_status_next_attempt_at_idx" ON "integration_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_events_connection_id_direction_dedupe_key_key" ON "integration_events"("connection_id", "direction", "dedupe_key");

-- CreateIndex
CREATE INDEX "integration_event_claims_org_id_idx" ON "integration_event_claims"("org_id");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_event_claims" ADD CONSTRAINT "integration_event_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ checks

ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_status_check
  CHECK (status IN ('connected', 'error', 'needs_reconnect', 'disconnected'));
ALTER TABLE integration_events ADD CONSTRAINT integration_events_direction_check
  CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE integration_events ADD CONSTRAINT integration_events_status_check
  CHECK (status IN ('received', 'processed', 'ignored', 'succeeded', 'failed'));

-- ------------------------------------------------------------------ grants

-- Connections are disconnected, not deleted, so their event log keeps its meaning.
GRANT SELECT, INSERT, UPDATE ON integration_connections, integration_events TO app_user;
REVOKE DELETE, TRUNCATE ON integration_connections, integration_events FROM app_user;
-- Claims only ever grow: one per outside event that was acted on.
GRANT SELECT, INSERT ON integration_event_claims TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON integration_event_claims FROM app_user;

-- ------------------------------------------------------------------ row level security

ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events      FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_event_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_event_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_connections_org ON integration_connections FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY integration_events_org ON integration_events FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY integration_event_claims_org ON integration_event_claims FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- ------------------------------------------------------------------ definer functions

GRANT SELECT ON integration_connections TO app_definer;
CREATE POLICY integration_connections_definer ON integration_connections FOR SELECT
  TO app_definer USING (true);

GRANT CREATE ON SCHEMA public TO app_definer;

/* A webhook arrives before any org is known: find its connection by the token in the address. */
CREATE FUNCTION integration_connection_by_token(p_token text)
  RETURNS TABLE (org_id uuid, id uuid, connector_key text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.org_id, c.id, c.connector_key, c.status FROM integration_connections c
    WHERE c.webhook_token = p_token AND length(p_token) >= 32
  $$;
ALTER FUNCTION integration_connection_by_token(text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION integration_connection_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_connection_by_token(text) TO app_user;

/*
 * Background work due across every org: tokens about to expire, health checks an hour old, and
 * syncs whose interval has passed. Ids and the kind of work only.
 */
CREATE FUNCTION integration_due_work(p_limit int)
  RETURNS TABLE (org_id uuid, id uuid, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    (SELECT c.org_id, c.id, 'refresh'::text FROM integration_connections c
      WHERE c.status = 'connected' AND c.token_expires_at IS NOT NULL
        AND c.token_expires_at < now() + interval '10 minutes'
      LIMIT LEAST(p_limit, 1000))
    UNION ALL
    (SELECT c.org_id, c.id, 'health'::text FROM integration_connections c
      WHERE c.status IN ('connected', 'error')
        AND (c.last_health_at IS NULL OR c.last_health_at < now() - interval '1 hour')
      LIMIT LEAST(p_limit, 1000))
    UNION ALL
    (SELECT c.org_id, c.id, 'sync'::text FROM integration_connections c
      WHERE c.status = 'connected' AND c.sync_every_minutes IS NOT NULL
        AND (c.last_sync_at IS NULL
             OR c.last_sync_at < now() - make_interval(mins => c.sync_every_minutes))
      LIMIT LEAST(p_limit, 1000))
  $$;
ALTER FUNCTION integration_due_work(int) OWNER TO app_definer;
REVOKE ALL ON FUNCTION integration_due_work(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_due_work(int) TO app_user;

/* For key rotation (pnpm secrets:reencrypt): connections holding credentials. Ids only. */
CREATE FUNCTION secrets_list_integration_connections()
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.org_id FROM integration_connections c WHERE c.credentials_enc IS NOT NULL
  $$;
ALTER FUNCTION secrets_list_integration_connections() OWNER TO app_definer;
REVOKE ALL ON FUNCTION secrets_list_integration_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION secrets_list_integration_connections() TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;

-- ------------------------------------------------------------------ plans

-- Integrations are on Growth and Scale (and the Growth trial). Plans are config: plans:import changes them.
UPDATE plans SET features = features || '["integrations"]'::jsonb
  WHERE code IN ('growth', 'scale') AND NOT features ? 'integrations';
