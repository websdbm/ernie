-- M7: dispositivi registrati per le notifiche push (APNs). Il token è il dato di consegna, non un segreto;
-- vive comunque sotto RLS per utente.
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('ios')),
  token         text NOT NULL,
  environment   text NOT NULL DEFAULT 'development' CHECK (environment IN ('development','production')),
  app_version   text,
  locale        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, token)
);
CREATE INDEX devices_user_idx ON devices (user_id);
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_owner ON devices USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Un token che cambia utente (stesso telefono, altro account) va riassegnato: la riga precedente è di un altro
-- utente e la RLS la nasconde, quindi la cancellazione passa da una funzione SECURITY DEFINER limitata al token.
CREATE FUNCTION device_release_token(p_platform text, p_token text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (DELETE FROM devices WHERE platform = p_platform AND token = p_token RETURNING 1)
  SELECT count(*)::integer FROM d
$$;
REVOKE ALL ON FUNCTION device_release_token(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION device_release_token(text, text) TO ernie_app;
