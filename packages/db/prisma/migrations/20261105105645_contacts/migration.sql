-- CreateEnum
CREATE TYPE "ContactOptInStatus" AS ENUM ('unknown', 'opted_in', 'opted_out');

-- CreateEnum
CREATE TYPE "ContactFieldType" AS ENUM ('text', 'number', 'date', 'boolean', 'select');

-- CreateEnum
CREATE TYPE "ContactJobKind" AS ENUM ('import', 'export');

-- CreateEnum
CREATE TYPE "ContactJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "email" TEXT,
ADD COLUMN     "last_activity_at" TIMESTAMPTZ(3),
ADD COLUMN     "merged_into_id" UUID,
ADD COLUMN     "opt_in_at" TIMESTAMPTZ(3),
ADD COLUMN     "opt_in_proof" TEXT,
ADD COLUMN     "opt_in_source" TEXT,
ADD COLUMN     "opt_in_status" "ContactOptInStatus" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "opt_out_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "opt_out_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "contact_fields" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "ContactFieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_notes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_consent_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "ContactOptInStatus" NOT NULL,
    "source" TEXT,
    "proof" TEXT,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_jobs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "ContactJobKind" NOT NULL,
    "status" "ContactJobStatus" NOT NULL DEFAULT 'queued',
    "created_by_id" UUID,
    "filename" TEXT,
    "options" JSONB NOT NULL,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "result_key" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contact_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_org_id_name_key" ON "tags"("org_id", "name");

-- CreateIndex
CREATE INDEX "contact_tags_tag_id_idx" ON "contact_tags"("tag_id");

-- CreateIndex
CREATE INDEX "contact_tags_org_id_idx" ON "contact_tags"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_fields_org_id_key_key" ON "contact_fields"("org_id", "key");

-- CreateIndex
CREATE INDEX "contact_notes_contact_id_created_at_idx" ON "contact_notes"("contact_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contact_notes_org_id_idx" ON "contact_notes"("org_id");

-- CreateIndex
CREATE INDEX "contact_consent_events_contact_id_created_at_idx" ON "contact_consent_events"("contact_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contact_consent_events_org_id_idx" ON "contact_consent_events"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "segments_org_id_name_key" ON "segments"("org_id", "name");

-- CreateIndex
CREATE INDEX "contact_jobs_org_id_created_at_idx" ON "contact_jobs"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contacts_org_id_created_at_id_idx" ON "contacts"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "contacts_org_id_opt_in_status_idx" ON "contacts"("org_id", "opt_in_status");

-- CreateIndex
CREATE INDEX "contacts_org_id_last_activity_at_idx" ON "contacts"("org_id", "last_activity_at");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_fields" ADD CONSTRAINT "contact_fields_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consent_events" ADD CONSTRAINT "contact_consent_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_jobs" ADD CONSTRAINT "contact_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_jobs" ADD CONSTRAINT "contact_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: backfill, grants, RLS.
-- ============================================================================

-- Existing contacts have talked to the business; their last activity is already known.
UPDATE "contacts" c
SET "last_activity_at" = (
  SELECT max(v."last_message_at") FROM "conversations" v WHERE v."contact_id" = c."id"
);

-- Proof of consent is append-only.
REVOKE UPDATE, DELETE ON "contact_consent_events" FROM app_user;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tags', 'contact_tags', 'contact_fields', 'contact_notes',
    'contact_consent_events', 'segments', 'contact_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO app_user USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id())',
      t || '_org', t
    );
  END LOOP;
END
$$;
