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

Deployment e risultato dello smoke saranno registrati dopo la verifica live.
