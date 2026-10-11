-- M3: decisioni del router (metriche e audit) e approvazioni monouso per i tool.

CREATE TABLE router_decisions (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL,
  request_id      text NOT NULL,
  source          text NOT NULL CHECK (source IN ('deterministic','jev','cache','fallback')),
  route           text NOT NULL CHECK (route IN ('deterministic','skill','llm')),
  model_class     text NOT NULL CHECK (model_class IN ('light','standard','heavy')),
  deep_reasoning  boolean NOT NULL DEFAULT false,
  needs_memory    boolean NOT NULL DEFAULT true,
  tool_categories text[] NOT NULL DEFAULT '{}',
  skill_id        text,
  risk_signal     real NOT NULL DEFAULT 0,
  confidence      real NOT NULL DEFAULT 0,
  input_tokens    int  NOT NULL DEFAULT 0,
  cost_usd        numeric(14,10) NOT NULL DEFAULT 0,
  latency_ms      int  NOT NULL DEFAULT 0,
  jev_model       text,
  jev_id          text,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX router_decisions_user_created_idx ON router_decisions (user_id, created_at DESC);
CREATE INDEX router_decisions_request_idx ON router_decisions (request_id);

ALTER TABLE router_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE router_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY router_decisions_owner ON router_decisions
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- Approvazione legata a (tool, hash argomenti, utente, scadenza), monouso e consumata atomicamente.
CREATE TABLE tool_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  request_id    text NOT NULL,
  tool_call_id  text NOT NULL,
  tool_id       text NOT NULL,
  args_hash     text NOT NULL,
  reason        text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','consumed')),
  expires_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_approvals_user_status_idx ON tool_approvals (user_id, status, expires_at);

ALTER TABLE tool_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_approvals_owner ON tool_approvals
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
