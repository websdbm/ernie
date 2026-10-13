-- Second brain (docs/research/12-second-brain.md): le note vivono come file markdown in un repository git per
-- utente (vault di Obsidian); qui c'è solo l'indice per Ernie, ricostruibile dal repository in ogni momento:
-- metadati (tempo, luogo, collegamenti, riservata) e pezzi per la ricerca ibrida full-text + vettori.
CREATE TABLE brain_notes (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path         text NOT NULL,
  title        text NOT NULL,
  note_type    text NOT NULL,
  created      timestamptz NOT NULL,
  refers_from  date,
  refers_to    date,
  place        text,
  lat          double precision,
  lon          double precision,
  links        text[] NOT NULL DEFAULT '{}',
  private      boolean NOT NULL DEFAULT false,
  source       text,
  excerpt      text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, path)
);
CREATE INDEX brain_notes_title_idx ON brain_notes (user_id, lower(title));
CREATE INDEX brain_notes_links_idx ON brain_notes USING gin (links);
ALTER TABLE brain_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_notes_owner ON brain_notes
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

CREATE TABLE brain_chunks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path      text NOT NULL,
  ordinal   int NOT NULL,
  heading   text,
  content   text NOT NULL,
  tsv       tsvector GENERATED ALWAYS AS (to_tsvector('italian', coalesce(heading,'') || ' ' || content)) STORED,
  embedding vector(1536),
  UNIQUE (user_id, path, ordinal),
  FOREIGN KEY (user_id, path) REFERENCES brain_notes (user_id, path) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX brain_chunks_tsv_idx ON brain_chunks USING gin (tsv);
CREATE INDEX brain_chunks_embedding_idx ON brain_chunks USING hnsw (embedding vector_cosine_ops);
ALTER TABLE brain_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_chunks_owner ON brain_chunks
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
