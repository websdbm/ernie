-- M5: audit delle chiamate ai tool, lista della spesa (skill deterministica), skill apprese.

CREATE TABLE tool_calls (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  request_id     text NOT NULL,
  tool_call_id   text NOT NULL,
  tool_id        text NOT NULL,
  tool_version   text NOT NULL DEFAULT '1',
  category       text,
  args_hash      text NOT NULL,
  args_preview   text,
  verdict        text NOT NULL CHECK (verdict IN ('allow','ask','deny')),
  approval_id    uuid,
  approved       boolean,
  ok             boolean NOT NULL DEFAULT false,
  error          text,
  duration_ms    int NOT NULL DEFAULT 0,
  tainted_before boolean NOT NULL DEFAULT false,
  tainted_after  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_user_created_idx ON tool_calls (user_id, created_at DESC);
CREATE INDEX tool_calls_request_idx ON tool_calls (request_id);
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_calls_owner ON tool_calls USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Lista della spesa (UC-1): dato dell'utente modificato da skill deterministica e tool.
CREATE TABLE shopping_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  name_norm   text NOT NULL,
  quantity    text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','bought','removed')),
  source      text NOT NULL DEFAULT 'user',
  added_at    timestamptz NOT NULL DEFAULT now(),
  bought_at   timestamptz,
  removed_at  timestamptz
);
CREATE UNIQUE INDEX shopping_items_active_idx ON shopping_items (user_id, name_norm) WHERE status = 'active';
CREATE INDEX shopping_items_user_status_idx ON shopping_items (user_id, status, added_at DESC);
ALTER TABLE shopping_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_items FORCE ROW LEVEL SECURITY;
CREATE POLICY shopping_items_owner ON shopping_items USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Skill apprese (formato agentskills.io: istruzioni in markdown + tool consentiti). Nessun codice: le skill
-- con codice richiedono la sandbox (fuori dal processo) e arrivano in una milestone successiva.
CREATE TABLE skills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,     -- NULL = globale
  key           text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('deterministic','guided')),
  version       int  NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','tested','approved','active','deprecated','rejected')),
  title         text NOT NULL,
  description   text NOT NULL,
  triggers      text[] NOT NULL DEFAULT '{}',
  allowed_tools text[] NOT NULL DEFAULT '{}',
  instructions  text NOT NULL,
  content_hash  text NOT NULL,
  risk_class    text NOT NULL DEFAULT 'low' CHECK (risk_class IN ('low','high')),
  created_by    text NOT NULL,
  test_report   jsonb,
  tested_at     timestamptz,
  approved_by   text,
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key, version)
);
CREATE INDEX skills_user_status_idx ON skills (user_id, status);
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE ROW LEVEL SECURITY;
CREATE POLICY skills_read ON skills FOR SELECT USING (user_id IS NULL OR user_id = app_current_user_id());
CREATE POLICY skills_write ON skills FOR ALL USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
