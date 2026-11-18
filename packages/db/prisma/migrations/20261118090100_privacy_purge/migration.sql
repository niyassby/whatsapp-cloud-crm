-- Phase 4.4: purging a deleted workspace. Every tenant table now reaches organizations through a
-- cascading foreign key (directly, or through a parent that does), and cascades bypass row
-- security by design, so deleting the one organizations row removes the workspace's data.
-- partner_ledger keeps no such key on purpose: it is the partner's record of what it was owed.
-- AddForeignKey
ALTER TABLE "message_refs" ADD CONSTRAINT "message_refs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_hourly" ADD CONSTRAINT "analytics_hourly_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_agent_hourly" ADD CONSTRAINT "analytics_agent_hourly_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_template_hourly" ADD CONSTRAINT "analytics_template_hourly_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_responses" ADD CONSTRAINT "analytics_responses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_resolutions" ADD CONSTRAINT "conversation_resolutions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_response_hist" ADD CONSTRAINT "analytics_response_hist_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_resolution_hist" ADD CONSTRAINT "analytics_resolution_hist_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erased_identities" ADD CONSTRAINT "erased_identities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The app may delete an organization only when it was soft-deleted at the owner's request more
-- than 7 days ago, inside its own context. Nothing else can remove one.
GRANT DELETE ON organizations TO app_user;
CREATE POLICY organizations_purge ON organizations FOR DELETE TO app_user
  USING (
    id = app_current_org_id()
    AND purge_after IS NOT NULL
    AND deleted_at IS NOT NULL
    AND deleted_at <= now() - interval '7 days'
  );

GRANT CREATE ON SCHEMA public TO app_definer;

-- Workspaces ready to purge. Ids only.
CREATE FUNCTION privacy_due_org_purges(p_now timestamptz)
  RETURNS TABLE (org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT o.id FROM organizations o
    WHERE o.purge_after IS NOT NULL AND o.deleted_at IS NOT NULL
      AND o.deleted_at <= p_now - interval '7 days'
  $$;
ALTER FUNCTION privacy_due_org_purges(timestamptz) OWNER TO app_definer;
REVOKE ALL ON FUNCTION privacy_due_org_purges(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_due_org_purges(timestamptz) TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;
