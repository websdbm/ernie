-- Raccolta personale di immagini: gli allegati OCR precedenti non avevano originali da migrare.
CREATE TABLE media_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 1 AND 3000000),
  thumbnail_bytes bytea NOT NULL CHECK (octet_length(thumbnail_bytes) BETWEEN 1 AND 400000),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 3200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 3200),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  category text NOT NULL DEFAULT 'Foto' CHECK (length(category) BETWEEN 1 AND 40),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  ocr_text text NOT NULL DEFAULT '' CHECK (length(ocr_text) <= 60000),
  source text NOT NULL CHECK (source IN ('photo', 'scan', 'library')),
  organization text NOT NULL DEFAULT 'manual' CHECK (organization IN ('pending', 'automatic', 'manual', 'failed')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id),
  UNIQUE (user_id, sha256)
);
CREATE INDEX media_items_user_idx ON media_items (user_id, created_at DESC, id DESC);
CREATE INDEX media_items_tags_idx ON media_items USING gin(tags);
ALTER TABLE media_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_items FORCE ROW LEVEL SECURITY;
CREATE POLICY media_items_owner ON media_items
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
