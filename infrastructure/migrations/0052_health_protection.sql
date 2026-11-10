-- No data migration and no implicit consent: the legacy archive is migrated separately,
-- after a verified backup. Clinical payloads never appear in searchable SQL columns.
CREATE TABLE health_privacy (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ai_allowed boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE health_secure_reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_document_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, source_document_id)
);
CREATE INDEX health_secure_reports_user ON health_secure_reports(user_id, created_at DESC);

CREATE TABLE health_secure_notices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  FOREIGN KEY (user_id, report_id) REFERENCES health_secure_reports(user_id, id) ON DELETE CASCADE
);
CREATE INDEX health_secure_notices_pending ON health_secure_notices(user_id, created_at) WHERE notified_at IS NULL;

ALTER TABLE health_privacy ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_privacy FORCE ROW LEVEL SECURITY;
CREATE POLICY health_privacy_owner ON health_privacy USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
ALTER TABLE health_secure_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_secure_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY health_secure_reports_owner ON health_secure_reports USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
ALTER TABLE health_secure_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_secure_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY health_secure_notices_owner ON health_secure_notices USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON health_privacy, health_secure_reports, health_secure_notices TO ernie_app;

-- Evidence of explicit choices, never medical contents. Application cannot rewrite past events.
CREATE TABLE health_consent_events (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('grant', 'revoke')),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, revision)
);
ALTER TABLE health_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_consent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY health_consent_events_owner ON health_consent_events USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT ON health_consent_events TO ernie_app;
REVOKE UPDATE, DELETE ON health_consent_events FROM ernie_app;
