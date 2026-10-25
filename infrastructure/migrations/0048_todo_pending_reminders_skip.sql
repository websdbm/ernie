-- Recupero dei promemoria Todo (revisione del 25 ott 2026): le liste che falliscono sempre restavano in cima alle
-- prime 100 e il recupero non arrivava mai alle altre. La nuova variante esclude le liste in attesa di un nuovo
-- tentativo (tenute in memoria dall'API); la funzione senza argomenti resta per compatibilità.
CREATE FUNCTION todo_pending_reminders(excluded uuid[]) RETURNS TABLE(user_id uuid,id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.user_id,t.id FROM todo_lists t
  WHERE t.reminder_revision<t.revision AND NOT (t.id = ANY(coalesce(excluded,'{}')))
 ORDER BY t.updated_at,t.user_id,t.id LIMIT 100;
$$;
REVOKE ALL ON FUNCTION todo_pending_reminders(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION todo_pending_reminders(uuid[]) TO ernie_app;
