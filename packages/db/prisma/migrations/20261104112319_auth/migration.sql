-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('email_verification', 'password_reset');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_secret_enc" TEXT;

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "org_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,
    "replaced_by_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_org_id_idx" ON "invitations"("org_id");

-- CreateIndex
CREATE INDEX "invitations_org_id_email_idx" ON "invitations"("org_id", "email");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: grants, RLS and pre-auth lookup functions.
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON "refresh_tokens" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "auth_tokens" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "invitations" TO app_user;
-- Default privileges also granted DELETE; these tables are revoked/expired, never deleted by the app.
REVOKE DELETE ON "refresh_tokens", "auth_tokens", "invitations" FROM app_user;

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "auth_tokens"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_tokens"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "invitations"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations"    FORCE ROW LEVEL SECURITY;

-- Sessions and one-time tokens belong to a user, not an org.
CREATE POLICY refresh_tokens_own ON "refresh_tokens" FOR ALL TO app_user
  USING ("user_id" = app_current_user_id())
  WITH CHECK ("user_id" = app_current_user_id());
CREATE POLICY auth_tokens_own ON "auth_tokens" FOR ALL TO app_user
  USING ("user_id" = app_current_user_id())
  WITH CHECK ("user_id" = app_current_user_id());
CREATE POLICY invitations_org ON "invitations" FOR ALL TO app_user
  USING ("org_id" = app_current_org_id())
  WITH CHECK ("org_id" = app_current_org_id());

-- ---------------------------------------------------------------- pre-auth lookups
-- Some lookups happen before any user/org context exists: login by email, refresh by token
-- hash, email links, invitation links. They run as SECURITY DEFINER functions owned by the
-- NOLOGIN role app_definer, which has a SELECT-only policy. Each function:
--   * is read-only, keyed by an email or an unguessable token hash,
--   * returns only the columns the auth flow needs,
--   * pins search_path.
-- All writes afterwards happen under normal RLS with the resolved context.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_definer') THEN
    CREATE ROLE app_definer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
-- The migrating role must be able to hand function ownership to app_definer.
GRANT app_definer TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO app_definer;
GRANT SELECT ON "users", "organizations", "refresh_tokens", "auth_tokens", "invitations" TO app_definer;
GRANT EXECUTE ON FUNCTION app_current_org_id(), app_current_user_id(), app_current_partner_id() TO app_definer;

CREATE POLICY users_definer_read ON "users" FOR SELECT TO app_definer USING (true);
CREATE POLICY organizations_definer_read ON "organizations" FOR SELECT TO app_definer USING (true);
CREATE POLICY refresh_tokens_definer_read ON "refresh_tokens" FOR SELECT TO app_definer USING (true);
CREATE POLICY auth_tokens_definer_read ON "auth_tokens" FOR SELECT TO app_definer USING (true);
CREATE POLICY invitations_definer_read ON "invitations" FOR SELECT TO app_definer USING (true);

CREATE FUNCTION auth_lookup_user_by_email(p_email text)
  RETURNS TABLE (id uuid, password_hash text, status "UserStatus", totp_enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.password_hash, u.status, u.totp_enabled_at IS NOT NULL
    FROM users u WHERE u.email = lower(p_email)
  $$;

CREATE FUNCTION auth_lookup_refresh_token(p_token_hash text)
  RETURNS TABLE (id uuid, user_id uuid, family_id uuid, org_id uuid,
                 expires_at timestamptz, revoked_at timestamptz, replaced_by_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.user_id, t.family_id, t.org_id, t.expires_at, t.revoked_at, t.replaced_by_id
    FROM refresh_tokens t WHERE t.token_hash = p_token_hash
  $$;

CREATE FUNCTION auth_lookup_auth_token(p_token_hash text, p_type "AuthTokenType")
  RETURNS TABLE (id uuid, user_id uuid, expires_at timestamptz, used_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.user_id, t.expires_at, t.used_at
    FROM auth_tokens t WHERE t.token_hash = p_token_hash AND t.type = p_type
  $$;

CREATE FUNCTION auth_lookup_invitation(p_token_hash text)
  RETURNS TABLE (id uuid, org_id uuid, org_name text, email text, role "Role",
                 expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz,
                 account_exists boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.org_id, o.name, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
           EXISTS (SELECT 1 FROM users u WHERE u.email = i.email)
    FROM invitations i JOIN organizations o ON o.id = i.org_id
    WHERE i.token_hash = p_token_hash AND o.deleted_at IS NULL
  $$;

ALTER FUNCTION auth_lookup_user_by_email(text) OWNER TO app_definer;
ALTER FUNCTION auth_lookup_refresh_token(text) OWNER TO app_definer;
ALTER FUNCTION auth_lookup_auth_token(text, "AuthTokenType") OWNER TO app_definer;
ALTER FUNCTION auth_lookup_invitation(text) OWNER TO app_definer;

REVOKE ALL ON FUNCTION auth_lookup_user_by_email(text), auth_lookup_refresh_token(text),
  auth_lookup_auth_token(text, "AuthTokenType"), auth_lookup_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(text), auth_lookup_refresh_token(text),
  auth_lookup_auth_token(text, "AuthTokenType"), auth_lookup_invitation(text) TO app_user;
