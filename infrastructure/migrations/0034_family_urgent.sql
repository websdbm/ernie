-- Messaggi urgenti, «super snooze» (richiesta dell'utente, 15 ott 2026): solo da un genitore a un figlio. Il telefono
-- del figlio continua a suonare finché non apre il messaggio e conferma di averlo letto; il genitore vede quando.
-- Il server ripete la notifica: nag_count e last_nag_at dicono quante volte e quando l'ultima; nag_stopped_at quando
-- ha smesso senza conferma (dopo un'ora), così il genitore lo sa una volta sola.
ALTER TABLE family_messages
  ADD COLUMN urgent          boolean NOT NULL DEFAULT false,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN nag_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN last_nag_at     timestamptz,
  ADD COLUMN nag_stopped_at  timestamptz;
CREATE INDEX family_messages_urgent_idx ON family_messages (created_at)
  WHERE urgent AND acknowledged_at IS NULL AND nag_stopped_at IS NULL;

-- Urgente solo verso chi per il mittente è «figlio».
DROP POLICY family_messages_insert ON family_messages;
CREATE POLICY family_messages_insert ON family_messages FOR INSERT
  WITH CHECK (
    sender_id = app_current_user_id()
    AND EXISTS (SELECT 1 FROM family_links l WHERE l.user_id = app_current_user_id() AND l.other_user_id = recipient_id)
    AND (NOT urgent OR EXISTS (
      SELECT 1 FROM family_links l
       WHERE l.user_id = app_current_user_id() AND l.other_user_id = recipient_id AND l.relation = 'figlio'
    ))
    AND acknowledged_at IS NULL AND nag_count = 0 AND last_nag_at IS NULL AND nag_stopped_at IS NULL
  );

-- Il destinatario cambia solo lettura e conferma (prima poteva aggiornare qualsiasi colonna della sua riga).
REVOKE UPDATE ON family_messages FROM ernie_app;
GRANT UPDATE (read_at, acknowledged_at) ON family_messages TO ernie_app;

-- Ripetizioni dovute (per il server, fuori dalla RLS): ogni 30 secondi nei primi 15 minuti, poi ogni minuto, per
-- un'ora. Segna subito la ripetizione, così due giri contemporanei non mandano la stessa notifica due volte.
CREATE FUNCTION family_urgent_due()
RETURNS TABLE (o_id uuid, o_sender uuid, o_recipient uuid, o_count integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT m.id FROM family_messages m
     WHERE m.urgent AND m.acknowledged_at IS NULL AND m.nag_stopped_at IS NULL
       AND m.created_at > now() - interval '60 minutes'
       AND COALESCE(m.last_nag_at, m.created_at) <
           now() - CASE WHEN m.created_at > now() - interval '15 minutes' THEN interval '28 seconds' ELSE interval '58 seconds' END
     FOR UPDATE SKIP LOCKED
  )
  UPDATE family_messages m SET nag_count = m.nag_count + 1, last_nag_at = now()
    FROM due WHERE m.id = due.id
  RETURNING m.id, m.sender_id, m.recipient_id, m.nag_count
$$;
REVOKE ALL ON FUNCTION family_urgent_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_urgent_due() TO ernie_app;

-- Scaduti senza conferma: smette di suonare e lo dice al genitore (una volta).
CREATE FUNCTION family_urgent_expired()
RETURNS TABLE (o_id uuid, o_sender uuid, o_recipient uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE family_messages m SET nag_stopped_at = now()
   WHERE m.urgent AND m.acknowledged_at IS NULL AND m.nag_stopped_at IS NULL
     AND m.created_at <= now() - interval '60 minutes'
  RETURNING m.id, m.sender_id, m.recipient_id
$$;
REVOKE ALL ON FUNCTION family_urgent_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION family_urgent_expired() TO ernie_app;
