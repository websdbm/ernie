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
- Due prove reali WebSocket sul servizio pubblico: una formulazione conversazionale
  passa dal modello e da `reminder_create`, una breve usa il parser deterministico.
  Entrambe creano esattamente un record cron `55 7 * * 1,2,3,4,5`, restituiscono la
  scheda con ricorrenza e sono cancellabili solo dal proprietario. Fixture eliminate.
- Costo registrato della verifica completa: 0,134 USD; nessun avviso inviato a utenti reali.
- Backend pubblicato il 23 ottobre 2026: `0.1.0-reminder-repeat-20261023.1`,
  API healthy e worker running, PostgreSQL/Redis ready. Verificati gli hash dei
  24 file compilati distribuiti. Sorgenti GitHub:
  `4870a86dc82f2cded13667bfcf13b63a222fb831`.
- Immagine API/worker:
  `sha256:9930493d4b02ac372673b00d38fedc15f2e7707986b5539fa9faa51bf923c9aa`.
- Backup verificato di DB, vault, sorgenti e configurazione in
  `/srv/staging3/backups/ernie/20261023-reminder-repeat/`.
  Rollback: immagine `ernie-app:before-reminder-20261023`, sorgenti/configurazione
  dal backup; nessuna migrazione dati. Non ripristinare il DB sullo stato corrente
  senza prima preservare i dati creati successivamente.
- Evidenze locali: `/tmp/ernie-reminder-20261023/`. La prima connessione del client
  di test non ha completato l'handshake; entrambe le prove successive sono riuscite
  usando IPv4 esplicito. Nessuna modifica di rete applicata al servizio.
- La skin Terminale è distribuita separatamente nella [build 97](../releases/build-97.md).
