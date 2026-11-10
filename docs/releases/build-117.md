# Build 117 — Maximize

10 novembre 2026. Implementazione autorizzata dall’utente; **build compilata, firmata e verificata**.
**Non ancora distribuita. API non ancora pubblicata.** Nessuna migrazione.

- Skill Maximize spenta inizialmente per account; selettore modello e sforzo sopra la barra di scrittura.
- Scelta per conversazione, conservata localmente; nuovo task/conversazione in Automatico, snapshot nella coda.
- Anthropic diretto e OpenRouter distinti, cataloghi reali, livelli compatibili e tariffe base visibili.
- Override limitato al modello principale; nessun fallback silenzioso. Resta possibile il routing Automatico.
- Skill/controllo genitori rivalidati, SSH solo con modelli avanzati approvati e classe heavy.
- Stime di costo anche per nuovi modelli, output limitato; errore comprensibile per risposta vuota.
- Compatibilità Sonnet 5.5 esplicita con `between_tools`; profili automatici non cambiati.

## Verifiche

Typecheck TypeScript superato; 113 test backend mirati (15 suite), compresi WebSocket/replay,
provider wire-format, revoca, cache e isolamento delle conversazioni. 17 test nativi in quattro suite
(Maximize, aspetto, task concorrenti e indice cronologia), Xcode 27.0 sul Mac Studio. UI nativa renderizzata
in chiaro, scuro e Borg; contrasto delle tariffe corretto dopo ispezione. Nessuna prova su iPhone fisico.

Smoke reale con contenuti sintetici: Fable 5.2/Anthropic e Sol 6.1/OpenRouter chiamano un tool numerico,
eseguono due step e restituiscono 7. Nessuna azione esterna, contenuto personale o modifica runtime.
Catalogo live: 292 opzioni compatibili, di cui quattro dirette Anthropic. Vedere ricerca 23 per confini.

Evidenze temporanee: `/tmp/ernie-maximize-*.log`; Mac Studio
`~/Library/Caches/ernie-checks/maximize-20261110/source/` (test, DerivedData e anteprime simulatore).

## Rilascio

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

**Nessun upload TestFlight o deploy API eseguito.** Pubblicazione API subordinata al via libera previsto
da HANDOFF; pubblicare API e app insieme, senza migrazioni. La skill resta spenta finché l’utente la attiva.
La versione attualmente distribuita resta 116; API a2f50e5. Abitudini/HealthKit/analisi immagini restano aperti.
