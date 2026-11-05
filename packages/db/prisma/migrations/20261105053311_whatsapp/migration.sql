-- CreateEnum
CREATE TYPE "WabaStatus" AS ENUM ('active', 'disconnected');

-- CreateEnum
CREATE TYPE "PhoneNumberStatus" AS ENUM ('pending', 'connected', 'registration_failed', 'disconnected');

-- CreateEnum
CREATE TYPE "CredentialSource" AS ENUM ('embedded_signup', 'manual');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'routed', 'processed', 'ignored', 'failed');

-- CreateEnum
CREATE TYPE "DataDeletionStatus" AS ENUM ('received', 'completed');

-- CreateTable
CREATE TABLE "waba_accounts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT,
    "timezone_id" TEXT,
    "template_namespace" TEXT,
    "status" "WabaStatus" NOT NULL DEFAULT 'active',
    "meta_user_id" TEXT,
    "connected_by_id" UUID,
    "webhook_subscribed_at" TIMESTAMPTZ(3),
    "disconnected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waba_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "waba_account_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "quality_rating" TEXT,
    "messaging_tier" TEXT,
    "code_verification_status" TEXT,
    "name_status" TEXT,
    "platform_type" TEXT,
    "status" "PhoneNumberStatus" NOT NULL DEFAULT 'pending',
    "status_reason" TEXT,
    "credential_source" "CredentialSource" NOT NULL,
    "access_token_enc" TEXT,
    "registration_pin_enc" TEXT,
    "registered_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "disconnected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "org_id" UUID,
    "provider" TEXT NOT NULL DEFAULT 'meta',
    "dedupe_key" TEXT NOT NULL,
    "waba_id" TEXT,
    "phone_number_id" TEXT,
    "field" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_deletion_requests" (
    "id" UUID NOT NULL,
    "meta_user_id" TEXT NOT NULL,
    "confirmation_code" TEXT NOT NULL,
    "status" "DataDeletionStatus" NOT NULL DEFAULT 'received',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waba_accounts_meta_user_id_idx" ON "waba_accounts"("meta_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "waba_accounts_org_id_waba_id_key" ON "waba_accounts"("org_id", "waba_id");

