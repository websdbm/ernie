-- Stile di conversazione e lessico imparato (richiesta dell'utente, 16 ott 2026). Lo stile scelto (Neutro,
-- Scherzoso, Essenziale, Antico) sta in users.settings.conversationStyle. Qui le espressioni che la persona usa
-- spesso: il consolidamento della memoria le annota, diventano attive dopo almeno tre volte in due conversazioni
-- diverse e Ernie le riusa quando calzano. La persona le vede e le cancella; una cancellata («removed») non viene
-- più imparata. Per un figlio il genitore le vede e può spegnere l'apprendimento (guardianships.lexicon_off).

CREATE TABLE user_lexicon (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term             text NOT NULL CHECK (char_length(term) BETWEEN 1 AND 60),
  -- Forma normalizzata (minuscolo, spazi singoli, apostrofi dritti) per non contare due volte la stessa espressione.
  term_key         text NOT NULL CHECK (char_length(term_key) BETWEEN 1 AND 60),
  meaning          text NOT NULL DEFAULT '' CHECK (char_length(meaning) <= 160),
  example          text NOT NULL DEFAULT '' CHECK (char_length(example) <= 200),
  seen_count       integer NOT NULL DEFAULT 1,
  sessions         integer NOT NULL DEFAULT 1,
  last_session_id  uuid,
  status           text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'removed')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, term_key)
);
CREATE INDEX user_lexicon_user_idx ON user_lexicon (user_id, status, seen_count DESC);
ALTER TABLE user_lexicon ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_lexicon FORCE ROW LEVEL SECURITY;
CREATE POLICY user_lexicon_owner ON user_lexicon
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
-- Il genitore legge il lessico del figlio che segue (trasparenza: il figlio lo sa dalla nota di controllo genitori).
CREATE POLICY user_lexicon_guardian_read ON user_lexicon FOR SELECT
  USING (EXISTS (SELECT 1 FROM guardianships g
                  WHERE g.child_id = user_lexicon.user_id AND g.guardian_id = app_current_user_id()));

ALTER TABLE guardianships ADD COLUMN lexicon_off boolean NOT NULL DEFAULT false;

-- Stile e apprendimento di un figlio, per la pagina del genitore: solo queste due impostazioni, solo a chi lo segue.
CREATE FUNCTION guardian_child_style(p_child uuid)
RETURNS TABLE (o_style text, o_learn boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(u.settings->>'conversationStyle', 'neutro'),
         COALESCE((u.settings->>'learnLexicon')::boolean, true)
    FROM users u
   WHERE u.id = p_child
     AND EXISTS (SELECT 1 FROM guardianships g WHERE g.child_id = p_child AND g.guardian_id = app_current_user_id())
$$;
REVOKE ALL ON FUNCTION guardian_child_style(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardian_child_style(uuid) TO ernie_app;
