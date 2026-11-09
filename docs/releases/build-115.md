# Build 115 — Più compiti, meno attese

9 novembre 2026. **Disponibile su TestFlight**, gruppo **Interni**; API pubblicata e sana.
Apple **VALID**, **IN_BETA_TESTING**, Build ID `dcd20e25-2552-4815-9356-7c4b61c4824b`.
Note italiane rilette e identiche al changelog: **1.179 caratteri**.
Sorgenti API `a2f50e5fbbfbb8430093a77c0e9becf2554386cc`. Pubblicazione autorizzata dall’utente il 9 novembre.

## Modifiche

- Fino a tre compiti indipendenti nell'app; precisazioni indirizzate al lavoro corretto e scelte esplicite
  nei casi ambigui. Microfono utilizzabile durante il lavoro, senza cancellarlo; Stop distinto.
- Messaggi da assegnare conservati per account, ripresa delle sessioni e bozze separate. Solo il compito
  visibile parla; notifiche globali ricevute una volta. Cronologia protetta per i compiti in corso.
- Preparazione agente/contesto sovrapposta, caricamenti iniziali condivisi, frammenti di testo raggruppati
  senza ritardare il primo, salvataggi locali fuori dal main thread e rilascio tempestivo del turno.
- Tool `time_windows` per calcolare conflitti e spazi liberi su dati espliciti, senza salvare o notificare.
- Scritture dei tool in coda per account, letture parallele; timeout non ripete scritture con esito incerto.
- Pulsanti/font/spaziature condivisi nelle schede e raccolte, testi completi e compatibilità con temi e
  dimensioni accessibili. Non cambiano permessi, conferme o isolamento del diario e dell'Archivio chat.

Analisi, misure e limiti in [performance e concorrenza](../research/21-performance-concurrency.md).

## Verifiche

- 111 test backend, dieci suite: preparazione, protocollo, stream, annullamento, tool, coda delle scritture,
  calcolo intervalli, autorizzazione e classificazione. TypeScript e Biome verdi.
- 47 test iOS, cinque suite: coordinamento reale dell'app senza rete/account, scelte, tre sessioni,
  risultato in ritardo, messaggi in attesa, separazione voce, cronologia, font e layout accessibili.
  Simulatore Mac Studio «Ernie prova», Xcode 27.0. Anteprime native ispezionate.
- Classificatore reale su quattro casi sintetici: 4/4 corretti, 963–2.348 ms, 33–64 token output,
  zero reasoning; nessun dato personale inviato. Campione puntuale, non garanzia statistica.
- Nessuna migrazione o modifica ai dati degli utenti. Prove HTTPS con account sintetico poi rimosso;
  nessuna notifica o messaggio a terzi.

## Rilascio

Sorgenti della build **`a2f50e5fbbfbb8430093a77c0e9becf2554386cc`**, pubblicati su GitHub e SHA
remoto verificato prima della compilazione. Export Git pulito sul Mac Studio; tutti i **300 input iOS**
identici per SHA-256 alla revisione pubblicata e alla copia effettivamente testata.
Archivio Release ed export riusciti; IPA Apple Distribution, firma deep/strict verificata su app e tre
estensioni, tutti alla 115 e senza accesso debug. Gruppo Keychain privato del diario solo nell'app principale;
changelog nell'IPA identico al sorgente Git. Nessuna modifica al Portachiavi o copia di chiavi private.
IPA **81.897.128 byte**, SHA-256 `a8fce26b323e4c80b566c2396914bce0778b2dd69a901fe8a1ac5661ff441cf5`.

Artefatto e manifest sul Mac Studio:
`~/Library/Caches/ernie-builds/build-115-20261109-performance/` (`export-profile-api/Ernie.ipa`,
`source-sha.txt`, `source-ios-sha256.json`, `ipa-verification.json`). Test e prova LLM sintetica in
`~/Library/Caches/ernie-checks/performance-20261109/`; log nativo finale `native-tests-final-2.log`.
Caricata la stessa IPA verificata: `UPLOAD SUCCEEDED with no errors`, Delivery UUID coincidente
con il Build ID. Disponibilità verificata tramite API Apple, gruppo Interni assegnato automaticamente.
Manifest finale `release-manifest.json`, risposte Apple `asc-build.json`/`asc-notes.json` e log upload
conservati nella cartella della build. Nessuna installazione diretta su telefoni.
Conferma esplicita dell’utente ricevuta il 9 novembre: pubblicare API e build 115.

API aggiornata da Git alla revisione dei sorgenti della build, immagine
`sha256:d3d57a721d5deacbe994f380823681701d7326b30bbd6b5af4d68a343623bfa6`, avvio
`2026-11-09T09:10:29.831188098Z`. Health HTTPS `ok`, container `healthy`; dodici moduli JS compilati
identici per SHA-256 al codice locale testato. Prima del passaggio, prova isolata della nuova immagine
senza rete: calcolo intervalli, raggruppamento testo e validazione destinazioni corretti.
Ricreata soltanto l’API con `--no-deps --no-build`; nessuna migrazione. Identità/immagine/avvio di worker,
Postgres e Redis identici al controllo precedente; `.env` e override verificati invariati tramite hash.
Il health conserva l'etichetta versione preesistente della 106 dal `.env`: usare SHA/immagine per identificare il codice.

Smoke HTTPS con account e chiave temporanei: 401 senza autenticazione, 400 su destinazioni duplicate,
403 con kill switch; tre prompt sintetici classificati correttamente come precisazione (3.354 ms),
nuovo compito (963 ms), dubbio da chiarire (1.058 ms). Tre chiamate registrate, 127 token output,
zero sessioni di chat create. Account e chiave rimossi; resta soltanto l’audit contabile anonimo previsto.
Nessuna conversazione personale letta o modificata e nessun messaggio/notifica inviato nelle prove.

Backup protetto `/srv/staging3/backups/ernie-pre-performance-20261109/checkout`, immagine precedente
`ernie-app:pre-performance-20261109`. Rollback: ritaggare quest'immagine come `ernie-app:local` e ricreare
solo `api` senza build/dipendenze; nessun rollback del database necessario. Log e prove in
`/srv/staging3/checks/performance-20261109/`; copia delle evidenze sull’ufficio in
`~/Library/Caches/ernie-checks/performance-20261109/`.

Le prove su iPhone fisico, durata batteria con tre connessioni, comportamento sotto sospensione iOS e
latenze con rete mobile non sono comprese nei test del simulatore. Non si promette esecuzione continua
dell'app in background; si mantiene il recupero delle richieste esistente.
