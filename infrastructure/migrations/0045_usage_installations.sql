-- Distinguere installazioni dell'app da account CLI/tecnici senza cancellare costi.
-- La presenza sopravvive a logout, revoca APNs e cancellazione dell'account.
LOCK TABLE sessions, devices IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE usage_accounts
  ADD COLUMN installation_seen_at timestamptz,
  ADD COLUMN is_test boolean NOT NULL DEFAULT false;

WITH installed AS (
  SELECT user_id, min(created_at) AS first_seen FROM (
    SELECT user_id, created_at FROM sessions WHERE client_platform = 'ios'
    UNION ALL
    SELECT user_id, created_at FROM devices WHERE platform = 'ios'
  ) s GROUP BY user_id
)
UPDATE usage_accounts a SET installation_seen_at = i.first_seen
FROM installed i WHERE a.user_id = i.user_id;

-- Solo amministrazione DB può classificare un account di collaudo. Nome, ruolo
-- owner e preferenze dell'utente non concedono inclusione o permessi aggiuntivi.
CREATE FUNCTION usage_capture_installation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    IF NEW.client_platform IS DISTINCT FROM 'ios' THEN RETURN NEW; END IF;
  END IF;
  UPDATE public.usage_accounts
     SET installation_seen_at = LEAST(installation_seen_at, NEW.created_at)
   WHERE user_id = NEW.user_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION usage_capture_installation() FROM PUBLIC, ernie_app;
CREATE TRIGGER usage_installation_session AFTER INSERT OR UPDATE OF client_platform ON sessions
  FOR EACH ROW EXECUTE FUNCTION usage_capture_installation();
CREATE TRIGGER usage_installation_device AFTER INSERT OR UPDATE OF user_id ON devices
  FOR EACH ROW EXECUTE FUNCTION usage_capture_installation();
