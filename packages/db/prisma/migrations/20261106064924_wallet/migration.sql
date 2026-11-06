-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('credit', 'debit', 'refund', 'adjustment');

-- CreateEnum
CREATE TYPE "WalletReservationStatus" AS ENUM ('active', 'released', 'expired');

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "balance_micros" BIGINT NOT NULL DEFAULT 0,
    "reserved_micros" BIGINT NOT NULL DEFAULT 0,
    "low_balance_threshold_micros" BIGINT,
    "low_balance_alerted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "balance_after_micros" BIGINT NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "description" TEXT,
    "actor_user_id" UUID,
    "rate_card_id" UUID,
    "rate_micros" BIGINT,
    "country" TEXT,
    "category" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_reservations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "consumed_micros" BIGINT NOT NULL DEFAULT 0,
    "status" "WalletReservationStatus" NOT NULL DEFAULT 'active',
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL,
    "country" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate_micros" BIGINT NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_org_id_key" ON "wallets"("org_id");

-- CreateIndex
CREATE INDEX "wallet_ledger_org_id_created_at_id_idx" ON "wallet_ledger"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "wallet_ledger_org_id_category_created_at_idx" ON "wallet_ledger"("org_id", "category", "created_at");

-- CreateIndex
CREATE INDEX "wallet_ledger_org_id_reference_type_reference_id_idx" ON "wallet_ledger"("org_id", "reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_ledger_org_id_idempotency_key_key" ON "wallet_ledger"("org_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_reservations_wallet_id_status_expires_at_idx" ON "wallet_reservations"("wallet_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_reservations_org_id_idempotency_key_key" ON "wallet_reservations"("org_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "rate_cards_currency_category_country_valid_from_idx" ON "rate_cards"("currency", "category", "country", "valid_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_country_category_currency_valid_from_key" ON "rate_cards"("country", "category", "currency", "valid_from");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: the guarantees the code relies on, grants and RLS.
-- ============================================================================

-- The last line of defense: even a bug in the app cannot make money that is not there.
ALTER TABLE "wallets" ADD CONSTRAINT wallets_balance_not_negative CHECK (balance_micros >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT wallets_reserved_not_negative CHECK (reserved_micros >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT wallets_reserved_within_balance CHECK (reserved_micros <= balance_micros);
ALTER TABLE "wallet_ledger" ADD CONSTRAINT wallet_ledger_balance_not_negative CHECK (balance_after_micros >= 0);
ALTER TABLE "wallet_reservations" ADD CONSTRAINT wallet_reservations_within_amount CHECK (consumed_micros >= 0 AND consumed_micros <= amount_micros);
ALTER TABLE "rate_cards" ADD CONSTRAINT rate_cards_rate_not_negative CHECK (rate_micros >= 0);

-- The ledger is append-only, and history is not deleted by the app.
REVOKE UPDATE, DELETE ON "wallet_ledger" FROM app_user;
REVOKE DELETE ON "wallets", "wallet_reservations" FROM app_user;

-- Prices are the same for every org, and the app only reads them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "rate_cards" FROM app_user;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallets', 'wallet_ledger', 'wallet_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO app_user USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id())',
      t || '_org', t
    );
  END LOOP;
END
$$;
