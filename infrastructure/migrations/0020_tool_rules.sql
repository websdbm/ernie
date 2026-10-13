-- M9: regole «Consenti sempre» per utente (decisione dall'analisi di Open Dots, 11 ott 2026).
-- Una regola trasforma la richiesta di conferma (ask) di un tool in un consenso già dato: mai un deny,
-- mai per i tool con effetto esterno (invii, messaggi). Revoca da Impostazioni → Conferme.
CREATE TABLE tool_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT 'tool' CHECK (scope IN ('tool')),
  target      text NOT NULL,
  origin      text NOT NULL DEFAULT 'card' CHECK (origin IN ('card','settings')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, target)
);
ALTER TABLE tool_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_rules_owner ON tool_rules USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
