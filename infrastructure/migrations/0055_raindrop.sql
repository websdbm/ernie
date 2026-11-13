-- Only account credentials are stored; bookmarks/content stay in Raindrop.
CREATE TABLE raindrop_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE raindrop_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE raindrop_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY raindrop_connections_owner ON raindrop_connections
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON raindrop_connections TO ernie_app;
