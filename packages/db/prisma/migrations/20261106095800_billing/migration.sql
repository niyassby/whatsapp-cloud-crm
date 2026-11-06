-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('trialing', 'active', 'past_due', 'cancelled');

-- CreateEnum
CREATE TYPE "wallet_topup_status" AS ENUM ('created', 'paid', 'failed');

-- CreateEnum
CREATE TYPE "billing_event_status" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "billing_address" TEXT,
ADD COLUMN     "billing_country" TEXT,
ADD COLUMN     "billing_email" TEXT,
ADD COLUMN     "billing_name" TEXT,
ADD COLUMN     "tax_id" TEXT;

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "seats" INTEGER,
    "numbers" INTEGER,
    "contacts" INTEGER,
    "features" JSONB NOT NULL DEFAULT '[]',
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "is_trial" BOOLEAN NOT NULL DEFAULT false,
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "stripe_price_id" TEXT,
    "razorpay_plan_id" TEXT,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "country" TEXT NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("country")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL,
    "provider" TEXT,
    "provider_subscription_id" TEXT,
    "provider_customer_id" TEXT,
    "trial_ends_at" TIMESTAMPTZ(3),
    "current_period_start" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_topups" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "status" "wallet_topup_status" NOT NULL DEFAULT 'created',
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "currency" TEXT NOT NULL,
    "credit_micros" BIGINT NOT NULL,
    "tax_micros" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "tax_label" TEXT,
    "total_micros" BIGINT NOT NULL,
    "created_by_id" UUID,
    "failure" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_topups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal_micros" BIGINT NOT NULL,
    "tax_micros" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "tax_label" TEXT,
    "total_micros" BIGINT NOT NULL,
    "bill_to" JSONB NOT NULL,
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "billing_event_status" NOT NULL DEFAULT 'received',
    "org_id" UUID,
    "error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_id_currency_interval_key" ON "plan_prices"("plan_id", "currency", "interval");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_org_id_key" ON "subscriptions"("org_id");

-- CreateIndex
CREATE INDEX "subscriptions_provider_provider_subscription_id_idx" ON "subscriptions"("provider", "provider_subscription_id");

-- CreateIndex
CREATE INDEX "wallet_topups_org_id_created_at_idx" ON "wallet_topups"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_topups_provider_provider_ref_idx" ON "wallet_topups"("provider", "provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_org_id_issued_at_id_idx" ON "invoices"("org_id", "issued_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_provider_provider_ref_key" ON "invoices"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "billing_events_org_id_received_at_idx" ON "billing_events"("org_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ------------------------------------------------------------------ config rows

-- Plans are config, not code. Change them with `pnpm plans:import <file.json>`.
INSERT INTO plans (id, code, name, description, seats, numbers, contacts, features, is_public, is_trial, trial_days, sort_order) VALUES
  (gen_random_uuid(), 'free',    'Free',    'What a workspace keeps after a trial or subscription ends.', 1, 1, 250, '[]', false, false, 0, 0),
  (gen_random_uuid(), 'starter', 'Starter', 'For a small team getting started.', 3, 1, 2500, '["campaigns"]', true, false, 14, 1),
  (gen_random_uuid(), 'growth',  'Growth',  'Campaigns, drips and the public API.', 10, 3, 25000, '["campaigns","drips","public_api"]', true, true, 14, 2),
  (gen_random_uuid(), 'scale',   'Scale',   'No limits on seats, numbers or contacts.', NULL, NULL, NULL, '["campaigns","drips","public_api"]', true, false, 14, 3);

-- Existing workspaces start a trial, the same as a new one.
INSERT INTO subscriptions (id, org_id, plan_id, status, trial_ends_at, updated_at)
SELECT gen_random_uuid(), o.id, p.id, 'trialing', now() + make_interval(days => p.trial_days), now()
FROM organizations o CROSS JOIN plans p WHERE p.is_trial;

-- GST on software services. Add other countries as they apply.
INSERT INTO tax_rates (country, rate_bps, label) VALUES ('IN', 1800, 'GST');

