# Build 106 — Appuntamenti completi e liste più ordinate

26 ottobre 2026 (Codex, Mac dell'ufficio): appuntamenti con luogo, link e note. 27 ottobre 2026 (Claude Code, Mac
Studio): pannello delle liste e giornate archiviate aggiunti alla stessa build, non ancora caricata.

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

## Pannello laterale e giornate passate (27 ott)

Richiesta dell'utente: le liste nel pannello erano troppo verbose, spesa e attività mescolate, giornate passate
ancora in vista.

- `ListShortcutsSection`: due gruppi, «Spesa» e «Attività», una riga per lista (nome troncato, a destra quante
  voci restano e il giorno breve: «oggi», «domani», «ven», «23 ott»); tre righe per gruppo con «Mostra tutte».
  Liste della spesa archiviate fuori dal pannello.
- `TodoTime.isArchived`: una lista con giorno è archiviata quando nel suo fuso è iniziato il giorno dopo; le liste
  senza giorno non scadono. Fuori dal pannello e in «Archiviate» (chiuso) nella pagina Attività. Calcolato
  nell'app, nessun dato modificato.
- Server (già pubblicato il 27 ott, `5abd040`): «aggiungi alla lista … <voci>» non aggiunge più la voce «alla».

## Verifiche

Compilazione TypeScript completa e 189 test backend/protocollo/tool/routing superati sulla base aggiornata
alla build 105. Nove test nativi di contratto e anteprima superati: compatibilità, URL e PATCH con cancellazione esplicita.
Anteprime a 320 pt in tema chiaro e scuro renderizzate e ispezionate.
Deployment, commit e distribuzione riportati a completamento del rilascio.

Verifiche del 27 ott (Mac Studio, codice unito delle due parti): suite completa dell'app 295 test, 294 verdi;
`TerminalChatTests.focusProgrammaticoECambioSkinNellaBarraCompleta` (instabile noto) passa con la sua suite.
Test nuovo `giornataPassataNelSuoFusoEArchiviataEGiornoBreve`; anteprima del pannello disegnata e controllata.
Server: 823 test unitari verdi; nessun errore nei log dopo la pubblicazione di `72a027e`, che include anche la
parte server degli appuntamenti.
