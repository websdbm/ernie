-- Archivio ricette: classificazione esplicita e ricerca coerente fra testo, ingredienti e metadati.
-- Le ricette esistenti restano non classificate. Nessun dato o versione viene eliminato.
ALTER TABLE recipes ADD COLUMN category text CHECK (category IN (
  'Antipasti', 'Primi', 'Secondi', 'Contorni', 'Dolci', 'Colazioni e merende',
  'Pane e lievitati', 'Salse e conserve', 'Bevande', 'Altro'
));

-- NFD elimina gli accenti senza dipendenze da estensioni o dizionari mutabili.
CREATE FUNCTION recipe_search_normalize(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(normalize($1, NFD), U&'[\0300-\036f]', '', 'g'))
$$;
CREATE FUNCTION recipe_library_vector(text, text, jsonb, text[], text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('italian', recipe_search_normalize(
    coalesce($1, '') || ' ' || coalesce($2, '') || ' ' || coalesce($3::text, '') || ' ' ||
    coalesce(array_to_string($4, ' '), '') || ' ' || coalesce($5, '')))
$$;
ALTER TABLE recipes ADD COLUMN search_library tsvector GENERATED ALWAYS AS (
  recipe_library_vector(title, notes, ingredients, tags, category)
) STORED;
CREATE INDEX recipes_library_search_idx ON recipes USING gin (search_library);
CREATE INDEX recipes_library_category_idx ON recipes (user_id, category, updated_at DESC, id) WHERE status = 'active';
CREATE INDEX recipes_library_tags_idx ON recipes USING gin (tags) WHERE status = 'active';
