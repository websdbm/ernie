# Build 123 — Abitudini: luoghi, domande e notifiche

19 novembre 2026. Pubblicazione autorizzata dall’utente e completata: **API 123 attiva e build 123
disponibile su TestFlight, gruppo Interni**. Nessuna correzione dei dati personali durante la diagnosi,
nessun invio di prova all’utente.

## Problema e correzione

Le schede di luoghi diversi avevano tutte lo stesso titolo generico. Il questionario sceglieva la prima
scheda storica ancora disponibile e chiedeva «qui» senza riferirsi alla data della visita. Una descrizione
salvata senza rinominare la scheda lasciava intatto il titolo segnaposto. La verifica in sola lettura
sull’account interessato ha confermato luoghi distinti e una descrizione salvata; la corrispondenza tra
quella descrizione e il luogo storico resta da confermare con l’utente. Nessun accorpamento automatico.

- Elenco ordinato per ultima sosta, data/ora e conteggio; per le vecchie schede confermate senza nome,
  descrizione fornita dalla persona al posto del segnaposto. Nuove modifiche richiedono un nome utile.
- Domande sulle osservazioni più recenti tra quelle eleggibili, con data e ora esplicite della visita.
  Non presentano una sosta storica come posizione attuale; il riferimento resta quello originale.
- Domanda aperta recuperabile dal server dopo riavvio/cambio processo, senza generare un altro avviso.
- Voce inbox generica creata nella stessa transazione della domanda, poi push APNs ed evento live.
  Nessuna posizione o descrizione nel testo della notifica. Tocco → Abitudini, anche dalla scheda inbox.
- Controllo sul server ogni cinque minuti anche ad app chiusa, senza LLM. Inferenza delle routine ancora
  al massimo una volta al giorno. Una sola domanda aperta, massimo una nuova domanda al giorno,
  rispetto delle ore di quiete, dei limiti globali e degli interruttori per account.
- Push senza ripetizione automatica dopo consegna incerta; in caso di errore resta la domanda/inbox
  sul server. La ricezione reale dipende da APNs e dalle autorizzazioni notifiche dell’iPhone.

## Verifiche

- TypeScript/Biome e controllo diff passati.
- **61 test backend passati**: modello, chat, PostgreSQL reale isolato con RLS, notifiche atomiche,
  letture concorrenti/riavvio, inferenza giornaliera, quiet hours/kill switch, regressioni proattività e
  connessioni manuali Raindrop. Fixture sintetiche, database locale dedicato `127.0.0.1:62204/ernie`.
- **38 test iOS passati** su iPhone 17 simulato iOS 27.2: Abitudini, notifiche/link, widget e rendering
  chiaro/scuro con caratteri grandi. Risultati `/tmp/ernie-habits-questions-final-20261119.xcresult`.
- Test prima della correzione: selezione della sosta più recente falliva; stessa regressione poi passata.
- Anteprime delle righe con soli dati sintetici `habits-places-light.png` / `habits-places-dark.png` nel
  contenitore temporaneo del simulatore. Nessuna chiamata LLM o APNs reale nei test.

## Rilascio

Build 123 nei quattro bundle, changelog e progetto versionati prima dell’archiviazione. Compilazione
per distribuzione dal commit GitHub verificato **`4f3ccbe5882d0339d2531a15317b304fa5e81d66`**, con 321
input iOS confrontati nel manifest privato. Checkout pulito `/tmp/ernie-build123-20261119-source`.
Archivio ed export completati sul Mac ufficio con Xcode 27.2. Verificati tutti e quattro i bundle 123,
Apple Distribution, profili validi, APNs production e gruppo Diario privato solo nell’app principale.
IPA **83.102.520 byte**, SHA-256 **`0f75bc1db48725188f3a40c4bc69d86056959d22bde8be543d7b4274dc1f51bf`**.
Stessa IPA trasferita sul Mac Studio con confronto hash; upload tramite chiave API Apple già presente
sul Mac Studio, senza trasferire credenziali. Upload riuscito senza errori; build/delivery ID
**`ecd64a17-edcd-41fc-a303-089f2a18bcb6`**, Apple **VALID / IN_BETA_TESTING**, accesso nel gruppo
esistente **Interni** verificato. Note italiane salvate e rilette identiche: **1.017 caratteri**.
Artefatti, log e manifest privati su entrambi i Mac in
`~/Library/Caches/ernie-builds/build-123-20261119-habits/`. Non eseguire un altro upload della 123.

API pubblicata da git sullo stesso commit, immagine
`sha256:a69ca661a431b26eac5cdf9a3167358335da0af48e1c822d48d87e1e7dc064e3`.
Backup filesystem/configurazioni e dump PostgreSQL verificati:
`/srv/staging3/backups/ernie-pre-123-20261119.Vpzgcu/`. Health/ready OK. Worker 122, PostgreSQL, Redis,
`.env` e override invariati; nessuna migrazione (schema 0055). Cinque moduli distribuiti corrispondono
agli hash dei moduli testati. Nove verifiche sul runtime reale compilato con fixture sintetiche:
luoghi distinti, una notifica con letture concorrenti, data storica esplicita, domanda recuperata dopo
riavvio, notifica senza posizione, isolamento account, chiusura dopo risposta, cifratura e skill spenta.
Fixture rimosse, zero chiamate LLM/provider e zero push reali durante lo smoke.

APNs configurato sul server; ricezione e apertura della nuova notifica da verificare sull’iPhone reale.
La nuova API comprende il codice OAuth Raindrop, ma i parametri OAuth non sono configurati: il pulsante
resta nascosto, token manuali preservati. Login OAuth reale non verificato né dichiarato operativo.
L’associazione personale segnalata resta in attesa di conferma dell’utente; nessuna fusione automatica.
