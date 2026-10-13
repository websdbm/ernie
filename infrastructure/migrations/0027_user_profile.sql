-- Scheda anagrafica dell'utente (richiesta dell'utente, 13 ott 2026): nome, come vuole essere chiamato, data di
-- nascita, genere, dove vive, lavoro, famiglia. Un documento per utente con la provenienza di ogni dato
-- (detto in chat o scritto nell'app) e le revisioni per sapere cosa è cambiato e avvisare una volta.
CREATE TABLE user_profiles (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_profiles_owner ON user_profiles
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

CREATE TABLE user_profile_revisions (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changes     jsonb NOT NULL,
  source      text NOT NULL CHECK (source IN ('conversation','user')),
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_profile_revisions_pending_idx ON user_profile_revisions (user_id) WHERE notified_at IS NULL;
ALTER TABLE user_profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profile_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_profile_revisions_owner ON user_profile_revisions
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
