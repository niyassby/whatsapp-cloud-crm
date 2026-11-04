-- Row Level Security for tenant data.
--
-- Model:
--   * Migrations run as the schema owner (DIRECT_URL).
--   * The application connects as a login role that is a member of the NOLOGIN group
--     role "app_user" (DATABASE_URL). It is not the owner and has no BYPASSRLS, so every
--     policy below applies. FORCE ROW LEVEL SECURITY also binds the owner (e.g. seeds on
--     managed hosts where the owner is not a superuser).
--   * Each request transaction sets context with set_config(..., true) == SET LOCAL:
--       app.org_id      current tenant
--       app.user_id     authenticated user (for cross-org reads of the user's own memberships)
--       app.partner_id  reseller context (Section 4)
--   * Unset context => NULL => policies match nothing (fail closed).

-- Email must be stored normalised.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

-- ---------------------------------------------------------------- group role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;

-- ---------------------------------------------------------------- context helpers
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_partner_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.partner_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_current_org_id(), app_current_user_id(), app_current_partner_id() TO app_user;

-- ---------------------------------------------------------------- privileges
GRANT SELECT ON "partners" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "organizations" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "users" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "memberships" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "api_keys" TO app_user;
GRANT SELECT, INSERT ON "audit_logs" TO app_user; -- append-only

-- Future tables created by the owner are readable/writable by the app role.
-- Every new tenant table MUST also enable + force RLS (enforced by the rls-coverage test).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- ---------------------------------------------------------------- enable RLS
ALTER TABLE "partners"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partners"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "api_keys"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"    FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- memberships
-- Must not reference other RLS tables (the policies below depend on it).
CREATE POLICY memberships_select ON "memberships" FOR SELECT
  USING ("org_id" = app_current_org_id() OR "user_id" = app_current_user_id());
CREATE POLICY memberships_insert ON "memberships" FOR INSERT
  WITH CHECK ("org_id" = app_current_org_id());
CREATE POLICY memberships_update ON "memberships" FOR UPDATE
  USING ("org_id" = app_current_org_id())
  WITH CHECK ("org_id" = app_current_org_id());
CREATE POLICY memberships_delete ON "memberships" FOR DELETE
  USING ("org_id" = app_current_org_id());

-- ---------------------------------------------------------------- organizations
-- Visible: the current org, plus orgs the current user belongs to (org switcher).
CREATE POLICY organizations_select ON "organizations" FOR SELECT
  USING (
    "id" = app_current_org_id()
    OR EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m."org_id" = "organizations"."id"
        AND m."user_id" = app_current_user_id()
        AND m."status" = 'active'
    )
  );
CREATE POLICY organizations_insert ON "organizations" FOR INSERT
  WITH CHECK ("id" = app_current_org_id());
CREATE POLICY organizations_update ON "organizations" FOR UPDATE
  USING ("id" = app_current_org_id())
  WITH CHECK ("id" = app_current_org_id());
-- No DELETE policy: organizations are soft-deleted (deleted_at).

-- ---------------------------------------------------------------- users
-- Visible: yourself, and members of the current org.
CREATE POLICY users_select ON "users" FOR SELECT
  USING (
    "id" = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m."user_id" = "users"."id"
        AND m."org_id" = app_current_org_id()
    )
  );
-- Signup and invites create users before any membership exists.
CREATE POLICY users_insert ON "users" FOR INSERT
  WITH CHECK (true);
CREATE POLICY users_update ON "users" FOR UPDATE
  USING ("id" = app_current_user_id())
  WITH CHECK ("id" = app_current_user_id());

-- ---------------------------------------------------------------- partners (read-only for the app)
CREATE POLICY partners_select ON "partners" FOR SELECT
  USING (
    "id" = app_current_partner_id()
    OR "id" = (SELECT o."partner_id" FROM "organizations" o WHERE o."id" = app_current_org_id())
  );

-- ---------------------------------------------------------------- api_keys
CREATE POLICY api_keys_all ON "api_keys" FOR ALL
  USING ("org_id" = app_current_org_id())
  WITH CHECK ("org_id" = app_current_org_id());

-- ---------------------------------------------------------------- audit_logs
CREATE POLICY audit_logs_select ON "audit_logs" FOR SELECT
  USING ("org_id" = app_current_org_id());
CREATE POLICY audit_logs_insert ON "audit_logs" FOR INSERT
  WITH CHECK ("org_id" = app_current_org_id());
