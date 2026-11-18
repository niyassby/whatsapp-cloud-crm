-- Phase 4.4: privacy requests, erasure, workspace deletion and retention.

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "erased_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "message_retention_days" INTEGER,
ADD COLUMN     "purge_after" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "contact_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "file_key" TEXT,
    "file_size" INTEGER,
    "error" TEXT,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erased_identities" (
    "org_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erased_identities_pkey" PRIMARY KEY ("org_id","hash")
);

-- CreateIndex
CREATE INDEX "privacy_requests_org_id_created_at_idx" ON "privacy_requests"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "privacy_requests_status_expires_at_idx" ON "privacy_requests"("status", "expires_at");


-- ------------------------------------------------------------------ RLS

ALTER TABLE privacy_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests  FORCE ROW LEVEL SECURITY;
ALTER TABLE erased_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE erased_identities FORCE ROW LEVEL SECURITY;

CREATE POLICY privacy_requests_org ON privacy_requests FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY erased_identities_org ON erased_identities FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- The record of who asked for what is kept; an erased number stays erased.
REVOKE DELETE ON privacy_requests FROM app_user;
REVOKE UPDATE, DELETE ON erased_identities FROM app_user;

-- ------------------------------------------------------------------ definer functions

-- What erasure and retention touch, for app_definer only.
GRANT SELECT ON contacts, flow_runs, organizations, privacy_requests TO app_definer;
GRANT SELECT, UPDATE ON contact_consent_events, ai_logs, flow_run_steps TO app_definer;
CREATE POLICY contacts_definer_privacy ON contacts FOR SELECT TO app_definer USING (true);
CREATE POLICY flow_runs_definer_privacy ON flow_runs FOR SELECT TO app_definer USING (true);
CREATE POLICY organizations_definer_privacy ON organizations FOR SELECT TO app_definer USING (true);
CREATE POLICY privacy_requests_definer_privacy ON privacy_requests FOR SELECT TO app_definer USING (true);
CREATE POLICY contact_consent_events_definer_privacy ON contact_consent_events FOR ALL TO app_definer USING (true) WITH CHECK (true);
CREATE POLICY ai_logs_definer_privacy ON ai_logs FOR ALL TO app_definer USING (true) WITH CHECK (true);
CREATE POLICY flow_run_steps_definer_privacy ON flow_run_steps FOR ALL TO app_definer USING (true) WITH CHECK (true);

GRANT CREATE ON SCHEMA public TO app_definer;

-- Blank a contact's append-only history in the caller's own workspace: consent proof, AI logs of
-- their conversations, and their flow runs' step details. Only for a contact already marked
-- erased in the same workspace, so it cannot be used for anything but an erasure.
CREATE FUNCTION privacy_erase_contact_history(p_contact uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  BEGIN
    IF v_org IS NULL OR NOT EXISTS (
      SELECT 1 FROM contacts WHERE id = p_contact AND org_id = v_org AND erased_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'No erased contact % in this workspace', p_contact;
    END IF;
    UPDATE contact_consent_events SET proof = NULL, source = 'erased'
      WHERE org_id = v_org AND contact_id = p_contact;
    UPDATE ai_logs SET input = '[erased]', output = '[erased]', sources = '[]'::jsonb
      WHERE org_id = v_org AND conversation_id IN (
        SELECT id FROM conversations WHERE org_id = v_org AND contact_id = p_contact);
    UPDATE flow_run_steps SET detail = NULL
      WHERE org_id = v_org AND run_id IN (
        SELECT id FROM flow_runs WHERE org_id = v_org AND contact_id = p_contact);
  END
  $$;

-- Retention: blank AI log text and flow step details older than a cutoff, in every workspace,
-- a batch at a time. Returns counts only.
CREATE FUNCTION retention_blank_old(p_cutoff timestamptz, p_limit int)
  RETURNS TABLE (ai_logs int, flow_steps int)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    a int; f int;
  BEGIN
    IF p_cutoff > now() - interval '7 days' THEN
      RAISE EXCEPTION 'Retention cutoffs must be at least 7 days old';
    END IF;
    UPDATE ai_logs SET input = '[expired]', output = '[expired]', sources = '[]'::jsonb
      WHERE id IN (SELECT l.id FROM ai_logs l WHERE l.created_at < p_cutoff
                     AND l.input NOT IN ('[expired]', '[erased]') LIMIT LEAST(p_limit, 10000));
    GET DIAGNOSTICS a = ROW_COUNT;
    UPDATE flow_run_steps SET detail = NULL
      WHERE id IN (SELECT s.id FROM flow_run_steps s WHERE s.created_at < p_cutoff
                     AND s.detail IS NOT NULL LIMIT LEAST(p_limit, 10000));
    GET DIAGNOSTICS f = ROW_COUNT;
    RETURN QUERY SELECT a, f;
  END
  $$;

-- Workspaces whose deletion grace period is over. Ids only.
CREATE FUNCTION privacy_due_org_deletions(p_now timestamptz)
  RETURNS TABLE (org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT o.id FROM organizations o
    WHERE o.purge_after IS NOT NULL AND o.purge_after <= p_now AND o.deleted_at IS NULL
  $$;

-- Workspaces with a message retention period. Ids and days only.
CREATE FUNCTION retention_targets()
  RETURNS TABLE (org_id uuid, days int)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT o.id, o.message_retention_days FROM organizations o
    WHERE o.message_retention_days IS NOT NULL AND o.deleted_at IS NULL
  $$;

-- Export files past their 7 days. Ids only.
CREATE FUNCTION privacy_expired_requests(p_now timestamptz, p_limit int)
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.id, r.org_id FROM privacy_requests r
    WHERE r.status = 'done' AND r.expires_at IS NOT NULL AND r.expires_at <= p_now
    LIMIT LEAST(p_limit, 1000)
  $$;

DO $$
DECLARE
  sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'privacy_erase_contact_history(uuid)',
    'retention_blank_old(timestamptz, int)',
    'privacy_due_org_deletions(timestamptz)',
    'retention_targets()',
    'privacy_expired_requests(timestamptz, int)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', sig);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM app_definer;
