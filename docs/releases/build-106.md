# Build 106 — Luogo, link e note negli appuntamenti

26 ottobre 2026. Preparata; distribuzione da verificare dopo compilazione e caricamento.

## Funzionamento

- `location` (indirizzo o etichetta di un luogo), `url` (http/https completo, fino a 2000 caratteri),
  `notes` (testo, fino a 4000 caratteri) facoltativi. La sede non cambia il trigger dell’avviso.
- Campi conservati nei metadati delle automazioni: nessuna migrazione necessaria. La lettura dei vecchi
  promemoria resta compatibile. Un’etichetta nota nella scheda risolve anche l’indirizzo per Mappe.
- `reminder_create` v3, `reminder_list`, nuovo `reminder_update`, blocchi chat e REST condividono il contratto.
  Le richieste con URL, indirizzi o note passano dal modello per l’estrazione strutturata.
- Omettere un campo lo conserva; `null` lo cancella. La sola modifica dei dettagli mantiene id, job e orario.
  Testo/orario continuano a usare il percorso di sostituzione esistente, preservando i dettagli.
- App: matita nella scheda chat o in Promemoria; luogo apribile in Mappe, link apribile e note espandibili.
  Dettagli inclusi anche nelle email se questo canale è stato scelto.
- Ernie chiede solo i dettagli necessari o ambigui e può completarli in seguito. Nessuna informazione inventata.

## Verifiche

Compilazione TypeScript completa e 189 test backend/protocollo/tool/routing superati sulla base aggiornata
alla build 105. Nove test nativi di contratto e anteprima superati: compatibilità, URL e PATCH con cancellazione esplicita.
Anteprime a 320 pt in tema chiaro e scuro renderizzate e ispezionate.
Deployment, commit e distribuzione riportati a completamento del rilascio.
