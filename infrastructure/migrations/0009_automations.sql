-- M6: Automation Engine — definizioni versionate, run idempotenti con storico, notifiche.

CREATE TABLE automations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key            text NOT NULL,
  title          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('deterministic','guided')),
  trigger        jsonb NOT NULL,                      -- { type: cron|once|webhook|event, pattern|at|eventName }
  timezone       text NOT NULL DEFAULT 'Europe/Rome',
  action         jsonb NOT NULL,                      -- deterministic: { skillId, input } · guided: { instructions, allowedTools, modelClass, contextTags }
  budget_usd     numeric(10,4) NOT NULL DEFAULT 0.05,
  catch_up       text NOT NULL DEFAULT 'none' CHECK (catch_up IN ('none','latest')),
  jitter_s       int  NOT NULL DEFAULT 0,
  notify         boolean NOT NULL DEFAULT true,
  enabled        boolean NOT NULL DEFAULT true,
  version        int  NOT NULL DEFAULT 1,
  webhook_secret text,                                -- solo per trigger webhook (M9: cifratura)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
CREATE INDEX automations_enabled_idx ON automations (enabled) WHERE enabled;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_owner ON automations USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Una riga per esecuzione; (automation_id, dedupe_key) è la chiave di idempotenza (per i cron: l'istante pianificato).
CREATE TABLE automation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at    timestamptz NOT NULL,
  dedupe_key      text NOT NULL,                      -- cron:<istante> · once:<istante> · webhook:<idempotency key> · event:<id> · manual:<id>
  trigger_type    text NOT NULL,
  trigger_payload jsonb,
  status          text NOT NULL DEFAULT 'claimed' CHECK (status IN ('scheduled','claimed','running','succeeded','failed','skipped','budget_exceeded','awaiting_approval')),
  outcome         jsonb,                              -- { summary, data } distinto dal successo infrastrutturale
  error           text,
  cost_usd        numeric(12,8) NOT NULL DEFAULT 0,
  llm_calls       int NOT NULL DEFAULT 0,
  tool_calls      int NOT NULL DEFAULT 0,
  attempt         int NOT NULL DEFAULT 1,
  session_id      uuid,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, dedupe_key)
);
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, scheduled_at DESC);
CREATE INDEX automation_runs_user_idx ON automation_runs (user_id, created_at DESC);
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_runs_owner ON automation_runs USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,                          -- automation.result | automation.approval | system
  title       text NOT NULL,
  body        text NOT NULL,
  payload     jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_owner ON notifications USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- Verifica dei webhook senza utente autenticato: la funzione è SECURITY DEFINER e restituisce solo
-- ciò che serve a verificare la firma (user_id, segreto, stato), mai la definizione.
CREATE FUNCTION webhook_target(p_automation_id uuid)
RETURNS TABLE (user_id uuid, webhook_secret text, enabled boolean)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT a.user_id, a.webhook_secret, a.enabled
    FROM automations a
   WHERE a.id = p_automation_id AND a.trigger->>'type' = 'webhook'
$$;
REVOKE ALL ON FUNCTION webhook_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_target(uuid) TO ernie_app;

-- Lo scheduler del worker legge le automazioni abilitate di tutti gli utenti: policy di sola lettura
-- attiva quando la transazione imposta app.scheduler = 'on' (nessun accesso alle run né alle notifiche).
CREATE POLICY automations_scheduler_read ON automations FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on');
