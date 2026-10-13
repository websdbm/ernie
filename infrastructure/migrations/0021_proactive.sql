-- M9 A3: gate della proattività (idea presa da Muffin). Ogni messaggio che Ernie manda di sua iniziativa
-- passa da qui: tipo in un insieme chiuso, solo evidenze dell'utente o della famiglia, ore di quiete,
-- tetto giornaliero, intervallo minimo. La riga è anche il lock d'invio: UNIQUE (user_id, dedupe_key) e
-- consegna con UPDATE … WHERE status = 'pending' (vince un solo processo).
CREATE TABLE proactive_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  dedupe_key  text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  payload     jsonb,
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dropped')),
  reason      text,
  not_before  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX proactive_messages_due_idx ON proactive_messages (not_before) WHERE status = 'pending';
CREATE INDEX proactive_messages_sent_idx ON proactive_messages (user_id, sent_at) WHERE status = 'sent';
ALTER TABLE proactive_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE proactive_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY proactive_messages_owner ON proactive_messages
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
-- Il worker cerca i messaggi in attesa di tutti gli utenti (sola lettura, solo pending), come lo scheduler.
CREATE POLICY proactive_messages_scheduler_read ON proactive_messages FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on' AND status = 'pending');
-- Produttore «conferma in scadenza»: legge le approvazioni pendenti di tutti gli utenti (sola lettura).
CREATE POLICY tool_approvals_scheduler_read ON tool_approvals FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on' AND status = 'pending');
