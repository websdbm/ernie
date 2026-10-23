# Chiarimenti per la pianificazione Todo — 23 ottobre 2026

Aggiornamento backend della skill Todo. Nessuna nuova build iOS: i pulsanti
`present_choices` e le risposte libere sono già supportati dall'app.

## Comportamento

- Prima di assegnare gli slot, distinguere dati certi e dettagli essenziali mancanti.
- Una domanda alla volta: pulsanti per 2–4 alternative concrete, testo libero per
  dati precisi (per esempio la durata di un tragitto). Evitare questionari e richieste
  di informazioni già disponibili.
- Attendere la risposta senza salvare orari ambigui. Una richiesta di salvataggio
  non autorizza a inventare tempi di percorrenza o altri vincoli.
- Riprendere il piano originale anche da una risposta breve; rileggere la lista
  corrente prima di salvarla, mantenendo impegni fissi e identificativi.
- Se l'utente vuole procedere senza un dato, lasciare l'attività senza slot e
  indicare cosa manca. Orari e notifiche restano indipendenti.

Sono istruzioni del pianificatore LLM, non una garanzia deterministica di ogni
conversazione. Il validatore Todo continua a verificare conflitti, dipendenze e
revisioni prima della persistenza.

## Verifica

Biome e `pnpm exec tsc -b` superati. Test catalogo, strumenti Todo e sincronizzazione
promemoria: 20 superati, 2 test di integrazione saltati in assenza del database locale.

`tests/manual/todo-clarifications-smoke.mjs` verifica attraverso il WebSocket reale:
scelta chiusa dell'orario, lista invariata in attesa, domanda aperta sul tragitto,
risposta breve e persistenza degli slot con conservazione degli impegni esistenti.
Usa un account sintetico marcato test, senza dispositivi né promemoria; consuma
crediti LLM reali con budget account di 0,50 USD. Non usa account esistenti.
È uno smoke su staging, non il quality gate su infrastruttura interamente isolata.
Richiede esecuzione nel container API compilato e opt-in
`RUN_TODO_CLARIFICATION_SMOKE=1`. Rimuove l'account al termine.

## Deployment e collaudo effettivo

Sorgente pubblicato su GitHub: `2ba05c8316542a25b79275414fef9d29e0938c21`.
Distribuito su staging3: aggiornato solo `packages/skills/src/catalog.ts`, ricompilati
API e worker, entrambi healthy. Nessuna migrazione o modifica agli account reali.
SHA-256 del file locale/remoto verificato:
`345603b9eef906c946dc6d49d7ab8179e56f95f4c7cc2b832b711e0b50e4b113`.
Immagine API/worker:
`sha256:84d02af9e83304e39914aac9f7526b4f7bbd9bc3b5d029ff199e8094d7d3d510`.
Backup del sorgente precedente e log di compilazione in
`/srv/staging3/backups/ernie/20261023-todo-clarifications`;
immagine precedente conservata come `ernie-app:before-todo-clarifications-20261023`.
Per rollback ripristinare il catalogo salvato, ritaggare l'immagine precedente
`ernie-app:local` e ricreare solo API/worker, senza build o migrazioni.

Smoke reale superato su quattro turni consecutivi:

1. Due opzioni orarie disponibili: una scheda con scelte chiuse, nessun salvataggio.
2. Scelta delle 12:30: meccanico salvato 12:30–13:00, visita medica invariata.
3. Tragitto mancante prima del sopralluogo: domanda aperta, lista ancora invariata.
4. Risposta «20 minuti»: sopralluogo salvato 13:20–13:50 nella stessa lista;
   impegni precedenti conservati, nessun promemoria o lista duplicata.

Account sintetico rimosso; costo registrato del collaudo: 0,283 USD (10 chiamate LLM).
Il test controlla blocchi WebSocket e dati persistiti, non è una prova manuale su iPhone.
La build iOS resta la 100: questa modifica è già disponibile lato backend.
