# Build 117 — Maximize e promemoria compatti

10 novembre 2026. **Pubblicazione API e build 117 autorizzata dall’utente**. Prima dell’upload richiesti anche
i comandi compatti sui promemoria: ricompilazione in corso, prima IPA non distribuita.
**Non ancora distribuita. API non ancora pubblicata.** Nessuna migrazione.

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

**Nessun upload TestFlight o deploy API ancora eseguito.** Via libera ricevuto dall’utente; pubblicare la
revisione comprensiva dei nuovi comandi sui promemoria, senza migrazioni. La skill resta spenta finché l’utente la attiva.
La versione attualmente distribuita resta 116; API a2f50e5. Abitudini/HealthKit/analisi immagini restano aperti.
