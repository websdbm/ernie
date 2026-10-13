-- Ricerca 11, C1: riassunto ricorsivo della conversazione. Quando i messaggi non riassunti superano una
-- soglia, il worker riassume i più vecchi (modello leggero) e il processore dell'agente li sostituisce nel
-- prompt con questo testo, inserito subito dopo le istruzioni: cambia solo alla compattazione (cache).
CREATE TABLE session_summaries (
  session_id     uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary        jsonb NOT NULL,                 -- sezioni fisse (vedi packages/memory/src/session-summary.ts)
  covered_until  timestamptz NOT NULL,           -- createdAt dell'ultimo messaggio riassunto
  messages       int NOT NULL DEFAULT 0,         -- messaggi riassunti in tutto
  version        int NOT NULL DEFAULT 1,
  fallback       boolean NOT NULL DEFAULT false, -- riassunto deterministico (modello non disponibile)
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_summaries_user_idx ON session_summaries (user_id);
ALTER TABLE session_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY session_summaries_owner ON session_summaries
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
