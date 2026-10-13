-- Ricerca 11, M1 + M2: validità temporale dei fatti, classi di ritenzione, giudice delle contraddizioni.
-- «disputed»: due ricordi in conflitto senza evidenza sufficiente convivono finché l'utente non chiarisce
-- (mai ritirare in silenzio). Gli eventi alimentano l'avviso «ho aggiornato…» al turno successivo.
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_status_check;
ALTER TABLE memories ADD CONSTRAINT memories_status_check
  CHECK (status IN ('active','superseded','deleted','disputed'));
ALTER TABLE memories
  ADD COLUMN retention text CHECK (retention IN ('permanent','durable','ephemeral')),
  ADD COLUMN temporal_kind text CHECK (temporal_kind IN ('state','event','plan')),
  ADD COLUMN conflict_group uuid,
  ADD COLUMN superseded_by uuid REFERENCES memories(id) ON DELETE SET NULL;

CREATE TABLE memory_fact_events (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact_id      uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  other_id     uuid REFERENCES memories(id) ON DELETE SET NULL,
  event        text NOT NULL CHECK (event IN ('superseded','disputed','reinforced','closed')),
  old_text     text,
  new_text     text,
  reasoning    text,
  evidence     text,
  notified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_fact_events_pending_idx ON memory_fact_events (user_id, created_at) WHERE notified_at IS NULL;
ALTER TABLE memory_fact_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_fact_events FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_fact_events_owner ON memory_fact_events
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
