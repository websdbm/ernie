-- M2: utenti come "companion" distinti, sessioni, registro delle chiamate LLM, Soul versionato.

-- Ogni utente ha il proprio agente personalizzato: nome del companion, ruolo (owner gestisce
-- gli altri account e le loro policy), impostazioni (classe modello predefinita, budget, voce).
ALTER TABLE users
  ADD COLUMN role           text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  ADD COLUMN companion_name text NOT NULL DEFAULT 'Ernie',
  ADD COLUMN settings       jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id      uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  client_platform text,
  client_version  text,
  locale          text,
  context_tags    text[] NOT NULL DEFAULT '{}',
  model_class     text NOT NULL DEFAULT 'standard' CHECK (model_class IN ('light','standard','heavy')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX sessions_user_last_seen_idx ON sessions (user_id, last_seen_at DESC);

-- Una riga per chiamata HTTP al provider (step), mai per turno aggregato (spike M2.1).
CREATE TABLE llm_calls (
  id                 bigserial PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id         uuid REFERENCES sessions(id) ON DELETE SET NULL,
  request_id         text NOT NULL,                    -- correlationId del turno
  step_index         int  NOT NULL DEFAULT 0,
  purpose            text NOT NULL DEFAULT 'turn' CHECK (purpose IN ('turn','summary','memory','router','skill','automation','other')),
  provider           text NOT NULL,
  model              text NOT NULL,
  model_class        text,
  generation_id      text,
  input_tokens       int  NOT NULL DEFAULT 0,
  cache_read_tokens  int  NOT NULL DEFAULT 0,
  cache_write_tokens int  NOT NULL DEFAULT 0,
  output_tokens      int  NOT NULL DEFAULT 0,
  reasoning_tokens   int  NOT NULL DEFAULT 0,
  cost_reported_usd  numeric(14,10),
  cost_estimated_usd numeric(14,10) NOT NULL DEFAULT 0,
  cost_source        text NOT NULL DEFAULT 'pricelist' CHECK (cost_source IN ('provider','pricelist')),
  ttft_ms            int,
  latency_ms         int  NOT NULL DEFAULT 0,
  finish_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_user_created_idx ON llm_calls (user_id, created_at DESC);
CREATE INDEX llm_calls_session_idx ON llm_calls (session_id);
CREATE INDEX llm_calls_request_idx ON llm_calls (request_id);

-- Soul: identità (core), comportamenti per contesto (context), policy operative (policy).
-- user_id NULL = modello globale predefinito; ogni utente ha i propri Soul (chiave unica per utente).
-- Nessun tool dell'agente ha accesso in scrittura.
CREATE TABLE souls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL,                -- es. 'core', 'ctx:cucina', 'policy:voce'
  kind             text NOT NULL CHECK (kind IN ('core','context','policy')),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  tags             text[] NOT NULL DEFAULT '{}',
  current_version  int  NOT NULL DEFAULT 1,
  content          text NOT NULL,
  token_estimate   int  NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  -- Se true solo un owner può modificarlo (policy imposte, es. per un minore).
  locked           boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX souls_global_key_idx ON souls (key) WHERE user_id IS NULL;
CREATE UNIQUE INDEX souls_user_key_idx ON souls (user_id, key) WHERE user_id IS NOT NULL;
CREATE TABLE soul_versions (
  soul_id         uuid NOT NULL REFERENCES souls(id) ON DELETE CASCADE,
  version         int  NOT NULL,
  content         text NOT NULL,
  token_estimate  int  NOT NULL,
  author          text NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soul_id, version)
);
