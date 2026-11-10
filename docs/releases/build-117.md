# Build 117 — Maximize e promemoria compatti

10 novembre 2026. **Pubblicazione API e build 117 autorizzata dall’utente**. Inclusi anche i comandi compatti
sui promemoria e la voce 15% più rapida richiesti prima dell’upload. **API pubblicata e sana; build disponibile
su TestFlight**, gruppo Interni, **VALID / IN_BETA_TESTING**. Nessuna migrazione.

- Promemoria: Modifica solo nel menu; Sveglia/Email azionabili direttamente, icone senza label e stato tramite
  colore e pieno/vuoto, aree 44 pt, VoiceOver conservato. Giorno non duplicato; stessa scheda in chat/raccolta.
- Voce Drama 15% più rapida nel backend, con `atempo=1.15` prima del compressore/normalizzazione già presenti.
  Registro, prompt, modello e volume obiettivo invariati; nessun costo AI aggiuntivo e nessuna doppia accelerazione iOS.
  Vale anche per le app già installate; il ripiego vocale di iOS resta invariato.
- Skill Maximize spenta inizialmente per account; selettore modello e sforzo sopra la barra di scrittura.
- Scelta per conversazione, conservata localmente; nuovo task/conversazione in Automatico, snapshot nella coda.
- Anthropic diretto e OpenRouter distinti, cataloghi reali, livelli compatibili e tariffe base visibili.
- Override limitato al modello principale; nessun fallback silenzioso. Resta possibile il routing Automatico.
- Skill/controllo genitori rivalidati, SSH solo con modelli avanzati approvati e classe heavy.
- Stime di costo anche per nuovi modelli, output limitato; errore comprensibile per risposta vuota.
- Compatibilità Sonnet 5.5 esplicita con `between_tools`; profili automatici non cambiati.

## Verifiche

Typecheck TypeScript superato; 113 test backend mirati (15 suite), compresi WebSocket/replay,
provider wire-format, revoca, cache e isolamento delle conversazioni. **35 test nativi in sette suite**
(Maximize, aspetto, task concorrenti, indice cronologia, promemoria, protocollo e stili), Xcode 27.0 sul Mac Studio.
UI nativa renderizzata in chiaro, scuro e Borg; contrasto delle tariffe corretto dopo ispezione. Verificati anche
canali attivi/spenti, menu, ricorrenze, famiglia, luoghi e caratteri accessibili. Nessuna prova su iPhone fisico.

Smoke reale con contenuti sintetici: Fable 5.2/Anthropic e Sol 6.1/OpenRouter chiamano un tool numerico,
eseguono due step e restituiscono 7. Nessuna azione esterna, contenuto personale o modifica runtime.
Catalogo live: 292 opzioni compatibili, di cui quattro dirette Anthropic. Vedere ricerca 23 per confini.

Evidenze temporanee: `/tmp/ernie-maximize-*.log`; Mac Studio
`~/Library/Caches/ernie-checks/maximize-20261110/source/` (test, DerivedData e anteprime simulatore).
Verifica finale dei sorgenti iOS: `~/Library/Caches/ernie-checks/reminder-controls-20261110/`,
35 test superati e anteprime in `ernie-reminder-cards-117`.

