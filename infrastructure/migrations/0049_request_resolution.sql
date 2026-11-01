-- Il risolutore comune usa lo stesso audit dei chiarimenti; nessun dato applicativo viene modificato.
ALTER TABLE interpretation_checks DROP CONSTRAINT interpretation_checks_trigger_check;
ALTER TABLE interpretation_checks ADD CONSTRAINT interpretation_checks_trigger_check
  CHECK (trigger IN ('ambiguous', 'correction', 'skill', 'request'));
