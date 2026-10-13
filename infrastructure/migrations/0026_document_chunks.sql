-- Ricerca 11, S2: documenti divisi in pezzi con pagina e titolo di sezione, per risposte di studio che
-- citano la pagina («(p. 42)») e per «interrogami solo sul capitolo 3». Ricerca ibrida full-text + vettori.
CREATE TABLE document_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page         int NOT NULL,
  ordinal      int NOT NULL,
  heading      text,
  content      text NOT NULL,
  content_hash text NOT NULL,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('italian', coalesce(heading,'') || ' ' || content)) STORED,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX document_chunks_doc_idx ON document_chunks (document_id, page);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY document_chunks_owner ON document_chunks
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
