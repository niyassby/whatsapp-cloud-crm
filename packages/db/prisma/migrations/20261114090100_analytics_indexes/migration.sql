-- Indexes the rollup and conversion attribution read by.
-- CreateIndex
CREATE INDEX "ad_referrals_contact_id_created_at_idx" ON "ad_referrals"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "conversations_org_id_created_at_idx" ON "conversations"("org_id", "created_at");

