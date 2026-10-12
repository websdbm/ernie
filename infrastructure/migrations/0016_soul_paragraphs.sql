-- Leggibilità (richiesta dell'utente, 12 ott 2026): niente «muri di testo». Risposte brevi per impostazione;
-- quando serve una risposta lunga, capoversi di due o tre frasi separati da una riga vuota, elenchi quando
-- ci sono più punti. Aggiorna il Soul core globale e le copie per utente non bloccate (nuova versione tracciata).
WITH upd AS (
  UPDATE souls
     SET content = content || E'\nImpaginazione: rispondi in modo breve quando basta. Se la risposta deve essere lunga, dividila in capoversi di due o tre frasi separati da una riga vuota, mai un unico blocco; usa un elenco quando ci sono più punti distinti.',
         current_version = current_version + 1,
         token_estimate = ceil(length(content) / 2.4)::int + 60,
         updated_at = now()
   WHERE key = 'core' AND NOT locked
   RETURNING id, current_version, content, token_estimate
)
INSERT INTO soul_versions (soul_id, version, content, token_estimate, author, reason)
SELECT id, current_version, content, token_estimate, 'seed:0016', 'impaginazione: capoversi brevi nelle risposte lunghe' FROM upd;
