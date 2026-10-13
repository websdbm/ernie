-- Ricerca 11, S1: promemoria a evento («quando si parla della gita, ricordami il modulo»; idea da OpenClaw).
-- Ogni messaggio dell'utente viene confrontato in full-text italiano con le parole chiave, senza modello.
-- Freni strutturali: attesa di 24 ore tra due attivazioni, al massimo 3 attivazioni, scadenza 90 giorni.
CREATE TABLE standing_intents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_text  text NOT NULL,
  trigger_query tsquery NOT NULL,
  reminder      text NOT NULL,
  status        text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','done','cancelled','expired')),
  fires         int NOT NULL DEFAULT 0,
  max_fires     int NOT NULL DEFAULT 3,
  last_fired_at timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '90 days',
  from_user     uuid REFERENCES users(id) ON DELETE SET NULL,
  from_label    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX standing_intents_armed_idx ON standing_intents (user_id) WHERE status = 'armed';
ALTER TABLE standing_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE standing_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY standing_intents_owner ON standing_intents
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
