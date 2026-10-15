-- Chiarimento interno (richiesta dell'utente, 15 ott 2026): quando un messaggio è poco chiaro o l'utente corregge
-- Ernie, un modello leggero fa domande chiuse sul testo e Jev risponde. Qui resta traccia di ogni chiarimento
-- (domande, risposte, confidenze, costo), per tarare le soglie di ambiguità e confidenza con i casi reali.
CREATE TABLE interpretation_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  request_id  text,
  trigger     text NOT NULL CHECK (trigger IN ('ambiguous', 'correction')),
  message     text NOT NULL CHECK (char_length(message) <= 4000),
  ambiguity   real,
  correction  real,
  questions   jsonb NOT NULL DEFAULT '[]',
  answers     jsonb NOT NULL DEFAULT '[]',
  resolved    integer NOT NULL DEFAULT 0,
  cost_usd    numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms  integer NOT NULL DEFAULT 0,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interpretation_checks_user_idx ON interpretation_checks (user_id, created_at DESC);
ALTER TABLE interpretation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE interpretation_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY interpretation_checks_own ON interpretation_checks
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
