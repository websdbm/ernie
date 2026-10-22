-- Ricette e immagini restano canoniche in SQL; la coda rende recuperabile l'indice/vault Brain.
ALTER TABLE recipes ADD COLUMN brain_links text[] NOT NULL DEFAULT '{}' CHECK (cardinality(brain_links) <= 20);
ALTER TABLE media_items ADD COLUMN brain_links text[] NOT NULL DEFAULT '{}' CHECK (cardinality(brain_links) <= 20);
ALTER TABLE media_items ADD COLUMN location jsonb CHECK (location IS NULL OR (
  jsonb_typeof(location)='object' AND location ? 'lat' AND location ? 'lon'
  AND (location->>'lat')::double precision BETWEEN -90 AND 90
  AND (location->>'lon')::double precision BETWEEN -180 AND 180));
CREATE SEQUENCE brain_resource_generation;
CREATE TABLE brain_resource_queue (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('recipe','media')),
  resource_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT nextval('brain_resource_generation'),
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,kind,resource_id)
);
ALTER TABLE brain_resource_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_resource_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_resource_owner ON brain_resource_queue
 USING(user_id=app_current_user_id()) WITH CHECK(user_id=app_current_user_id());
CREATE FUNCTION enqueue_brain_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u uuid; r uuid; k text;
BEGIN
 u := coalesce(NEW.user_id,OLD.user_id); r := coalesce(NEW.id,OLD.id);
 k := CASE WHEN TG_TABLE_NAME='recipes' THEN 'recipe' ELSE 'media' END;
 -- Nessuna ricreazione della coda durante la cancellazione dell'account.
 IF EXISTS(SELECT 1 FROM users WHERE id=u) THEN
  INSERT INTO brain_resource_queue(user_id,kind,resource_id) VALUES(u,k,r)
   ON CONFLICT(user_id,kind,resource_id) DO UPDATE SET generation=nextval('brain_resource_generation'),queued_at=now();
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER recipes_brain_queue AFTER INSERT OR UPDATE OR DELETE ON recipes FOR EACH ROW EXECUTE FUNCTION enqueue_brain_resource();
CREATE TRIGGER media_brain_queue AFTER INSERT OR UPDATE OR DELETE ON media_items FOR EACH ROW EXECUTE FUNCTION enqueue_brain_resource();
-- Una nuova identita o luogo deve collegare anche immagini/ricette preesistenti. Le pagine
-- risorsa e le sole modifiche al testo non innescano scansioni ricorsive.
CREATE FUNCTION refresh_brain_resource_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u uuid;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.title,NEW.path,NEW.note_type,NEW.private,NEW.lat,NEW.lon) IS NOT DISTINCT FROM
   (OLD.title,OLD.path,OLD.note_type,OLD.private,OLD.lat,OLD.lon) THEN RETURN NULL; END IF;
 IF coalesce(NEW.note_type,OLD.note_type) NOT IN ('persona','luogo','progetto','argomento') THEN RETURN NULL; END IF;
 u := coalesce(NEW.user_id,OLD.user_id);
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=u) THEN RETURN NULL; END IF;
 INSERT INTO brain_resource_queue(user_id,kind,resource_id)
  SELECT user_id,'recipe',id FROM recipes WHERE user_id=u AND status='active'
  UNION ALL SELECT user_id,'media',id FROM media_items WHERE user_id=u
  ON CONFLICT(user_id,kind,resource_id) DO UPDATE SET generation=nextval('brain_resource_generation'),queued_at=now();
 RETURN NULL;
END $$;
CREATE TRIGGER brain_resource_relink AFTER INSERT OR UPDATE OR DELETE ON brain_notes FOR EACH ROW EXECUTE FUNCTION refresh_brain_resource_links();
-- L'heartbeat vede solo gli ID con lavoro pendente, non i contenuti di altri utenti.
CREATE FUNCTION brain_resource_pending_users() RETURNS TABLE(user_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT DISTINCT q.user_id FROM brain_resource_queue q ORDER BY q.user_id LIMIT 100;
$$;
REVOKE ALL ON FUNCTION brain_resource_pending_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_resource_pending_users() TO ernie_app;
-- Backfill una tantum, senza modificare originali/versioni o invocare modelli.
INSERT INTO brain_resource_queue(user_id,kind,resource_id)
 SELECT user_id,'recipe',id FROM recipes WHERE status='active'
 UNION ALL SELECT user_id,'media',id FROM media_items;
