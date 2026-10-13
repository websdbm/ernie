-- M9: pausa automatica delle automazioni (decisione utente dall'analisi di Open Dots, 11 ott 2026).
-- Dopo 3 esecuzioni fallite di fila, o subito su errori che richiedono l'utente (credenziali, scope),
-- l'automazione si disabilita con un motivo leggibile; «Riprendi» (PATCH enabled=true) azzera tutto.
ALTER TABLE automations
  ADD COLUMN consecutive_failures int NOT NULL DEFAULT 0,
  ADD COLUMN paused_reason text,
  ADD COLUMN paused_at timestamptz;
