-- Ricerca 11, C4 + C5: automazioni che non disturbano e non spendono a vuoto.
-- notify_policy: always | if_condition (il modello avvisa solo se la condizione è vera) | never.
-- check: controllo economico prima del modello (pagina cambiata, nuove voci di un feed), stato in check_state.
ALTER TABLE automations
  ADD COLUMN notify_policy text NOT NULL DEFAULT 'always' CHECK (notify_policy IN ('always','if_condition','never')),
  ADD COLUMN condition text,
  ADD COLUMN "check" jsonb,
  ADD COLUMN check_state jsonb;
-- Esiti silenziosi letti una volta dal turno successivo dell'utente («ho controllato, niente di nuovo»).
ALTER TABLE automation_runs ADD COLUMN silent_seen_at timestamptz;
