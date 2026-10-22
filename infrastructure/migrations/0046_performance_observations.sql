-- Tempi numerici per richiesta; nessun testo, URL o contenuto delle conversazioni.
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_id_unique UNIQUE (user_id, id);
CREATE TABLE performance_observations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  request_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('server', 'ios', 'ios_simulator')),
  app_version text NOT NULL CHECK (char_length(app_version) <= 40),
  input_mode text NOT NULL CHECK (input_mode IN ('text', 'voice')),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'error', 'cancelled', 'interrupted', 'abandoned')),
  reconnected boolean NOT NULL DEFAULT false,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id, request_id, source),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id) ON DELETE CASCADE
);
CREATE INDEX performance_observations_user_time ON performance_observations(user_id, created_at DESC);
ALTER TABLE performance_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY performance_observations_owner ON performance_observations
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