-- CreateIndex
CREATE INDEX "phone_numbers_waba_account_id_idx" ON "phone_numbers"("waba_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_org_id_phone_number_id_key" ON "phone_numbers"("org_id", "phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_org_id_received_at_id_idx" ON "webhook_events"("org_id", "received_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "data_deletion_requests_confirmation_code_key" ON "data_deletion_requests"("confirmation_code");

-- AddForeignKey
ALTER TABLE "waba_accounts" ADD CONSTRAINT "waba_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waba_accounts" ADD CONSTRAINT "waba_accounts_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_waba_account_id_fkey" FOREIGN KEY ("waba_account_id") REFERENCES "waba_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: uniqueness, grants, RLS and pre-tenant functions.
-- ============================================================================

-- A WABA or number is live in at most one org; disconnected rows may be reconnected elsewhere.
CREATE UNIQUE INDEX "waba_accounts_active_waba_key" ON "waba_accounts" ("waba_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "phone_numbers_active_phone_key" ON "phone_numbers" ("phone_number_id") WHERE "status" <> 'disconnected';

-- Default privileges granted everything; narrow each table to what the app does.
REVOKE DELETE ON "waba_accounts", "phone_numbers" FROM app_user;       -- disconnect is soft
REVOKE INSERT, DELETE ON "webhook_events" FROM app_user;               -- via functions only
REVOKE ALL ON "data_deletion_requests" FROM app_user;                  -- via functions only

ALTER TABLE "waba_accounts"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waba_accounts"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "phone_numbers"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "phone_numbers"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "data_deletion_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_deletion_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY waba_accounts_org ON "waba_accounts" FOR ALL TO app_user
  USING ("org_id" = app_current_org_id()) WITH CHECK ("org_id" = app_current_org_id());
CREATE POLICY phone_numbers_org ON "phone_numbers" FOR ALL TO app_user
  USING ("org_id" = app_current_org_id()) WITH CHECK ("org_id" = app_current_org_id());
-- Unrouted events (org_id null) are invisible to tenants. UPDATE exists for replay.
CREATE POLICY webhook_events_org ON "webhook_events" FOR ALL TO app_user
  USING ("org_id" = app_current_org_id()) WITH CHECK ("org_id" = app_current_org_id());

-- ---------------------------------------------------------------- pre-tenant functions
-- Same pattern as *_auth: owned by NOLOGIN app_definer, pinned search_path, EXECUTE for app_user
-- only. Unlike the auth lookups some of these write, because a webhook has no tenant yet; each
-- one does a single narrow thing and none returns a credential.
GRANT CREATE ON SCHEMA public TO app_definer; -- required to take ownership; revoked below

GRANT SELECT ON "waba_accounts", "phone_numbers" TO app_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_events" TO app_definer;
GRANT SELECT, INSERT, UPDATE ON "data_deletion_requests" TO app_definer;

CREATE POLICY waba_accounts_definer_read ON "waba_accounts" FOR SELECT TO app_definer USING (true);
CREATE POLICY phone_numbers_definer_read ON "phone_numbers" FOR SELECT TO app_definer USING (true);
CREATE POLICY webhook_events_definer ON "webhook_events" FOR ALL TO app_definer USING (true) WITH CHECK (true);
CREATE POLICY data_deletion_definer ON "data_deletion_requests" FOR ALL TO app_definer USING (true) WITH CHECK (true);

-- Idempotent: a redelivery returns the existing row, so the caller can re-enqueue safely.
CREATE FUNCTION webhook_event_ingest(p_dedupe text, p_waba text, p_phone text, p_field text, p_payload jsonb)
  RETURNS TABLE (id uuid, status "WebhookEventStatus", inserted boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
      INSERT INTO webhook_events (id, dedupe_key, waba_id, phone_number_id, field, payload)
      VALUES (gen_random_uuid(), p_dedupe, p_waba, p_phone, p_field, p_payload)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING webhook_events.id, webhook_events.status, true;
    IF NOT FOUND THEN
      RETURN QUERY
        SELECT w.id, w.status, false FROM webhook_events w WHERE w.dedupe_key = p_dedupe;
    END IF;
  END
  $$;

CREATE FUNCTION webhook_event_load(p_id uuid)
  RETURNS TABLE (id uuid, org_id uuid, waba_id text, phone_number_id text, field text,
                 payload jsonb, status "WebhookEventStatus")
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.org_id, w.waba_id, w.phone_number_id, w.field, w.payload, w.status
    FROM webhook_events w WHERE w.id = p_id
  $$;

-- Which org currently owns this number or WABA. The number wins when both are known.
CREATE FUNCTION webhook_route_lookup(p_phone text, p_waba text)
  RETURNS TABLE (org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.o FROM (
      SELECT p.org_id AS o, 1 AS rank FROM phone_numbers p
        WHERE p.phone_number_id = p_phone AND p.status <> 'disconnected'
      UNION ALL
      SELECT w.org_id, 2 FROM waba_accounts w
        WHERE w.waba_id = p_waba AND w.status = 'active'
    ) r ORDER BY r.rank LIMIT 1
  $$;

-- Once routed, an event's org can never change.
CREATE FUNCTION webhook_event_mark(p_id uuid, p_status "WebhookEventStatus", p_org uuid, p_error text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE webhook_events w
       SET status = p_status,
           org_id = COALESCE(w.org_id, p_org),
           error = p_error,
           attempts = w.attempts + 1,
           processed_at = now()
     WHERE w.id = p_id;
    RETURN FOUND;
  END
  $$;

-- Retention. Refuses to touch anything newer than a day, whatever the caller passes.
CREATE FUNCTION webhook_events_purge(p_before timestamptz)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE n integer;
  BEGIN
    DELETE FROM webhook_events w
     WHERE w.received_at < LEAST(p_before, now() - interval '1 day');
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;

-- Connections made by a Facebook user (deauthorize and data deletion callbacks).
CREATE FUNCTION meta_connections_by_user(p_meta_user text)
  RETURNS TABLE (org_id uuid, waba_account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT w.org_id, w.id FROM waba_accounts w
    WHERE w.meta_user_id = p_meta_user
  $$;

CREATE FUNCTION data_deletion_create(p_meta_user text, p_code text)
  RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    INSERT INTO data_deletion_requests (id, meta_user_id, confirmation_code)
    VALUES (gen_random_uuid(), p_meta_user, p_code)
    RETURNING id
  $$;

CREATE FUNCTION data_deletion_status(p_code text)
  RETURNS TABLE (status "DataDeletionStatus", requested_at timestamptz, completed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT d.status, d.requested_at, d.completed_at
    FROM data_deletion_requests d WHERE d.confirmation_code = p_code
  $$;

-- The Facebook user id is erased too, once the request is done.
CREATE FUNCTION data_deletion_complete(p_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE data_deletion_requests d
       SET status = 'completed', completed_at = now(), meta_user_id = 'erased'
     WHERE d.id = p_id;
    RETURN FOUND;
  END
  $$;

-- Key rotation: which rows hold ciphertext. Ids only; the re-encrypt job then works under RLS.
CREATE FUNCTION secrets_list_phone_numbers()
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.org_id FROM phone_numbers p
    WHERE p.access_token_enc IS NOT NULL OR p.registration_pin_enc IS NOT NULL
  $$;

CREATE FUNCTION secrets_list_totp_users()
  RETURNS TABLE (id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id FROM users u WHERE u.totp_secret_enc IS NOT NULL
  $$;

DO $$
DECLARE
  sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'webhook_event_ingest(text, text, text, text, jsonb)',
    'webhook_event_load(uuid)',
    'webhook_route_lookup(text, text)',
    'webhook_event_mark(uuid, "WebhookEventStatus", uuid, text)',
    'webhook_events_purge(timestamptz)',
    'meta_connections_by_user(text)',
    'data_deletion_create(text, text)',
    'data_deletion_status(text)',
    'data_deletion_complete(uuid)',
    'secrets_list_phone_numbers()',
    'secrets_list_totp_users()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', sig);
  END LOOP;
END
$$;

REVOKE CREATE ON SCHEMA public FROM app_definer;
