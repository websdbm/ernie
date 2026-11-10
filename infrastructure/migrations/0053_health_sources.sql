-- Dedicated originals/OCR and attachments. No clinical metadata, file names or content hashes in SQL.
CREATE TABLE health_secure_sources (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE health_secure_assets (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, source_id) REFERENCES health_secure_sources(user_id, id) ON DELETE CASCADE
);
-- Exact copies retained during explicit migration; kind, original ID/path and contents are encrypted.
CREATE TABLE health_secure_legacy_resources (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  source_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, source_id) REFERENCES health_secure_sources(user_id, id) ON DELETE CASCADE
);
CREATE INDEX health_secure_sources_created ON health_secure_sources(user_id, created_at DESC, id);
CREATE INDEX health_secure_assets_source ON health_secure_assets(user_id, source_id);
CREATE INDEX health_secure_legacy_source ON health_secure_legacy_resources(user_id, source_id);
ALTER TABLE health_secure_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_secure_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY health_secure_sources_owner ON health_secure_sources USING (user_id=app_current_user_id()) WITH CHECK (user_id=app_current_user_id());
ALTER TABLE health_secure_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_secure_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY health_secure_assets_owner ON health_secure_assets USING (user_id=app_current_user_id()) WITH CHECK (user_id=app_current_user_id());
ALTER TABLE health_secure_legacy_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_secure_legacy_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY health_secure_legacy_owner ON health_secure_legacy_resources USING (user_id=app_current_user_id()) WITH CHECK (user_id=app_current_user_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON health_secure_sources,health_secure_assets,health_secure_legacy_resources TO ernie_app;
