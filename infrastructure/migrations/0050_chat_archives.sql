-- Per-account WhatsApp text archives. No content is copied to ambient memory or Brain.
CREATE TABLE chat_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  category text CHECK (category IS NULL OR length(category) <= 80),
  summary text CHECK (summary IS NULL OR length(summary) <= 600),
  tags text[] NOT NULL DEFAULT '{}',
  time_zone text NOT NULL,
  whatsapp_phone text,
  whatsapp_url text,
  revision integer NOT NULL DEFAULT 0,
  indexed_revision integer NOT NULL DEFAULT 0,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  last_imported_at timestamptz NOT NULL DEFAULT now(),
  first_message_at timestamptz,
  latest_message_at timestamptz,
  message_count integer NOT NULL DEFAULT 0,
  participant_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE TABLE chat_archive_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  archive_id uuid NOT NULL,
  sender_key text NOT NULL,
  name text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  first_message_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL,
  UNIQUE (user_id, archive_id, id),
  UNIQUE (user_id, archive_id, sender_key),
  FOREIGN KEY (user_id, archive_id) REFERENCES chat_archives(user_id, id) ON DELETE CASCADE
);
CREATE TABLE chat_archive_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  archive_id uuid NOT NULL,
  sender_id uuid,
  sender text,
  at timestamptz NOT NULL,
  local_timestamp text NOT NULL,
  raw_text text NOT NULL,
  body text NOT NULL,
  message_type text NOT NULL CHECK (message_type IN ('text', 'system', 'media')),
  fingerprint text NOT NULL,
  position integer NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  UNIQUE (user_id, archive_id, id),
  UNIQUE (user_id, archive_id, position),
  FOREIGN KEY (user_id, archive_id) REFERENCES chat_archives(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, archive_id, sender_id) REFERENCES chat_archive_participants(user_id, archive_id, id)
);
CREATE INDEX chat_archive_messages_scope_time ON chat_archive_messages(user_id, archive_id, at, position);
CREATE INDEX chat_archive_messages_fingerprint ON chat_archive_messages(user_id, fingerprint, archive_id);
CREATE INDEX chat_archive_messages_search ON chat_archive_messages USING gin(search);
CREATE TABLE chat_archive_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  archive_id uuid NOT NULL,
  filename text NOT NULL,
  file_hash text NOT NULL,
  text_hash text NOT NULL,
  raw_text text NOT NULL,
  parser_version integer NOT NULL DEFAULT 1,
  time_zone text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  parsed_count integer NOT NULL,
  inserted_count integer NOT NULL,
  duplicate_count integer NOT NULL,
  warnings jsonb NOT NULL,
  unparsed_lines jsonb NOT NULL,
  UNIQUE (user_id, archive_id, id),
  UNIQUE (user_id, archive_id, file_hash),
  FOREIGN KEY (user_id, archive_id) REFERENCES chat_archives(user_id, id) ON DELETE CASCADE
);
CREATE TABLE chat_archive_occurrences (
  user_id uuid NOT NULL,
  archive_id uuid NOT NULL,
  import_id uuid NOT NULL,
  message_id uuid NOT NULL,
  position integer NOT NULL,
  raw_line_start integer NOT NULL,
  raw_line_end integer NOT NULL,
  PRIMARY KEY (user_id, archive_id, import_id, position),
  FOREIGN KEY (user_id, archive_id, import_id) REFERENCES chat_archive_imports(user_id, archive_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, archive_id, message_id) REFERENCES chat_archive_messages(user_id, archive_id, id) ON DELETE CASCADE
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_archives','chat_archive_participants','chat_archive_messages','chat_archive_imports','chat_archive_occurrences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner ON %I USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ernie_app', t);
  END LOOP;
END $$;
