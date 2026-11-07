-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "secret_enc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "response_status" INTEGER,
    "response_body" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "delivered_at" TIMESTAMPTZ(3),
    "replay_of_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_org_id_idx" ON "webhook_endpoints"("org_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_id_idx" ON "webhook_deliveries"("endpoint_id", "id" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries"("created_at");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ grants

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO app_user;
-- The log is not edited or trimmed by the app. Retention goes through a definer function.
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO app_user;
REVOKE DELETE, TRUNCATE ON webhook_deliveries FROM app_user;

-- ------------------------------------------------------------------ row level security

ALTER TABLE webhook_endpoints  ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints  FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_endpoints_org ON webhook_endpoints FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY webhook_deliveries_org ON webhook_deliveries FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- ------------------------------------------------------------------ definer functions

GRANT SELECT ON api_keys, webhook_endpoints TO app_definer;
GRANT SELECT, DELETE ON webhook_deliveries TO app_definer;
CREATE POLICY api_keys_definer ON api_keys FOR SELECT TO app_definer USING (true);
CREATE POLICY webhook_endpoints_definer ON webhook_endpoints FOR SELECT TO app_definer USING (true);
CREATE POLICY webhook_deliveries_definer ON webhook_deliveries FOR ALL TO app_definer USING (true) WITH CHECK (true);

GRANT CREATE ON SCHEMA public TO app_definer;

/* Keyed by the prefix inside a key someone presented. The caller checks the hash itself. */
CREATE FUNCTION api_key_lookup(p_prefix text)
  RETURNS TABLE (
    id uuid, org_id uuid, key_hash text, scopes text[], created_by_id uuid,
    expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT k.id, k.org_id, k.key_hash, k.scopes, k.created_by_id,
           k.expires_at, k.revoked_at, k.last_used_at
    FROM api_keys k WHERE k.prefix = p_prefix
  $$;

/* What the worker should try now. Only ids: it reads each one under that org's context. */
CREATE FUNCTION webhook_due_deliveries(p_limit int)
  RETURNS TABLE (org_id uuid, id uuid, next_attempt_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT d.org_id, d.id, d.next_attempt_at FROM webhook_deliveries d
    WHERE d.status = 'pending' AND d.next_attempt_at <= now()
    ORDER BY d.next_attempt_at
    LIMIT LEAST(p_limit, 1000)
  $$;

/* Retention. Never touches an unfinished delivery, or anything under a day old. */
CREATE FUNCTION webhook_deliveries_purge(p_before timestamptz)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE n integer;
  BEGIN
    DELETE FROM webhook_deliveries d
    WHERE d.created_at < LEAST(p_before, now() - interval '1 day') AND d.status <> 'pending';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;

/* For key rotation. */
CREATE FUNCTION secrets_list_webhook_endpoints()
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT e.id, e.org_id FROM webhook_endpoints e $$;

DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'api_key_lookup(text)',
    'webhook_due_deliveries(int)',
    'webhook_deliveries_purge(timestamptz)',
    'secrets_list_webhook_endpoints()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', sig);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM app_definer;