Voce: altri **12 test backend** superati, compresi tre con FFmpeg reale su audio sintetico (vocale armonico,
livelli deboli/forti, frasi corte, silenzio, annullamento ed errori). La regressione sulla durata fallisce sul
codice precedente e passa con la nuova accelerazione; frequenza conservata entro 2 Hz, picchi sotto 0,98,
livello medio tra -16 e -11 dBFS. TypeScript e Biome superati. Riferimento del filtro:
[documentazione FFmpeg](https://www.ffmpeg.org/ffmpeg-filters.html#atempo).

## Prima compilazione, superata prima della distribuzione

Sorgenti **`6db4934de2c09d8ba8899de9850c37c6f6a47ed5`**, pubblicati e verificati su GitHub prima
dell’archivio. Export Git pulito sul Mac Studio: **304 input iOS** identici al commit e ai sorgenti dei test.
Archivio Release senza firma, copia preparata con lo script versionato e i profili validi della 116;
export locale con firma Apple gestita tramite API. Tutte e quattro le firme **Apple Distribution** verificate
con codesign deep/strict; build 117, `get-task-allow=false`, entitlement conformi ai sorgenti e gruppo privato
del diario soltanto nell’app principale. Changelog nell’IPA identico a Git.

IPA **82.024.723 byte**, SHA-256
`6533a80dd766d5b253208034ea4c715707c3149663009fcc74568961d33a1ffc`.
Artefatti sul Mac Studio: `~/Library/Caches/ernie-builds/build-117-20261110-maximize/`:
`source/`, `source-sha.txt`, `ios-inputs.json`, archivi unsigned/profile, `export-profile-api/Ernie.ipa`,
`release-manifest.json`, log archive/export, lettura ASC precedente al rilascio (116 e 115 VALID).
Nessuna chiave privata copiata e nessuna modifica al Portachiavi.

Questa prima IPA non è stata caricata. La skill resta spenta finché l’utente la attiva.
Abitudini/HealthKit/analisi immagini restano aperti.

## Compilazione finale e API pubblicata

Sorgenti definitivi **`6b5a9bb54f53b17c1ad28d849c563fa879d17ae5`**, pubblicati su GitHub e SHA remoto verificato
prima dell’archivio. Include UI promemoria (`a17ddd1`) e accelerazione voce. **304 input iOS** identici a Git;
303 identici ai test nativi, soltanto il changelog aggiunge la voce audio e viene validato separatamente.
Archivio ed export Apple riusciti sul Mac Studio: quattro firme Apple Distribution verificate, build 117,
entitlement conformi, isolamento diario conservato e changelog dell’IPA identico ai sorgenti.

IPA finale **82.026.171 byte**, SHA-256
`b5ce6b1194e431fae320730891498ca220b213c6fcfe04dab2112312a3521354`.
Artefatti: `~/Library/Caches/ernie-builds/build-117-20261110-maximize-compact/`; manifest, sorgenti, hash,
archivi, IPA verificata e log. Nessuna chiave privata copiata, nessuna modifica al Portachiavi.
Accessi SSH esistenti riusciti su Mac Studio (alessandro, 100.103.139.85) e staging3 (root, 100.91.204.102),
solo tramite Tailscale; nessuna nuova chiave installata o porta pubblica aperta.

API dal medesimo commit Git, immagine
`sha256:b4101522cdb1b1027700ad6e7904493d289521a48c9d6fccd8a7f4786f51f793`.
Container healthy, health HTTPS `ok`; 14 moduli JS identici alla compilazione locale testata. Nessun errore nei
log dopo il rilascio. Solo API ricreata; worker/Postgres/Redis e hash delle configurazioni invariati.
Backup `/srv/staging3/backups/ernie-pre-maximize-20261110/`, recupero immagine `ernie-app:pre-maximize-20261110`.

Smoke HTTPS con account/chiave temporanei sintetici, poi eliminati: 401 senza autenticazione, skill spenta
inizialmente, catalogo live con 292 modelli (quattro Anthropic diretti), revoca/kill switch/controllo genitori,
403 senza scope chat. Zero chiamate LLM e zero conversazioni create; account reali invariati.
Nel container FFmpeg prova sintetica positiva: 4,049 s → 3,553 s (padding MP3 incluso), frequenza
169,91 → 170,02 Hz, uscita -12,53 dBFS, picco 0,294. Accelerazione nel server, senza moltiplicarla nel client.
Evidenze locali: `/tmp/ernie117-http-smoke-result.json`, `/tmp/ernie117-runtime-audio-result.json`.

## Distribuzione verificata

Caricata soltanto l’IPA finale verificata (82.026.171 byte), senza errori. Apple **VALID / IN_BETA_TESTING**,
gruppo **Interni**; Build ID **`e2b157be-606b-46c2-b3fc-19a8fbbdb974`**. Note italiane pubblicate e rilette:
**1.739 caratteri**, identiche al changelog Git. Hash IPA ricontrollato dopo l’upload e invariato.
`release-manifest.json`, `asc-current.json`, `asc-localizations.json`, `whats-new-result.json` e `upload.log`
conservano le verifiche sul Mac Studio. Nessuna installazione diretta sul telefono.
