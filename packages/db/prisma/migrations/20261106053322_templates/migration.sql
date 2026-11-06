-- AlterTable
ALTER TABLE "waba_accounts" ADD COLUMN     "templates_synced_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "waba_account_id" UUID NOT NULL,
    "meta_template_id" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "parameter_format" TEXT NOT NULL DEFAULT 'positional',
    "definition" JSONB,
    "samples" JSONB NOT NULL DEFAULT '{}',
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',
    "supported" BOOLEAN NOT NULL DEFAULT true,
    "rejected_reason" TEXT,
    "status_detail" TEXT,
    "quality_score" TEXT,
    "header_media_key" TEXT,
    "header_media_mime" TEXT,
    "header_media_name" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "status_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_templates_org_id_meta_template_id_idx" ON "message_templates"("org_id", "meta_template_id");

-- CreateIndex
CREATE INDEX "message_templates_org_id_created_at_id_idx" ON "message_templates"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_org_id_waba_account_id_name_language_key" ON "message_templates"("org_id", "waba_account_id", "name", "language");

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_waba_account_id_fkey" FOREIGN KEY ("waba_account_id") REFERENCES "waba_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: RLS and the lookup the reconciliation job needs.
-- ============================================================================

ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY message_templates_org ON "message_templates" FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- The job runs for every tenant, so it starts with no org context. Returns only ids, and only
-- for WABAs with a connected number, since those are the ones with a token to call Meta with.
GRANT CREATE ON SCHEMA public TO app_definer;

CREATE FUNCTION template_sync_targets()
  RETURNS TABLE (org_id uuid, waba_account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $fn$
    SELECT DISTINCT w.org_id, w.id FROM waba_accounts w
      JOIN phone_numbers p ON p.waba_account_id = w.id
     WHERE w.status = 'active' AND p.status = 'connected'
  $fn$;

ALTER FUNCTION template_sync_targets() OWNER TO app_definer;
REVOKE ALL ON FUNCTION template_sync_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION template_sync_targets() TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;
