-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "api_key_id" UUID;

-- CreateIndex
CREATE INDEX "webhook_endpoints_api_key_id_idx" ON "webhook_endpoints"("api_key_id");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
