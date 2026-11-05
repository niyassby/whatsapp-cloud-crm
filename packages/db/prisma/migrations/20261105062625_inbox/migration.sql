-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound', 'internal');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('pending', 'stored', 'failed');

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "wa_id" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',
    "assignee_id" UUID,
    "window_expires_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "last_message_preview" TEXT,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "body" TEXT,
    "content" JSONB,
    "sender_user_id" UUID,
    "wa_message_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "media_meta_id" TEXT,
    "media_key" TEXT,
    "media_mime" TEXT,
    "media_size" INTEGER,
    "media_filename" TEXT,
    "media_status" "MediaStatus",
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id","created_at")
) PARTITION BY RANGE ("created_at");

-- CreateTable
CREATE TABLE "message_refs" (
    "org_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "message_created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_refs_pkey" PRIMARY KEY ("org_id","kind","ref")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_labels" (
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,

    CONSTRAINT "conversation_labels_pkey" PRIMARY KEY ("conversation_id","label_id")
);

-- CreateTable
CREATE TABLE "canned_replies" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_org_id_wa_id_key" ON "contacts"("org_id", "wa_id");

-- CreateIndex
CREATE INDEX "conversations_org_id_last_message_at_id_idx" ON "conversations"("org_id", "last_message_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "conversations_org_id_assignee_id_idx" ON "conversations"("org_id", "assignee_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_org_id_phone_id_contact_id_key" ON "conversations"("org_id", "phone_id", "contact_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "labels_org_id_name_key" ON "labels"("org_id", "name");

-- CreateIndex
CREATE INDEX "conversation_labels_org_id_idx" ON "conversation_labels"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_replies_org_id_shortcut_key" ON "canned_replies"("org_id", "shortcut");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_replies" ADD CONSTRAINT "canned_replies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_replies" ADD CONSTRAINT "canned_replies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: partitions, grants, RLS.
-- ============================================================================

-- A partition can be queried directly, and that skips the parent's RLS policies. So partitions
-- live in their own schema, and the app role gets no access to it at all: every read and write
-- goes through public.messages, where RLS applies. (Also keeps Prisma, which only looks at
-- `public`, from treating monthly partitions as drift.)
CREATE SCHEMA message_partitions;

-- Safety net so an insert never fails if the partition job has stopped running.
CREATE TABLE message_partitions.messages_default PARTITION OF "messages" DEFAULT;

-- Owned by the migrating role (creating a partition requires owning the parent). Takes only a
-- date and a bounded month count, so callers cannot influence the DDL beyond which months exist.
CREATE FUNCTION ensure_message_partitions(p_from date, p_months integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    m date := date_trunc('month', p_from)::date;
    created integer := 0;
    name text;
    i integer;
  BEGIN
    IF p_months < 1 OR p_months > 24 THEN
      RAISE EXCEPTION 'p_months must be between 1 and 24';
    END IF;
    FOR i IN 1..p_months LOOP
      name := 'messages_' || to_char(m, 'YYYY_MM');
      IF to_regclass('message_partitions.' || name) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE message_partitions.%I PARTITION OF public.messages FOR VALUES FROM (%L) TO (%L)',
          name, m::text || ' 00:00:00+00', (m + interval '1 month')::date::text || ' 00:00:00+00'
        );
        created := created + 1;
      END IF;
      m := (m + interval '1 month')::date;
    END LOOP;
    RETURN created;
  END
  $$;

REVOKE ALL ON FUNCTION ensure_message_partitions(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_message_partitions(date, integer) TO app_user;

SELECT ensure_message_partitions(current_date, 4);

-- History is not deleted by the app.
REVOKE DELETE ON "contacts", "conversations", "messages", "message_refs" FROM app_user;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts', 'conversations', 'messages', 'message_refs',
    'labels', 'conversation_labels', 'canned_replies'
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
