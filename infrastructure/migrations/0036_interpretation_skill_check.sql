-- Controllo dei comandi rapidi (richiesta dell'utente, 15 ott 2026): prima di eseguire senza modello un comando di
-- una skill (promemoria, messaggio), Jev confronta quello che la skill ha capito con la frase. Anche questi
-- controlli finiscono in interpretation_checks, con trigger 'skill' (cosa avrebbe fatto la skill e la probabilità
-- che fosse fedele alla richiesta), per tarare la soglia.
ALTER TABLE interpretation_checks DROP CONSTRAINT interpretation_checks_trigger_check;
ALTER TABLE interpretation_checks ADD CONSTRAINT interpretation_checks_trigger_check
  CHECK (trigger IN ('ambiguous', 'correction', 'skill'));
ALTER TABLE interpretation_checks
  ADD COLUMN skill_id text,
  ADD COLUMN planned text CHECK (char_length(planned) <= 600),
  ADD COLUMN faithful real;
