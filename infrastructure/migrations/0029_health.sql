-- Sezione salute del second brain (richiesta dell'utente, 13 ott 2026): referti e analisi con i valori
-- strutturati per confrontarli nel tempo. Le note leggibili stanno nel vault (cartella «Salute», riservate);
-- qui ci sono i numeri per tabelle, andamenti e avvisi.
CREATE TABLE health_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_on    date NOT NULL,
  lab         text,
  kind        text NOT NULL DEFAULT 'analisi del sangue',
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  note_path   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_reports_user_idx ON health_reports (user_id, taken_on DESC);
CREATE UNIQUE INDEX health_reports_document_idx ON health_reports (user_id, document_id) WHERE document_id IS NOT NULL;
ALTER TABLE health_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY health_reports_owner ON health_reports
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

CREATE TABLE health_values (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id   uuid NOT NULL REFERENCES health_reports(id) ON DELETE CASCADE,
  parameter   text NOT NULL,
  label       text NOT NULL,
  value       numeric,
  value_text  text,
  unit        text,
  ref_low     numeric,
  ref_high    numeric,
  ref_text    text,
  flag        text NOT NULL DEFAULT 'n/d' CHECK (flag IN ('alto','basso','normale','n/d'))
);
CREATE INDEX health_values_param_idx ON health_values (user_id, parameter);
CREATE INDEX health_values_report_idx ON health_values (report_id);
ALTER TABLE health_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_values FORCE ROW LEVEL SECURITY;
CREATE POLICY health_values_owner ON health_values
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Avvisi spontanei (fuori intervallo, peggioramento): detti una volta al turno successivo.
CREATE TABLE health_notices (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id   uuid REFERENCES health_reports(id) ON DELETE CASCADE,
  text        text NOT NULL,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_notices_pending_idx ON health_notices (user_id) WHERE notified_at IS NULL;
ALTER TABLE health_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY health_notices_owner ON health_notices
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
