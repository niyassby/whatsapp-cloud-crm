-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('whatsapp', 'instagram', 'webchat');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('active', 'disconnected');

-- DropIndex
DROP INDEX "conversations_org_id_phone_id_contact_id_key";

-- AlterTable
ALTER TABLE "contacts" ALTER COLUMN "wa_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "ad_headline" TEXT,
ADD COLUMN     "ad_source_id" TEXT,
ADD COLUMN     "channel_id" UUID,
ALTER COLUMN "phone_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "waba_accounts" ADD COLUMN     "catalog_id" TEXT,
ADD COLUMN     "catalog_synced_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'active',
    "phone_id" UUID,
    "external_id" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentials_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "connected_by_id" UUID,
    "disconnected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_identities" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "handle" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_referrals" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel_kind" "ChannelKind" NOT NULL,
    "source_type" TEXT,
    "source_id" TEXT,
    "source_url" TEXT,
    "headline" TEXT,
    "body" TEXT,
    "media_type" TEXT,
    "click_id" TEXT,
    "new_contact" BOOLEAN NOT NULL DEFAULT false,
    "message_id" UUID NOT NULL,
    "message_created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefilled_message" TEXT NOT NULL,
    "deep_link_url" TEXT NOT NULL,
    "created_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_products" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "retailer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" TEXT,
    "currency" TEXT,
    "image_url" TEXT,
    "availability" TEXT,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_groups" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "group_id" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "join_approval_mode" TEXT NOT NULL DEFAULT 'approval_required',
    "invite_link" TEXT,
    "participant_count" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "wa_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "meta_call_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "answered_by_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "connected_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "duration_sec" INTEGER,
    "message_id" UUID NOT NULL,
    "message_created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channels_phone_id_key" ON "channels"("phone_id");

-- CreateIndex
CREATE INDEX "channels_org_id_kind_idx" ON "channels"("org_id", "kind");

-- CreateIndex
CREATE INDEX "channels_kind_external_id_idx" ON "channels"("kind", "external_id");

