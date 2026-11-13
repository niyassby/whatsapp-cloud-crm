-- A partner's staff, by name and email, for the partner's own team and for platform admins.
-- users_select only shows yourself and members of the current org, and an operator has no org.
-- partner_members policies do not read users, so this cannot recurse.
CREATE POLICY users_partner_staff_select ON users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM partner_members pm
      WHERE pm.user_id = users.id
        AND (pm.partner_id = app_current_partner_id() OR app_is_platform_admin())
    )
  );
