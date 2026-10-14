-- Controllo genitori (richiesta dell'utente, 14 ott 2026). Decisioni: si attiva con un invito «con controllo
-- genitori» che il figlio accetta vedendo cosa comporta; dopo, solo il genitore può toglierlo; il genitore sceglie
-- le skill del figlio (all'inizio solo promemoria, liste e documenti) e può leggere le conversazioni; il figlio vede
-- che l'account è seguito e quando il genitore ha consultato le conversazioni.

ALTER TABLE family_invites ADD COLUMN supervised boolean NOT NULL DEFAULT false;

CREATE TABLE guardianships (
  guardian_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Skill che il figlio può usare (id del catalogo, più «web» per la ricerca sul web).
  allowed_skills  text[] NOT NULL DEFAULT ARRAY['ricordami', 'shopping_list', 'documenti']::text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guardian_id, child_id),
  CHECK (guardian_id <> child_id)
);
CREATE INDEX guardianships_child_idx ON guardianships (child_id);
ALTER TABLE guardianships ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardianships FORCE ROW LEVEL SECURITY;
-- Lettura per entrambi; modifica e revoca solo per il genitore; la creazione passa dall'accettazione dell'invito.
CREATE POLICY guardianships_read ON guardianships FOR SELECT
  USING (guardian_id = app_current_user_id() OR child_id = app_current_user_id());
CREATE POLICY guardianships_update ON guardianships FOR UPDATE
  USING (guardian_id = app_current_user_id()) WITH CHECK (guardian_id = app_current_user_id());
CREATE POLICY guardianships_delete ON guardianships FOR DELETE
  USING (guardian_id = app_current_user_id());

-- Consultazioni del genitore: il figlio le vede (trasparenza), il genitore le scrive solo se lo segue davvero.
CREATE TABLE guardian_reviews (
  id           bigserial PRIMARY KEY,
  guardian_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   uuid,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guardian_reviews_child_idx ON guardian_reviews (child_id, at DESC);
ALTER TABLE guardian_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY guardian_reviews_read ON guardian_reviews FOR SELECT
  USING (guardian_id = app_current_user_id() OR child_id = app_current_user_id());
CREATE POLICY guardian_reviews_insert ON guardian_reviews FOR INSERT
  WITH CHECK (
    guardian_id = app_current_user_id()
    AND EXISTS (SELECT 1 FROM guardianships g WHERE g.guardian_id = guardian_reviews.guardian_id AND g.child_id = guardian_reviews.child_id)
  );

-- Anteprima dell'invito per chi ha il codice (la riga gli è nascosta dalla RLS): prima di accettare il figlio
-- vede chi lo invita e se l'invito porta con sé il controllo genitori.
CREATE FUNCTION family_invite_preview(p_code text)
RETURNS TABLE (o_label text, o_my_label text, o_relation text, o_supervised boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT label, my_label, relation, supervised FROM family_invites
   WHERE code = upper(trim(p_code)) AND used_at IS NULL AND expires_at > now()
     AND user_id <> app_current_user_id()
$$;
REVOKE ALL ON FUNCTION family_invite_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_invite_preview(text) TO ernie_app;

-- Accettazione: come in 0015, più il controllo genitori quando l'invito lo prevede (solo per «figlio»).
CREATE OR REPLACE FUNCTION family_accept_invite(p_code text, p_label text)
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
  IF inv.supervised AND inv.relation = 'figlio' THEN
    INSERT INTO guardianships (guardian_id, child_id) VALUES (inv.user_id, me) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE family_invites SET used_by = me, used_at = now() WHERE code = inv.code;
  RETURN QUERY SELECT l.id, l.other_user_id, l.label, l.relation FROM family_links l WHERE l.user_id = me AND l.other_user_id = inv.user_id;
END
$$;

-- Scollegamento: il figlio seguito non può scollegarsi dal genitore; se scollega il genitore, il controllo finisce.
CREATE OR REPLACE FUNCTION family_unlink(p_other uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM guardianships WHERE guardian_id = p_other AND child_id = app_current_user_id()) THEN
    RAISE EXCEPTION 'supervisione_attiva';
  END IF;
  DELETE FROM guardianships WHERE guardian_id = app_current_user_id() AND child_id = p_other;
  WITH d AS (
    DELETE FROM family_links
      WHERE (user_id = app_current_user_id() AND other_user_id = p_other)
         OR (user_id = p_other AND other_user_id = app_current_user_id())
      RETURNING 1
  ) SELECT count(*)::integer INTO n FROM d;
  RETURN n;
END
$$;
