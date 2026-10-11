-- M4: Memory Engine — fatti semantici, episodi e procedure con provenienza, validità temporale,
-- ricerca ibrida (full-text italiano + vettori) e cursori di consolidamento.

CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('semantic','episodic','procedural')),
  category      text,                                   -- preference | fact | relationship | project | habit | outcome | error | other
  content       text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  provenance    jsonb NOT NULL DEFAULT '{}'::jsonb,     -- { source, trust, sessionId, requestId, url, note }
  confidence    real NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz,
  expired_at    timestamptz,
  episode_id    uuid REFERENCES memories(id) ON DELETE SET NULL,
  supersedes_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  content_hash  text NOT NULL,
  embedding     vector(1536),
  embedding_model text,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('italian', content)) STORED,
  seen_count    int NOT NULL DEFAULT 1,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_user_kind_status_idx ON memories (user_id, kind, status, last_seen_at DESC);
CREATE UNIQUE INDEX memories_user_hash_active_idx ON memories (user_id, content_hash) WHERE status = 'active';
CREATE INDEX memories_tsv_idx ON memories USING gin (tsv);
CREATE INDEX memories_embedding_hnsw_idx ON memories USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
CREATE POLICY memories_owner ON memories
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- Avanzamento del consolidamento per thread (quali messaggi sono già stati letti).
CREATE TABLE memory_cursors (
  thread_id     text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at timestamptz,
  processed     int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memory_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_cursors_owner ON memory_cursors
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
