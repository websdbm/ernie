-- Liste della spesa multiple (decisione dell'utente, 11 ott 2026): ogni lista ha un nome, si archivia e si richiama;
-- le voci hanno lo stato «presa» (bought) e restano visibili finché non vengono tolte. Le voci esistenti finiscono
-- nella lista predefinita «Spesa» di ciascun utente.
CREATE TABLE shopping_lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  name_norm     text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shopping_lists_name_idx ON shopping_lists (user_id, name_norm) WHERE status <> 'deleted';
CREATE INDEX shopping_lists_user_idx ON shopping_lists (user_id, status, last_used_at DESC);
ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY shopping_lists_owner ON shopping_lists USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

ALTER TABLE shopping_items ADD COLUMN list_id uuid REFERENCES shopping_lists(id) ON DELETE CASCADE;
INSERT INTO shopping_lists (user_id, name, name_norm)
  SELECT DISTINCT user_id, 'Spesa', 'spesa' FROM shopping_items
  ON CONFLICT DO NOTHING;
UPDATE shopping_items i SET list_id = l.id
  FROM shopping_lists l
  WHERE l.user_id = i.user_id AND l.name_norm = 'spesa' AND i.list_id IS NULL;
ALTER TABLE shopping_items ALTER COLUMN list_id SET NOT NULL;
DROP INDEX IF EXISTS shopping_items_active_idx;
-- Una voce per nome tra quelle non tolte (attive o prese) nella stessa lista.
CREATE UNIQUE INDEX shopping_items_open_idx ON shopping_items (list_id, name_norm) WHERE status <> 'removed';
CREATE INDEX shopping_items_list_idx ON shopping_items (list_id, status, added_at);