-- A gapless invoice sequence: it is a row, so a rolled-back transaction gives its number back.
CREATE TABLE invoice_counter (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  value bigint NOT NULL DEFAULT 0
);
INSERT INTO invoice_counter (id, value) VALUES (true, 0);

-- ------------------------------------------------------------------ grants

GRANT SELECT ON plans, plan_prices, tax_rates TO app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON plans, plan_prices, tax_rates FROM app_user;
REVOKE ALL ON invoice_counter FROM app_user;

-- Money records are not deleted by the app. Invoices do not change either.
REVOKE DELETE ON subscriptions, wallet_topups FROM app_user;
REVOKE UPDATE, DELETE ON invoices FROM app_user;
-- Only the signature-checked path may add events, and only the worker moves them.
REVOKE INSERT, UPDATE, DELETE ON billing_events FROM app_user;

-- ------------------------------------------------------------------ row level security

ALTER TABLE subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions  FORCE ROW LEVEL SECURITY;
ALTER TABLE wallet_topups  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_topups  FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices       FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;

CREATE POLICY subscriptions_org ON subscriptions FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY wallet_topups_org ON wallet_topups FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY invoices_org ON invoices FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY billing_events_org ON billing_events FOR SELECT TO app_user
  USING (org_id = app_current_org_id());

-- ------------------------------------------------------------------ definer functions

GRANT SELECT, INSERT, UPDATE ON billing_events TO app_definer;
GRANT SELECT ON subscriptions, wallet_topups TO app_definer;
GRANT SELECT, UPDATE ON invoice_counter TO app_definer;
CREATE POLICY billing_events_definer ON billing_events FOR ALL TO app_definer USING (true) WITH CHECK (true);
CREATE POLICY subscriptions_definer ON subscriptions FOR SELECT TO app_definer USING (true);
CREATE POLICY wallet_topups_definer ON wallet_topups FOR SELECT TO app_definer USING (true);

GRANT CREATE ON SCHEMA public TO app_definer;

/* Store a signature-checked event. A redelivery finds the row it already made. */
CREATE FUNCTION billing_event_ingest(p_provider text, p_event text, p_type text, p_payload jsonb)
  RETURNS TABLE (id uuid, status billing_event_status)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
      INSERT INTO billing_events (id, provider, event_id, type, payload)
      VALUES (gen_random_uuid(), p_provider, p_event, p_type, p_payload)
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING billing_events.id, billing_events.status;
    IF NOT FOUND THEN
      RETURN QUERY
        SELECT e.id, e.status FROM billing_events e
        WHERE e.provider = p_provider AND e.event_id = p_event;
    END IF;
  END
  $$;

/* Keyed by an id only a job holds. The worker has no org until it has read the event. */
CREATE FUNCTION billing_event_load(p_id uuid)
  RETURNS TABLE (id uuid, provider text, type text, payload jsonb, status billing_event_status)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT e.id, e.provider, e.type, e.payload, e.status FROM billing_events e WHERE e.id = p_id
  $$;

CREATE FUNCTION billing_event_mark(p_id uuid, p_status billing_event_status, p_org uuid, p_error text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE billing_events
       SET status = p_status,
           org_id = COALESCE(p_org, org_id),
           error = p_error,
           processed_at = CASE WHEN p_status = 'received' THEN NULL ELSE now() END
     WHERE id = p_id
  $$;

/* Which workspace a provider's id belongs to, for events that carry no org. Answers only the id. */
CREATE FUNCTION billing_org_for_ref(p_provider text, p_ref text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT org_id FROM subscriptions WHERE provider = p_provider AND provider_subscription_id = p_ref
    UNION ALL
    SELECT org_id FROM wallet_topups WHERE provider = p_provider AND provider_ref = p_ref
    LIMIT 1
  $$;

/* The next invoice number, inside the caller's transaction. */
CREATE FUNCTION next_invoice_number()
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE invoice_counter SET value = value + 1 RETURNING value
  $$;

DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'billing_event_ingest(text, text, text, jsonb)',
    'billing_event_load(uuid)',
    'billing_event_mark(uuid, billing_event_status, uuid, text)',
    'billing_org_for_ref(text, text)',
    'next_invoice_number()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', sig);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM app_definer;
