-- M7e: Famiglia. Collegamenti fra installazioni (utenti dello stesso server) con etichetta e parentela,
-- creati con un codice d'invito che l'altra persona accetta dal proprio telefono. Ogni lato vede solo la
-- propria riga (RLS): come chiamo l'altro e cosa è per me («Giorgio» → figlio; «papà» → genitore).
CREATE TABLE family_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          text NOT NULL,
  relation       text NOT NULL CHECK (relation IN ('figlio','genitore','partner','altro')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, other_user_id),
  CHECK (user_id <> other_user_id)
);
ALTER TABLE family_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_links FORCE ROW LEVEL SECURITY;
CREATE POLICY family_links_owner ON family_links USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Inviti: chi invita decide come chiamerà l'altro, cosa sarà per lui e come propone di farsi chiamare.
CREATE TABLE family_invites (
  code        text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation    text NOT NULL CHECK (relation IN ('figlio','genitore','partner','altro')),
  label       text NOT NULL,
  my_label    text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX family_invites_user_idx ON family_invites (user_id);
ALTER TABLE family_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY family_invites_owner ON family_invites USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Accettazione: chi ha il codice non vede la riga dell'invito e deve scrivere anche la riga dell'altro,
-- quindi passa da una funzione SECURITY DEFINER limitata al codice (valido, non usato, non scaduto).
CREATE FUNCTION family_accept_invite(p_code text, p_label text)
RETURNS TABLE (o_id uuid, o_other uuid, o_label text, o_relation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := app_current_user_id();
  inv family_invites%ROWTYPE;
  inverse text;
  mine text;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'utente non impostato'; END IF;
  SELECT * INTO inv FROM family_invites
    WHERE code = upper(trim(p_code)) AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF inv.user_id = me THEN RAISE EXCEPTION 'invito_proprio'; END IF;
  inverse := CASE inv.relation WHEN 'figlio' THEN 'genitore' WHEN 'genitore' THEN 'figlio' WHEN 'partner' THEN 'partner' ELSE 'altro' END;
  mine := COALESCE(NULLIF(trim(p_label), ''), inv.my_label);
  INSERT INTO family_links (user_id, other_user_id, label, relation) VALUES (inv.user_id, me, inv.label, inv.relation)
    ON CONFLICT (user_id, other_user_id) DO UPDATE SET label = EXCLUDED.label, relation = EXCLUDED.relation;
  INSERT INTO family_links (user_id, other_user_id, label, relation) VALUES (me, inv.user_id, mine, inverse)
    ON CONFLICT (user_id, other_user_id) DO UPDATE SET label = EXCLUDED.label, relation = EXCLUDED.relation;
  UPDATE family_invites SET used_by = me, used_at = now() WHERE code = inv.code;
  RETURN QUERY SELECT l.id, l.other_user_id, l.label, l.relation FROM family_links l WHERE l.user_id = me AND l.other_user_id = inv.user_id;
END
$$;
REVOKE ALL ON FUNCTION family_accept_invite(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_accept_invite(text, text) TO ernie_app;

-- Scollegamento: toglie entrambe le righe (anche quella dell'altro, nascosta dalla RLS).
CREATE FUNCTION family_unlink(p_other uuid) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (
    DELETE FROM family_links
      WHERE (user_id = app_current_user_id() AND other_user_id = p_other)
         OR (user_id = p_other AND other_user_id = app_current_user_id())
      RETURNING 1
  ) SELECT count(*)::integer FROM d
$$;
REVOKE ALL ON FUNCTION family_unlink(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_unlink(uuid) TO ernie_app;

-- Metadati liberi delle automazioni (es. promemoria messo da un familiare: chi, con quale etichetta).
ALTER TABLE automations ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
