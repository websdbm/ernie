-- Coda delle risorse Brain (revisione del 25 ott 2026).
-- 1. Un job che fallisce sempre non blocca più la coda dell'utente: conta i tentativi e aspetta sempre di più
--    (next_attempt_at); gli altri job passano avanti. Una modifica della risorsa lo rende subito ritentabile.
-- 2. Una nuova persona o un nuovo luogo non rimettono in coda TUTTE le ricette e le foto: solo quelle che ne citano il
--    titolo (vecchio o nuovo), che li collegano a mano e, per i luoghi, le foto scattate nei dintorni.
ALTER TABLE brain_resource_queue
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX brain_resource_queue_due ON brain_resource_queue(user_id, next_attempt_at);

CREATE OR REPLACE FUNCTION enqueue_brain_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u uuid; r uuid; k text;
BEGIN
 u := coalesce(NEW.user_id,OLD.user_id); r := coalesce(NEW.id,OLD.id);
 k := CASE WHEN TG_TABLE_NAME='recipes' THEN 'recipe' ELSE 'media' END;
 -- Nessuna ricreazione della coda durante la cancellazione dell'account.
 IF EXISTS(SELECT 1 FROM users WHERE id=u) THEN
  INSERT INTO brain_resource_queue(user_id,kind,resource_id) VALUES(u,k,r)
   ON CONFLICT(user_id,kind,resource_id) DO UPDATE SET generation=nextval('brain_resource_generation'),
    queued_at=now(),attempts=0,next_attempt_at=now();
 END IF;
 RETURN NULL;
END $$;

-- Approssimazione per eccesso di `normalized()` (packages/brain/src/reconcile.ts): senza accenti, minuscolo,
-- separatori uniformi. Il confronto è un semplice «contiene»: può rimettere in coda qualche risorsa in più, mai in meno.
CREATE FUNCTION brain_mention_key(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(recipe_search_normalize($1), '[^[:alnum:]]+', ' ', 'g'))
$$;
CREATE FUNCTION brain_json_text(jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof($1)='array'
    THEN (SELECT string_agg(e, ' ') FROM jsonb_array_elements_text($1) e) ELSE $1 #>> '{}' END
$$;

CREATE OR REPLACE FUNCTION refresh_brain_resource_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u uuid; titles text[]; paths text[];
 kinds constant text[] := ARRAY['persona','luogo','progetto','argomento'];
BEGIN
 IF TG_OP='UPDATE' AND (NEW.title,NEW.path,NEW.note_type,NEW.private,NEW.lat,NEW.lon) IS NOT DISTINCT FROM
   (OLD.title,OLD.path,OLD.note_type,OLD.private,OLD.lat,OLD.lon) THEN RETURN NULL; END IF;
 -- Anche una scheda che smette di essere persona/luogo deve scollegarsi dalle risorse.
 IF NOT (coalesce(NEW.note_type,'') = ANY(kinds) OR coalesce(OLD.note_type,'') = ANY(kinds)) THEN RETURN NULL; END IF;
 u := coalesce(NEW.user_id,OLD.user_id);
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=u) THEN RETURN NULL; END IF;
 -- Come resourceTextLinks: titoli normalizzati di almeno 3 caratteri.
 SELECT coalesce(array_agg(DISTINCT t), '{}') INTO titles
  FROM unnest(ARRAY[brain_mention_key(OLD.title), brain_mention_key(NEW.title)]) t
  WHERE length(t) >= 3;
 paths := array_remove(ARRAY[OLD.path, NEW.path, regexp_replace(OLD.path,'\.md$',''),
  regexp_replace(NEW.path,'\.md$','')], NULL);
 INSERT INTO brain_resource_queue(user_id,kind,resource_id)
  SELECT r.user_id,'recipe',r.id FROM recipes r WHERE r.user_id=u AND r.status='active' AND (
   r.brain_links && paths OR EXISTS(SELECT 1 FROM unnest(titles) t WHERE strpos(brain_mention_key(concat_ws(' ',
    r.title, r.category, array_to_string(r.tags,' '), brain_json_text(r.ingredients), brain_json_text(r.steps),
    r.time, r.servings, r.source, r.url, r.notes)), t) > 0))
  UNION ALL
  SELECT m.user_id,'media',m.id FROM media_items m WHERE m.user_id=u AND (
   m.brain_links && paths
   OR EXISTS(SELECT 1 FROM unnest(titles) t WHERE strpos(brain_mention_key(concat_ws(' ',
    m.title, m.category, array_to_string(m.tags,' '), m.description, m.ocr_text)), t) > 0)
   -- Il sincronizzatore collega le foto entro 75 m: qui un riquadro più largo (circa 200 m) attorno alla vecchia e
   -- alla nuova posizione del luogo.
   OR (m.location IS NOT NULL AND EXISTS(
    SELECT 1 FROM (VALUES (OLD.lat,OLD.lon),(NEW.lat,NEW.lon)) p(lat,lon)
     WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL
      AND abs((m.location->>'lat')::double precision - p.lat) <= 0.002
      AND abs((m.location->>'lon')::double precision - p.lon) * cos(radians(p.lat)) <= 0.002)))
  ON CONFLICT(user_id,kind,resource_id) DO UPDATE SET generation=nextval('brain_resource_generation'),
   queued_at=now(),attempts=0,next_attempt_at=now();
 RETURN NULL;
END $$;

-- L'heartbeat vede solo gli utenti con lavoro già dovuto, non quelli con soli job in attesa del prossimo tentativo.
CREATE OR REPLACE FUNCTION brain_resource_pending_users() RETURNS TABLE(user_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT DISTINCT q.user_id FROM brain_resource_queue q WHERE q.next_attempt_at <= now()
  ORDER BY q.user_id LIMIT 100;
$$;
