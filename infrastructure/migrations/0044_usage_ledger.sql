-- Il registro economico sopravvive alla cancellazione di chat, chiamate e account.
-- Contiene solo metadati di consumo, mai prompt, risposte o credenziali.
-- Backfill e installazione dei trigger devono vedere lo stesso insieme di fonti:
-- le chiamate in corso riprendono al commit, senza una finestra non contabilizzata.
LOCK TABLE users, llm_calls, router_decisions IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE usage_accounts (
  user_id uuid PRIMARY KEY,
  display_name text NOT NULL,
  companion_name text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO usage_accounts (user_id, display_name, companion_name, created_at)
  SELECT id, display_name, companion_name, created_at FROM users;

-- Il generico ruolo owner NON concede la vista delle altre installazioni.
-- Solo amministrazione DB: nessun endpoint o settings utente può concedere il permesso.
CREATE TABLE usage_admins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES usage_accounts(user_id),
  source text NOT NULL CHECK (source IN ('llm','jev')),
  source_id bigint NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  reported_usd numeric(18,10),
  estimated_usd numeric(18,10) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX usage_ledger_user_time ON usage_ledger(user_id, created_at);
CREATE INDEX usage_ledger_time ON usage_ledger(created_at);

-- Nel gateway corrente solo OpenRouter comunica il costo effettivo. Il vecchio
-- recorder manteneva "anthropic" anche dopo il fallback: correggere il registro,
-- senza riscrivere l'audit originale.
INSERT INTO usage_ledger
  (user_id, source, source_id, provider, model, purpose,
   input_tokens, output_tokens, reported_usd, estimated_usd, created_at)
SELECT user_id, 'llm', id,
       CASE WHEN provider = 'anthropic' AND cost_reported_usd IS NOT NULL
            THEN 'openrouter' ELSE provider END,
       model, purpose, input_tokens, output_tokens,
       cost_reported_usd, cost_estimated_usd, created_at
FROM llm_calls;

INSERT INTO usage_ledger
  (user_id, source, source_id, provider, model, purpose,
   input_tokens, reported_usd, created_at)
SELECT user_id, 'jev', id, 'openrouter', COALESCE(jev_model, 'typesafe/jev'),
       'router', input_tokens, cost_usd, created_at
FROM router_decisions WHERE source = 'jev';

-- Le scritture applicative al registro sono consentite solo dai trigger delle
-- fonti originali. L'inserimento della chiamata e del costo è un'unica transazione.
CREATE FUNCTION usage_capture_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'llm_calls' THEN
    INSERT INTO public.usage_ledger
      (user_id, source, source_id, provider, model, purpose,
       input_tokens, output_tokens, reported_usd, estimated_usd, created_at)
    VALUES (NEW.user_id, 'llm', NEW.id,
            CASE WHEN NEW.provider = 'anthropic' AND NEW.cost_reported_usd IS NOT NULL
                 THEN 'openrouter' ELSE NEW.provider END,
            NEW.model, NEW.purpose, NEW.input_tokens, NEW.output_tokens,
            NEW.cost_reported_usd, NEW.cost_estimated_usd, NEW.created_at);
  ELSIF TG_TABLE_NAME = 'router_decisions' AND NEW.source = 'jev' THEN
    INSERT INTO public.usage_ledger
      (user_id, source, source_id, provider, model, purpose,
       input_tokens, reported_usd, created_at)
    VALUES (NEW.user_id, 'jev', NEW.id, 'openrouter',
            COALESCE(NEW.jev_model, 'typesafe/jev'), 'router',
            NEW.input_tokens, NEW.cost_usd, NEW.created_at);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION usage_capture_call() FROM PUBLIC, ernie_app;
CREATE TRIGGER usage_capture_llm AFTER INSERT ON llm_calls
  FOR EACH ROW EXECUTE FUNCTION usage_capture_call();
CREATE TRIGGER usage_capture_jev AFTER INSERT ON router_decisions
  FOR EACH ROW EXECUTE FUNCTION usage_capture_call();

CREATE FUNCTION usage_capture_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Restano importi e riferimento contabile, non il nome della persona eliminata.
    UPDATE public.usage_accounts
       SET display_name = 'Account eliminato', companion_name = 'Ernie', deleted = true
     WHERE user_id = OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO public.usage_accounts (user_id, display_name, companion_name, created_at)
  VALUES (NEW.id, NEW.display_name, NEW.companion_name, NEW.created_at)
  ON CONFLICT (user_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        companion_name = EXCLUDED.companion_name;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION usage_capture_account() FROM PUBLIC, ernie_app;
CREATE TRIGGER usage_account_created AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION usage_capture_account();
CREATE TRIGGER usage_account_updated AFTER UPDATE OF display_name, companion_name ON users
  FOR EACH ROW EXECUTE FUNCTION usage_capture_account();
CREATE TRIGGER usage_account_deleted AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION usage_capture_account();

REVOKE ALL ON usage_accounts, usage_admins, usage_ledger FROM ernie_app;
REVOKE ALL ON SEQUENCE usage_ledger_id_seq FROM ernie_app;
GRANT SELECT ON usage_accounts, usage_admins, usage_ledger TO ernie_app;
ALTER TABLE usage_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_admin_self ON usage_admins FOR SELECT
  USING (user_id = app_current_user_id());
ALTER TABLE usage_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_accounts_read ON usage_accounts FOR SELECT
  USING (user_id = app_current_user_id()
    OR EXISTS (SELECT 1 FROM usage_admins WHERE user_id = app_current_user_id()));
ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_ledger_read ON usage_ledger FOR SELECT
  USING (user_id = app_current_user_id()
    OR EXISTS (SELECT 1 FROM usage_admins WHERE user_id = app_current_user_id()));