-- CreateIndex
CREATE INDEX "contact_identities_org_id_contact_id_idx" ON "contact_identities"("org_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_identities_channel_id_external_id_key" ON "contact_identities"("channel_id", "external_id");

-- CreateIndex
CREATE INDEX "ad_referrals_org_id_created_at_idx" ON "ad_referrals"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "ad_referrals_org_id_source_id_created_at_idx" ON "ad_referrals"("org_id", "source_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ad_referrals_org_id_message_id_key" ON "ad_referrals"("org_id", "message_id");

-- CreateIndex
CREATE INDEX "qr_codes_org_id_created_at_idx" ON "qr_codes"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "qr_codes_org_id_code_key" ON "qr_codes"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_products_org_id_catalog_id_retailer_id_key" ON "catalog_products"("org_id", "catalog_id", "retailer_id");

-- CreateIndex
CREATE INDEX "wa_groups_org_id_created_at_idx" ON "wa_groups"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wa_groups_org_id_group_id_key" ON "wa_groups"("org_id", "group_id");

-- CreateIndex
CREATE INDEX "calls_org_id_started_at_idx" ON "calls"("org_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "calls_org_id_meta_call_id_key" ON "calls"("org_id", "meta_call_id");

-- CreateIndex
CREATE INDEX "conversations_org_id_phone_id_contact_id_idx" ON "conversations"("org_id", "phone_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_org_id_channel_id_contact_id_key" ON "conversations"("org_id", "channel_id", "contact_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_referrals" ADD CONSTRAINT "ad_referrals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_referrals" ADD CONSTRAINT "ad_referrals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_referrals" ADD CONSTRAINT "ad_referrals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ------------------------------------------------------------------ backfill
-- Every phone number becomes a WhatsApp channel, and its conversations move onto it.
INSERT INTO channels (id, org_id, kind, name, status, phone_id, disconnected_at, created_at, updated_at)
SELECT gen_random_uuid(), p.org_id, 'whatsapp',
       COALESCE(p.verified_name, p.display_phone_number, 'WhatsApp'),
       CASE WHEN p.status = 'disconnected' THEN 'disconnected'::"ChannelStatus" ELSE 'active'::"ChannelStatus" END,
       p.id, p.disconnected_at, p.created_at, now()
FROM phone_numbers p;

UPDATE conversations c SET channel_id = ch.id FROM channels ch WHERE ch.phone_id = c.phone_id;
ALTER TABLE conversations ALTER COLUMN channel_id SET NOT NULL;

-- ------------------------------------------------------------------ checks
ALTER TABLE channels ADD CONSTRAINT channels_whatsapp_phone CHECK ((kind = 'whatsapp') = (phone_id IS NOT NULL));
ALTER TABLE channels ADD CONSTRAINT channels_external_id CHECK (kind = 'whatsapp' OR external_id IS NOT NULL);
-- An Instagram account or widget key is live in one place at a time (like a WABA).
CREATE UNIQUE INDEX channels_live_external ON channels (kind, external_id)
  WHERE status = 'active' AND external_id IS NOT NULL;
ALTER TABLE calls ADD CONSTRAINT calls_direction CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE wa_groups ADD CONSTRAINT wa_groups_status CHECK (status IN ('pending', 'active', 'deleted'));

-- ------------------------------------------------------------------ grants
REVOKE UPDATE, DELETE, TRUNCATE ON ad_referrals FROM app_user;   -- append-only
REVOKE DELETE, TRUNCATE ON channels, calls, qr_codes, wa_groups FROM app_user;

-- ------------------------------------------------------------------ row level security
ALTER TABLE channels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels           FORCE ROW LEVEL SECURITY;
ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE ad_referrals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_referrals       FORCE ROW LEVEL SECURITY;
ALTER TABLE qr_codes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_codes           FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_products   FORCE ROW LEVEL SECURITY;
ALTER TABLE wa_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_groups          FORCE ROW LEVEL SECURITY;
ALTER TABLE calls              ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls              FORCE ROW LEVEL SECURITY;

CREATE POLICY channels_org ON channels FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY contact_identities_org ON contact_identities FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY ad_referrals_org ON ad_referrals FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY qr_codes_org ON qr_codes FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY catalog_products_org ON catalog_products FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY wa_groups_org ON wa_groups FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY calls_org ON calls FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- ------------------------------------------------------------------ pre-tenant functions
GRANT SELECT ON channels TO app_definer;
CREATE POLICY channels_definer ON channels FOR SELECT TO app_definer USING (true);
GRANT SELECT, INSERT ON webhook_events TO app_definer;

GRANT CREATE ON SCHEMA public TO app_definer;

-- Instagram webhooks name the account, not the org.
CREATE FUNCTION channel_route_lookup(p_kind "ChannelKind", p_external text)
  RETURNS TABLE (org_id uuid, channel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.org_id, c.id FROM channels c
    WHERE c.kind = p_kind AND c.external_id = p_external AND c.status = 'active'
    LIMIT 1
  $$;

-- The web chat widget is public: its key is in every page that embeds it. Only what the
-- widget shows comes back, never credentials.
CREATE FUNCTION webchat_channel_lookup(p_key text)
  RETURNS TABLE (id uuid, org_id uuid, name text, config jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.org_id, c.name, c.config FROM channels c
    WHERE c.kind = 'webchat' AND c.external_id = p_key AND c.status = 'active'
      AND length(p_key) >= 20
  $$;

CREATE FUNCTION secrets_list_channels()
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT c.id, c.org_id FROM channels c WHERE c.credentials_enc IS NOT NULL $$;

-- Instagram tokens last 60 days and must be refreshed before then. Ids only.
CREATE FUNCTION channel_tokens_due(p_before timestamptz)
  RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.org_id FROM channels c
    WHERE c.status = 'active' AND c.token_expires_at IS NOT NULL AND c.token_expires_at < p_before
  $$;

-- Events from providers other than the WhatsApp webhook (Instagram) use the same table, with
-- the account id where the WABA id would be.
CREATE FUNCTION webhook_event_ingest_for(p_provider text, p_dedupe text, p_account text, p_field text, p_payload jsonb)
  RETURNS TABLE (id uuid, status "WebhookEventStatus", inserted boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
      INSERT INTO webhook_events (id, provider, dedupe_key, waba_id, field, payload)
      VALUES (gen_random_uuid(), p_provider, p_dedupe, p_account, p_field, p_payload)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING webhook_events.id, webhook_events.status, true;
    IF NOT FOUND THEN
      RETURN QUERY
        SELECT w.id, w.status, false FROM webhook_events w WHERE w.dedupe_key = p_dedupe;
    END IF;
  END
  $$;

-- The worker needs to know which provider an event came from.
DROP FUNCTION webhook_event_load(uuid);
CREATE FUNCTION webhook_event_load(p_id uuid)
  RETURNS TABLE (id uuid, org_id uuid, provider text, waba_id text, phone_number_id text,
                 field text, payload jsonb, status "WebhookEventStatus")
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.org_id, w.provider, w.waba_id, w.phone_number_id, w.field, w.payload, w.status
    FROM webhook_events w WHERE w.id = p_id
  $$;

DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'channel_route_lookup("ChannelKind", text)',
    'webchat_channel_lookup(text)',
    'secrets_list_channels()',
    'channel_tokens_due(timestamptz)',
    'webhook_event_ingest_for(text, text, text, text, jsonb)',
    'webhook_event_load(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', sig);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM app_definer;

-- ------------------------------------------------------------------ plans
-- New modules, per plan. Plans are config: /admin and plans:import change them later.
UPDATE plans SET features = features || '["webchat","qr_codes"]'::jsonb
  WHERE code IN ('starter', 'growth', 'scale') AND NOT features ? 'webchat';
UPDATE plans SET features = features || '["instagram","catalog","ad_attribution"]'::jsonb
  WHERE code IN ('growth', 'scale') AND NOT features ? 'instagram';
UPDATE plans SET features = features || '["groups","calling"]'::jsonb
  WHERE code = 'scale' AND NOT features ? 'calling';
