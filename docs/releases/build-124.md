# Build 124 — rettifica luoghi e scadenza delle conferme

19 novembre 2026. Pubblicazione e correzione del luogo autorizzate esplicitamente dall’utente e completate:
**API 124 attiva, build 124 disponibile su TestFlight Interni**. Worker 122 invariato, nessuna migrazione.
Nel promemoria segnalato aggiornato il solo luogo, mantenendo lo stesso id, orario e preavviso.

## Diagnosi verificata

La creazione aveva conservato una sede espressa come sola etichetta personale. Sul client quell’etichetta,
anche senza indirizzo risolto, diventava una ricerca Mappe: poteva quindi selezionare un omonimo.
Il punto effettivamente mostrato da Mappe non è nei log; questa spiegazione della zona errata resta
un’inferenza dal percorso verificato nel codice, non un riscontro dei risultati di Mappe.

La successiva rettifica era stata interpretata correttamente: `reminder_update` conteneva l’indirizzo
richiesto e l’id dell’impegno corretto. Il contesto era marcato non fidato; la policy richiedeva una
conferma per quel tool, distinta dal consenso permanente già presente per la creazione. Nessuna
risposta registrata nei due minuti previsti: esito `approval_expired`, zero esecuzioni della modifica.
L’orario dell’appuntamento e il preavviso erano corretti e il promemoria era ancora attivo.
L’indirizzo era intanto stato appreso separatamente dal consolidamento della scheda personale:
questo non provava che la modifica del promemoria fosse stata eseguita.

## Correzione

- L’esito scaduto spiega al modello che è scaduta la conferma, non il promemoria, e che nulla è stato
  modificato. Non riporta soltanto il motivo tecnico della policy. Nessun tentativo automatico.
- La scadenza chiude la richiesta nel database, solo se propria, pendente e già scaduta secondo il DB;
  evento terminale al client. Un errore di registrazione è loggato senza eseguire l’azione.
- La stessa rettifica nello stesso turno condivide conferma ed esito, anche dopo scadenza.
  Un nuovo turno richiede un consenso valido nuovo. Policy, RLS e consensi non vengono aggirati.
- Conferma con nuovo luogo visibile nel riepilogo e indicazione che ora e avvisi restano invariati;
  scadenza visibile nel client. Stato chiuso esplicito «Conferma scaduta · modifica non applicata».
- Le etichette personali senza indirizzo risolto non sono destinazioni Mappe. Il client mostra
  «Indirizzo da precisare»; indirizzi espliciti italiani, CAP/coordinate o indirizzi di luoghi risolti
  restano apribili. Non è una verifica esterna di geocodifica o correttezza del punto.

## Verifiche

- Riproduzione prima del fix: fallivano riepilogo del luogo e spiegazione/evento della scadenza.
- **66 test backend passati**: rettifica approvata una volta sola, scadenza senza scritture o nuove
  conferme ripetute, conservazione id/orari/preavviso/job, policy e attacchi, coda mutazioni, API REST.
- PostgreSQL reale temporaneo `127.0.0.1:62205/ernie`, ruolo applicativo e RLS: scadenza solo dopo
  deadline, isolamento account, approvazioni valide e già consumate non alterate. Tabelle dalle
  migrazioni 0002/0003/0004/0006, nessun dato di produzione. Fixture eliminate a fine test.
- **24 test iOS passati**, build simulatore 124, chiaro/scuro/Borg, caratteri grandi e 320 punti;
  controllo visivo della nuova scheda di scadenza. Risultati
  `/tmp/ernie-reminder-correction-final-20261119.xcresult` e relativo log.
- TypeScript/Biome e controllo diff. Nessuna chiamata LLM/APNs reale nei test.

## Distribuzione

Numero 124 e changelog nei quattro bundle. Sorgenti pubblicati e SHA remoto verificato:
**`35c073efa39e03cbcf07224feb463eea327cdbba`**. Compilazione per distribuzione da checkout pulito
`/tmp/ernie-build124-20261119-source`, 321 input iOS confrontati nel manifest privato.
Archivio ed export completati sul Mac ufficio con Xcode 27.2. Verificati quattro bundle 124 firmati
Apple Distribution, profili validi, APNs production, gruppi condivisi coerenti con i sorgenti e Diario
privato solo nell’app principale. IPA **83.108.466 byte**, SHA-256
**`1ea5afd146590c5ceaeef9e68ce8f3e4db65029618e6ac270a7bbb9211838f2f`**.
Artefatti/manifest privati ufficio in
`~/Library/Caches/ernie-builds/build-124-20261119-reminder-correction/`.
Stessa IPA trasferita sul Mac Studio con confronto SHA-256 prima del caricamento. Upload riuscito
senza errori usando la chiave Apple già presente, nessun trasferimento di credenziali. Build/delivery ID
**`0f2dc962-7dad-4ea0-b898-2a2bbace1e5f`**, Apple **VALID / IN_BETA_TESTING**, presenza della 124 nel gruppo
esistente **Interni** verificata. Note italiane salvate e rilette identiche: **908 caratteri**.
Manifest e ricevute privati aggiornati su entrambi i Mac. Non ricaricare la build.

API pubblicata da git sul commit sopra, immagine
`sha256:c22fb385835d8f947cc0da24134bcac42337a03a504dbc45cd3173af2a79822c`.
Backup protetto filesystem/configurazioni e dump PostgreSQL con indice verificato:
`/srv/staging3/backups/ernie-pre-124-20261119.Qg4sDQ/`. Worker 122 (`32bec54e…`), PostgreSQL, Redis,
`.env` e override invariati; nessuna migrazione, schema 0055. Health/ready HTTPS passati.
Il vecchio valore della versione in health deriva dall’ambiente preservato: identificazione del rilascio
mediante commit, immagine e hash di cinque moduli compilati, identici ai file locali testati.

Nove controlli sul codice compilato distribuito: scadenza spiegata, zero scritture senza conferma,
nuovo luogo visibile, scadenza nel DB/evento client, deduplica nello stesso turno, isolamento account,
nuova conferma valida, scrittura nello scope autenticato e orari conservati con una sola esecuzione.
PostgreSQL/RLS reali, archivio promemoria sintetico in memoria; fixture utente/approvazioni rimosse.
Zero chiamate LLM o push reali. Riscontro protetto `runtime-smoke.json` nella cartella del backup.

Dopo il backup, correzione autorizzata del solo `meta.location` del promemoria segnalato, nello scope
applicativo dell’account e con lock/verifica dello stato precedente. Salvati prima/dopo nel backup
protetto `reminder-correction.ndjson`, esclusi da Git. Confronto di tutti gli altri campi e rilettura
attraverso il servizio promemoria compilato: stesso id, un solo impegno attivo, appuntamento/preavviso,
trigger, canali e job invariati. Nessuna modifica ai luoghi o agli altri promemoria.
Ricezione della push e interazione con la nuova UI su iPhone reale ancora da provare dopo aggiornamento.
