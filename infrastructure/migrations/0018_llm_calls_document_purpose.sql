-- Le chiamate del riassuntore dei documenti hanno purpose 'document', che il vincolo di 0003 non ammetteva:
-- la registrazione falliva in silenzio (costi dei documenti non tracciati). Si estende il vincolo.
ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_purpose_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check
  CHECK (purpose IN ('turn','summary','memory','router','skill','automation','document','other'));
