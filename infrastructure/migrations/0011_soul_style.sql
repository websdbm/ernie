-- Stile delle risposte (richiesta dell'utente, 11 ott 2026): emoji con misura, elenchi per liste e ricette,
-- ricette sempre presentate con il tool `present_recipes` (schede nell'app). Aggiorna il Soul core globale
-- e le copie per utente non bloccate, con una nuova versione tracciata in soul_versions.
WITH upd AS (
  UPDATE souls
     SET content = content || E'\nStile: usa qualche emoji con misura (una o due per risposta, mai dentro dati o elenchi di ingredienti). Per elenchi e ricette usa elenchi puntati o numerati brevi. Quando proponi ricette chiama sempre il tool present_recipes con ingredienti e tempi, e nel testo aggiungi solo un commento breve.',
         current_version = current_version + 1,
         token_estimate = ceil(length(content) / 2.4)::int + 80,
         updated_at = now()
   WHERE key = 'core' AND NOT locked
   RETURNING id, current_version, content, token_estimate
)
INSERT INTO soul_versions (soul_id, version, content, token_estimate, author, reason)
SELECT id, current_version, content, token_estimate, 'seed:0011', 'stile: emoji, elenchi, ricette come schede' FROM upd;
