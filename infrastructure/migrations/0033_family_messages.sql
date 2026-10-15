-- Messaggi in famiglia (richiesta dell'utente, 15 ott 2026): messaggi brevi fra persone collegate, con una foto
-- facoltativa e la possibilità di rispondere. Si vedono nella chat di entrambi con un fumetto diverso da quello
-- dell'utente e di Ernie; il mittente compare con il nome che gli dà chi riceve (family_links). La foto sta qui
-- (bytea, già ridotta sul telefono): niente file sparsi sul disco e la stessa RLS dei messaggi.
CREATE TABLE family_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  reply_to      uuid REFERENCES family_messages(id) ON DELETE SET NULL,
  image_mime    text CHECK (image_mime IN ('image/jpeg', 'image/png', 'image/heic')),
  image_bytes   bytea CHECK (octet_length(image_bytes) <= 4000000),
  image_w       integer,
  image_h       integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CHECK (sender_id <> recipient_id),
  CHECK (body <> '' OR image_bytes IS NOT NULL),
  CHECK ((image_bytes IS NULL) = (image_mime IS NULL))
);
CREATE INDEX family_messages_recipient_idx ON family_messages (recipient_id, created_at DESC);
CREATE INDEX family_messages_sender_idx ON family_messages (sender_id, created_at DESC);
ALTER TABLE family_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_messages FORCE ROW LEVEL SECURITY;
-- Lo vedono mittente e destinatario; lo scrive solo il mittente e solo a una persona collegata; il destinatario
-- segna la lettura.
CREATE POLICY family_messages_read ON family_messages FOR SELECT
  USING (sender_id = app_current_user_id() OR recipient_id = app_current_user_id());
CREATE POLICY family_messages_insert ON family_messages FOR INSERT
  WITH CHECK (
    sender_id = app_current_user_id()
    AND EXISTS (SELECT 1 FROM family_links l WHERE l.user_id = app_current_user_id() AND l.other_user_id = recipient_id)
  );
CREATE POLICY family_messages_mark_read ON family_messages FOR UPDATE
  USING (recipient_id = app_current_user_id()) WITH CHECK (recipient_id = app_current_user_id());
