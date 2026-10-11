-- Skill «Ricette»: ricette dell'utente, con versioni e provenienza; RLS per utente.
CREATE TABLE recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  title_norm    text NOT NULL,                                  -- titolo normalizzato (minuscolo, senza accenti) per cercare e deduplicare
  ingredients   jsonb NOT NULL DEFAULT '[]'::jsonb,            -- array di stringhe
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,            -- array di stringhe
  time          text,
  servings      text,
  source        text,
  url           text,
  notes         text,
  tags          text[] NOT NULL DEFAULT '{}',
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  search        tsvector GENERATED ALWAYS AS (to_tsvector('italian', coalesce(title,'') || ' ' || coalesce(notes,'') || ' ' || coalesce(ingredients::text,''))) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, title_norm)
);
CREATE INDEX recipes_search_idx ON recipes USING gin (search);
CREATE INDEX recipes_user_idx ON recipes (user_id, updated_at DESC);
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes FORCE ROW LEVEL SECURITY;
CREATE POLICY recipes_owner ON recipes USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Storico delle versioni (affinamenti successivi).
CREATE TABLE recipe_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id   uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version     int NOT NULL,
  snapshot    jsonb NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, version)
);
ALTER TABLE recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_versions_owner ON recipe_versions USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
