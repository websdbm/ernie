# Ricorrenze dei promemoria — 23 ottobre 2026

Il motore delle automazioni supportava già le ricorrenze, ma il tool usato dal
modello esponeva soltanto promemoria singoli e legati a un luogo. Una richiesta
conversazionale di ripetizione poteva quindi ricevere un rifiuto o essere
trasformata in tanti avvisi singoli.

`reminder_create` v2 accetta una ricorrenza giornaliera, settimanale (giorni 0–6)
o mensile (giorno 1–28), con ora e minuto locali. Il server calcola la prossima
occorrenza nel fuso dell'utente e salva un'unica automazione deterministica.
La ricorrenza è restituita anche nell'elenco e nella scheda del promemoria.
Ogni esecuzione della ricorrenza non richiede un nuovo passaggio LLM.

Il parser rapido riconosce anche «ogni mattina tranne il weekend alle 7:55»:
crea una ricorrenza lunedì–venerdì. Un'ora esplicita prevale sul momento generico
della giornata, che non deve finire nel titolo. Le esclusioni non rappresentabili
non vengono eliminate silenziosamente né convertite in un avviso singolo.

## Limiti

- Nessun calendario delle festività, vacanze scolastiche, data iniziale/finale.
  Il modello deve chiarire questi limiti prima di salvare richieste che li includono.
- La ricorrenza temporale non si combina con luogo o preavviso di un appuntamento.
- I promemoria già esistenti non sono migrati automaticamente.
- Nessuna migrazione DB o modifica al contratto iOS: le schede già supportano `repeat`.

## Verifiche e rilascio

- 102 test superati: parser, tool, store, calendario cron e runner.
- TypeScript e controllo Biome sui file modificati superati.
- Verificato il salto del fine settimana durante il cambio dell'ora: da venerdì
  23 ottobre dopo le 07:55, prossima occorrenza lunedì 26 alle 07:55 CET.
- Verifica backend reale e stato di deployment da registrare dopo il rilascio.
