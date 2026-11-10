-- Private mobility archive: no coordinates, labels, routines or visit times in SQL columns.
CREATE TABLE habits_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE habits_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE habits_state FORCE ROW LEVEL SECURITY;
CREATE POLICY habits_state_owner ON habits_state USING (user_id=app_current_user_id()) WITH CHECK (user_id=app_current_user_id());
-- Maintenance enumerates account IDs only, then uses the ordinary account-scoped transaction.
CREATE POLICY habits_state_scheduler ON habits_state FOR SELECT USING (current_setting('app.scheduler',true)='on');
GRANT SELECT, INSERT, UPDATE, DELETE ON habits_state TO ernie_app;
