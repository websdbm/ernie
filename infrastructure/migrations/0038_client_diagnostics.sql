-- Rapporti di iOS (MetricKit) dall'app: blocchi, chiusure per errore, eccessi di CPU o di scrittura, con gli stack
-- (16 ott 2026: l'app di due utenti si è bloccata e i telefoni non erano raggiungibili dal Mac per leggerne i
-- registri). L'app li manda al primo avvio dopo l'evento; si leggono da qui per la diagnosi.
CREATE TABLE client_diagnostics (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('crash', 'hang', 'cpu', 'disk', 'launch', 'other')),
  app_version  text CHECK (char_length(app_version) <= 40),
  os_version   text CHECK (char_length(os_version) <= 80),
  -- Inizio e fine del periodo coperto dal rapporto (MetricKit li raggruppa per giorno).
  period_start timestamptz,
  period_end   timestamptz,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_diagnostics_user_idx ON client_diagnostics (user_id, created_at DESC);
ALTER TABLE client_diagnostics ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_diagnostics FORCE ROW LEVEL SECURITY;
CREATE POLICY client_diagnostics_owner ON client_diagnostics
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
