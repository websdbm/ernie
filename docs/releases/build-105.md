# Build 105 — Precisazioni e messaggi riusabili

25 ottobre 2026. **Caricata su TestFlight** dal Mac Studio («Cosa testare» scritto dalle novità) e **installata ad
hoc sull'iPhone di Giorgio** (verificata: Bundle Version 105). Server: pubblicazione approvata dall'utente ma non
ancora eseguita (bloccata dal controllo dei permessi, in attesa di conferma esplicita); fino ad allora l'app 105 usa il
server v1.9 e le precisazioni ripiegano sulla coda.

## Contenuto

- **Precisazione durante la risposta** (richiesta dell'utente del 25 ott, scelta «entra senza fermare»): un testo
  scritto o dettato mentre Ernie risponde parte come `user.steer` legato al `correlationId` del turno in corso. Il
  server lo accoda (al massimo 5) e lo inserisce come messaggio dell'utente al passo successivo del modello
  (`prepareStep` di Mastra), poi risponde `assistant.steer` `applied`; se il turno non ha più passi risponde `late` e
  l'app lo manda come messaggio nuovo a turno finito. Etichetta nel fumetto («precisazione», «inviata dopo»). Solo
  testo senza allegati e solo con un server alla v1.10; altrimenti coda come prima.
- **Messaggi vecchi**: tocco lungo su un proprio messaggio → «Rimanda», «Modifica e rimanda» (testo nel campo di
  scrittura), «Copia».
- **Diario**: apertura senza rete, eliminazione di una pagina e dell'intero diario con conferma, dettatura che non
  cancella il testo, Writing Tools spenti, lettura e scritture fuori dal main, bozza cifrata.
- **Prestazioni**: storico del pannello letto in background da un indice, foto ridotte con `CGImageSource` fuori dal
  main, rapporti MetricKit passati serializzati in background, widget legati all'account, `LegacyTranscriber` sotto
  lock.

## Backend da pubblicare insieme

Protocollo v1.10; migrazioni **0047** (coda delle risorse Brain con tentativi e attesa crescente, riaccodamento
mirato) e **0048** (recupero dei promemoria Todo con attesa per le liste in errore). SSH: rete Tailscale solo al
titolare, blocklist, timeout DNS, limiti di frequenza e porte, revoche a skill spenta, rotte di cancellazione, esiti
non persi, `--allow-root`. Luoghi delle foto con titolo neutro, un solo livello di retry verso i modelli, YouTube
rifiutato con durata sconosciuta, coda `turn-memory` a scadenza, budget nel giorno di Roma e le altre voci elencate
in [HANDOFF](../HANDOFF.md).

## Verifiche

- Server: typecheck, lint (27 avvisi preesistenti), 944 test con integrazione su Postgres e Redis reali (ruolo
  `ernie_app`, migrazioni fino alla 0048): tutti verdi. Precisazione provata con il modello vero su API locale con un
  utente di prova: arrivata dopo `web_search`, `applied`, risposta adeguata.
- App: 291 test, 290 verdi nella suite completa; `chiudereIlMicrofonoDisattivaAncheLElaborazioneCheAttenuaIlPlayer`
  è andato in crash per un blocco del servizio audio del simulatore («AURemoteIO: RPC timeout») e rilanciato con la
  sua suite passa. `avvioRealeMicrofonoRiceveBufferEFermaSenzaCrash` escluso come nella 104.

## Tracciabilità

- Commit dei sorgenti `ab4c1dd`, pubblicato e verificato su GitHub `main` prima dell'archiviazione; archiviato dal
  checkout pulito del Mac Studio con `CURRENT_PROJECT_VERSION=105` (anche in `project.yml`, quattro target).
- iPhone di Giorgio: pacchetto ad hoc dallo stesso commit (SHA-256
  `c5433b48930dced21b09f31d0a7dc217f01a97eb58934da891760cc4968c4481`), installato via devicectl il 25 ott.

Il commit della documentazione finale non modifica i sorgenti della build.
