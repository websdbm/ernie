-- Ruolo applicativo e Row Level Security (ARCHITECTURE.md §15, 03-revisione A.12).
-- Il ruolo nasce senza LOGIN: la CLI di migrazione imposta LOGIN e password da APP_DB_PASSWORD.
-- Le tabelle create in seguito dal proprietario (incluse le mastra_*) ereditano i GRANT tramite i privilegi predefiniti.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ernie_app') THEN
    CREATE ROLE ernie_app NOLOGIN NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ernie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ernie_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ernie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ernie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ernie_app;
REVOKE ALL ON schema_migrations FROM ernie_app;
GRANT SELECT ON schema_migrations TO ernie_app;

-- Utente corrente impostato dall'applicazione con SET LOCAL app.user_id dentro una transazione.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- users: ogni utente vede e modifica solo se stesso.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());

-- api_keys: esente da RLS per scelta documentata. Contiene solo hash e metadati, e la
-- ricerca per hash avviene prima di conoscere l'utente. Il filtro per user_id è applicativo.

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_owner ON sessions
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_calls_owner ON llm_calls
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- souls: i globali (user_id NULL) sono leggibili da tutti; scrivibili solo quelli propri.
ALTER TABLE souls ENABLE ROW LEVEL SECURITY;
ALTER TABLE souls FORCE ROW LEVEL SECURITY;
CREATE POLICY souls_read ON souls FOR SELECT
  USING (user_id IS NULL OR user_id = app_current_user_id());
CREATE POLICY souls_write ON souls FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

ALTER TABLE soul_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY soul_versions_via_soul ON soul_versions
  USING (EXISTS (SELECT 1 FROM souls s WHERE s.id = soul_versions.soul_id))
  WITH CHECK (EXISTS (SELECT 1 FROM souls s WHERE s.id = soul_versions.soul_id AND s.user_id = app_current_user_id()));
