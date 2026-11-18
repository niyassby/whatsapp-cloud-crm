-- A template still cannot be deleted while a campaign or drip step uses it, but NO ACTION is checked
-- at the end of the statement, so purging a whole workspace (which removes both) is not blocked.
-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_template_id_fkey";

-- DropForeignKey
ALTER TABLE "drip_steps" DROP CONSTRAINT "drip_steps_template_id_fkey";

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Checked at commit rather than mid-statement: within one cascading delete, Postgres may check the
-- template before it has removed the steps and campaigns that use it. Deleting a template that
-- is in use still fails, at commit.
ALTER TABLE "campaigns" ALTER CONSTRAINT "campaigns_template_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "drip_steps" ALTER CONSTRAINT "drip_steps_template_id_fkey" DEFERRABLE INITIALLY DEFERRED;
