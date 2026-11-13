-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "impersonation_id" UUID;

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "max_clients" INTEGER,
ADD COLUMN     "wallet_markup_bps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "wallet_ledger" ADD COLUMN     "partner_id" UUID,
ADD COLUMN     "wholesale_micros" BIGINT;

-- CreateTable
CREATE TABLE "platform_admins" (
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "partner_members" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_clients" (
    "org_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "limit_seats" INTEGER,
    "limit_numbers" INTEGER,
    "limit_contacts" INTEGER,
    "client_price_micros" BIGINT,
    "owner_email" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_clients_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "wholesale_plan_prices" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,

    CONSTRAINT "wholesale_plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_ledger" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "org_id" UUID,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "wholesale_micros" BIGINT NOT NULL,
    "retail_micros" BIGINT NOT NULL,
    "commission_micros" BIGINT NOT NULL,
    "period" TEXT NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_statements" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "usage_wholesale_micros" BIGINT NOT NULL,
    "usage_retail_micros" BIGINT NOT NULL,
    "plan_fees_wholesale_micros" BIGINT NOT NULL,
    "plan_fees_retail_micros" BIGINT NOT NULL,
    "commission_micros" BIGINT NOT NULL,
    "total_due_micros" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "payment_reference" TEXT,
    "paid_by_id" UUID,

    CONSTRAINT "partner_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "partner_id" UUID,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "partner_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_members_user_id_key" ON "partner_members"("user_id");

-- CreateIndex
CREATE INDEX "partner_members_partner_id_idx" ON "partner_members"("partner_id");

-- CreateIndex
CREATE INDEX "partner_clients_partner_id_idx" ON "partner_clients"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "wholesale_plan_prices_plan_id_currency_key" ON "wholesale_plan_prices"("plan_id", "currency");

-- CreateIndex
CREATE INDEX "partner_ledger_partner_id_period_created_at_idx" ON "partner_ledger"("partner_id", "period", "created_at" DESC);

-- CreateIndex
CREATE INDEX "partner_ledger_partner_id_org_id_period_idx" ON "partner_ledger"("partner_id", "org_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "partner_ledger_partner_id_idempotency_key_key" ON "partner_ledger"("partner_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "partner_statements_partner_id_period_currency_key" ON "partner_statements"("partner_id", "period", "currency");

-- CreateIndex
CREATE INDEX "impersonation_sessions_org_id_started_at_idx" ON "impersonation_sessions"("org_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "impersonation_sessions_user_id_idx" ON "impersonation_sessions"("user_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_partner_id_created_at_idx" ON "platform_audit_logs"("partner_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wholesale_plan_prices" ADD CONSTRAINT "wholesale_plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_ledger" ADD CONSTRAINT "partner_ledger_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ checks
ALTER TABLE partners ADD CONSTRAINT partners_markup_range CHECK (wallet_markup_bps BETWEEN 0 AND 20000);
ALTER TABLE partners ADD CONSTRAINT partners_max_clients_positive CHECK (max_clients IS NULL OR max_clients >= 0);
ALTER TABLE partner_clients ADD CONSTRAINT partner_clients_limits_positive CHECK (
  (limit_seats IS NULL OR limit_seats >= 0)
  AND (limit_numbers IS NULL OR limit_numbers >= 0)
  AND (limit_contacts IS NULL OR limit_contacts >= 0)
  AND (client_price_micros IS NULL OR client_price_micros >= 0));
ALTER TABLE wholesale_plan_prices ADD CONSTRAINT wholesale_plan_prices_positive CHECK (amount_micros >= 0);
ALTER TABLE partner_ledger ADD CONSTRAINT partner_ledger_commission CHECK (commission_micros = retail_micros - wholesale_micros);
ALTER TABLE partner_statements ADD CONSTRAINT partner_statements_status CHECK (status IN ('issued', 'paid'));
ALTER TABLE impersonation_sessions ADD CONSTRAINT impersonation_sessions_window CHECK (expires_at > started_at);

-- ------------------------------------------------------------------ platform admin context
-- A request acts as a platform admin only when the API asks for it (app.platform_admin = 'on')
-- AND the current user has a platform_admins row. Either one alone opens nothing, so an admin
-- using their own workspace is an ordinary member, and the flag is useless to anyone else.
CREATE FUNCTION app_is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT COALESCE(current_setting('app.platform_admin', true), '') = 'on'
       AND EXISTS (SELECT 1 FROM platform_admins a WHERE a.user_id = app_current_user_id())
  $$;
GRANT EXECUTE ON FUNCTION app_is_platform_admin() TO app_user;

-- ------------------------------------------------------------------ grants
-- platform_admins: the app only reads. Rows come from `pnpm admin:grant` on the owner connection,
-- so RLS is enabled but not forced (a forced table would also stop a non-superuser owner).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_admins FROM app_user;
GRANT SELECT ON platform_admins TO app_user;

GRANT INSERT, UPDATE ON partners TO app_user;
REVOKE UPDATE, TRUNCATE ON partner_members FROM app_user;
REVOKE DELETE, TRUNCATE ON partner_clients FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON partner_ledger FROM app_user;       -- append-only
REVOKE DELETE, TRUNCATE ON partner_statements FROM app_user;
REVOKE DELETE, TRUNCATE ON impersonation_sessions FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_logs FROM app_user;  -- append-only

-- Config a platform admin now edits from the panel. Prices with provider ids stay CLI-only.
GRANT UPDATE (name, description, seats, numbers, contacts, features, is_public) ON plans TO app_user;
GRANT INSERT ON rate_cards TO app_user;

-- ------------------------------------------------------------------ row level security
ALTER TABLE platform_admins        ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_members        FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_clients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_clients        FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_ledger         FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_statements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_statements     FORCE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_logs    FORCE ROW LEVEL SECURITY;
-- Config tables: enabled, not forced, so the import scripts on the owner connection keep working.
ALTER TABLE wholesale_plan_prices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_cards             ENABLE ROW LEVEL SECURITY;

-- Must not call app_is_platform_admin(): that function reads this table.
CREATE POLICY platform_admins_self ON platform_admins FOR SELECT
  USING (user_id = app_current_user_id());

-- partners: a partner changes its own row, a platform admin any.
CREATE POLICY partners_admin_select ON partners FOR SELECT USING (app_is_platform_admin());
CREATE POLICY partners_admin_insert ON partners FOR INSERT WITH CHECK (app_is_platform_admin());
CREATE POLICY partners_update ON partners FOR UPDATE
  USING (id = app_current_partner_id() OR app_is_platform_admin())
  WITH CHECK (id = app_current_partner_id() OR app_is_platform_admin());

-- organizations: a partner sees and changes its clients; a platform admin, every workspace.
CREATE POLICY organizations_partner_select ON organizations FOR SELECT
  USING (partner_id = app_current_partner_id() OR app_is_platform_admin());
CREATE POLICY organizations_partner_update ON organizations FOR UPDATE
  USING (partner_id = app_current_partner_id() OR app_is_platform_admin())
  WITH CHECK (partner_id = app_current_partner_id() OR app_is_platform_admin());
-- A new workspace belongs to a partner only when that partner is creating it.
DROP POLICY organizations_insert ON organizations;
CREATE POLICY organizations_insert ON organizations FOR INSERT
  WITH CHECK (
    id = app_current_org_id()
    AND (partner_id IS NULL OR partner_id = app_current_partner_id())
  );

CREATE POLICY partner_members_select ON partner_members FOR SELECT
  USING (user_id = app_current_user_id() OR partner_id = app_current_partner_id() OR app_is_platform_admin());
CREATE POLICY partner_members_insert ON partner_members FOR INSERT
  WITH CHECK (app_is_platform_admin());
CREATE POLICY partner_members_delete ON partner_members FOR DELETE
  USING (app_is_platform_admin());

-- The client reads its own limits; only the partner or a platform admin writes them.
CREATE POLICY partner_clients_select ON partner_clients FOR SELECT
  USING (org_id = app_current_org_id() OR partner_id = app_current_partner_id() OR app_is_platform_admin());
CREATE POLICY partner_clients_insert ON partner_clients FOR INSERT
  WITH CHECK (partner_id = app_current_partner_id() OR app_is_platform_admin());
CREATE POLICY partner_clients_update ON partner_clients FOR UPDATE
  USING (partner_id = app_current_partner_id() OR app_is_platform_admin())
  WITH CHECK (partner_id = app_current_partner_id() OR app_is_platform_admin());

-- A client charge writes the entry for its partner, but the client can never read wholesale figures.
CREATE POLICY partner_ledger_select ON partner_ledger FOR SELECT
  USING (partner_id = app_current_partner_id() OR app_is_platform_admin());
CREATE POLICY partner_ledger_insert ON partner_ledger FOR INSERT
  WITH CHECK (
    partner_id = app_current_partner_id()
    OR app_is_platform_admin()
    OR (
      org_id = app_current_org_id()
      AND partner_id = (SELECT o.partner_id FROM organizations o WHERE o.id = app_current_org_id())
    )
  );

CREATE POLICY partner_statements_select ON partner_statements FOR SELECT
  USING (partner_id = app_current_partner_id() OR app_is_platform_admin());
CREATE POLICY partner_statements_insert ON partner_statements FOR INSERT
  WITH CHECK (partner_id = app_current_partner_id() OR app_is_platform_admin());
-- Recording a payment is for the platform, not the partner.
CREATE POLICY partner_statements_update ON partner_statements FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

CREATE POLICY impersonation_sessions_select ON impersonation_sessions FOR SELECT
  USING (
    user_id = app_current_user_id()
    OR org_id = app_current_org_id()
    OR partner_id = app_current_partner_id()
    OR app_is_platform_admin()
  );
CREATE POLICY impersonation_sessions_insert ON impersonation_sessions FOR INSERT
  WITH CHECK (user_id = app_current_user_id() AND org_id = app_current_org_id());
CREATE POLICY impersonation_sessions_update ON impersonation_sessions FOR UPDATE
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

CREATE POLICY platform_audit_logs_select ON platform_audit_logs FOR SELECT
  USING (app_is_platform_admin() OR partner_id = app_current_partner_id());
CREATE POLICY platform_audit_logs_insert ON platform_audit_logs FOR INSERT
  WITH CHECK (
    actor_user_id = app_current_user_id()
    AND (app_is_platform_admin() OR partner_id = app_current_partner_id())
  );

CREATE POLICY wholesale_plan_prices_read ON wholesale_plan_prices FOR SELECT USING (true);
CREATE POLICY wholesale_plan_prices_admin_insert ON wholesale_plan_prices FOR INSERT
  WITH CHECK (app_is_platform_admin());
CREATE POLICY wholesale_plan_prices_admin_update ON wholesale_plan_prices FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
CREATE POLICY wholesale_plan_prices_admin_delete ON wholesale_plan_prices FOR DELETE
  USING (app_is_platform_admin());

CREATE POLICY plans_read ON plans FOR SELECT USING (true);
CREATE POLICY plans_admin_update ON plans FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

CREATE POLICY rate_cards_read ON rate_cards FOR SELECT USING (true);
CREATE POLICY rate_cards_admin_insert ON rate_cards FOR INSERT WITH CHECK (app_is_platform_admin());

-- Lists for the partner and admin screens: balance and plan of a client, read-only.
CREATE POLICY wallets_partner_select ON wallets FOR SELECT TO app_user
  USING (
    app_is_platform_admin()
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.id = wallets.org_id AND o.partner_id = app_current_partner_id())
  );
CREATE POLICY subscriptions_partner_select ON subscriptions FOR SELECT TO app_user
  USING (
    app_is_platform_admin()
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.id = subscriptions.org_id AND o.partner_id = app_current_partner_id())
  );

-- ------------------------------------------------------------------ pre-tenant function
-- The worker closes the month of each partner with no partner known yet. Ids only.
GRANT SELECT ON partners TO app_definer;
CREATE POLICY partners_definer ON partners FOR SELECT TO app_definer USING (true);

GRANT CREATE ON SCHEMA public TO app_definer;

CREATE FUNCTION partner_statement_targets()
  RETURNS TABLE (partner_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT id FROM partners ORDER BY id $$;

ALTER FUNCTION partner_statement_targets() OWNER TO app_definer;
REVOKE ALL ON FUNCTION partner_statement_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_statement_targets() TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;
