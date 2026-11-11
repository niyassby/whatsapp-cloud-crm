-- App-wide webhooks (such as Shopify's privacy requests) name a shop, not a connection. Find the
-- connections for it before any org is known. Ids, org and status only.

GRANT CREATE ON SCHEMA public TO app_definer;

CREATE FUNCTION integration_connections_by_setting(p_connector text, p_setting text, p_value text)
  RETURNS TABLE (org_id uuid, id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.org_id, c.id, c.status FROM integration_connections c
    WHERE c.connector_key = p_connector
      AND length(p_value) > 0
      AND c.settings ->> p_setting = p_value
    LIMIT 50
  $$;
ALTER FUNCTION integration_connections_by_setting(text, text, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION integration_connections_by_setting(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_connections_by_setting(text, text, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM app_definer;
