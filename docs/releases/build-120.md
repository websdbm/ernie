# Build 120 — Abitudini (firmata, non pubblicata)

10 novembre 2026. **Non pubblicata**. API e migrazione 0054 ancora da attivare; TestFlight resta 119.
La skill è inizialmente spenta e richiede consenso esplicito anche su ciascun iPhone.

## Contenuto

Visite approssimative Core Location, coda locale cifrata, archivio personale cifrato nel backend,
retention, pausa, cancellazione/esclusioni, luoghi confermati e routine inferite separati. Pannello dedicato,
invito discreto in chat entro budget proattivo; consenso AI distinto, revocabile, contesto pertinente limitato.
Nessuna integrazione Apple Salute in questa build; nessun reminder creato dalle routine inferite.

Copilot lavora su copie isolate dei soli sorgenti; Codex integra e verifica le modifiche. Nessuna chiave,
configurazione privata o cronologia personale condivisa con i revisori. Vedi [ricerca 28](../research/28-habits-implementation.md).

## Verifiche completate

124 test backend in nove suite (39 Abitudini), TypeScript e Biome; 46 test iOS in due suite
Abitudini/Lifecycle con Xcode 27.2. Render chiaro/scuro con testo accessibile verificato anche visivamente.
I dati dei test sono sintetici, PostgreSQL/Redis temporanei locali. Copilot ha implementato due revisioni
su copie isolate; Codex ha corretto compilazione e integrazione dell’avvio background.

## Archivio e firma verificati

- Commit sorgenti pubblicato e SHA remoto verificato: `62f097c17f52fef696d98e4e685b56b655336544`.
- Archivio Release senza firma compilato con Xcode 27.2 sul Mac dell’ufficio da worktree pulita
  `/tmp/ernie-build120/source`; 318 input iOS verificati SHA-256 sul Mac Studio.
- Archivio trasferito con hash `6e4782df9464c8ccda2cfe4c039b0e3221b74f4f7bfdaa4c5c9401b69413a35f`.
- Export Apple automatico Xcode 27.0 sul Mac Studio, senza sblocco Portachiavi né copia di chiavi private.
  IPA 82.870.043 byte, SHA-256 `a029f453efcf2eb09fed842115ba3d6221bfbfe95547749a47f41366bf988fa6`.
- Quattro bundle tutti 120, firma Apple Distribution verificata, `get-task-allow=false`,
  entitlement/profili corrispondenti, gruppo privato del diario solo nell’app, APNs production,
  descrizione permesso posizione Sempre e changelog incorporati e verificati.
- Artefatti e manifest privati: Mac Studio `~/Library/Caches/ernie-builds/build-120-20261110-habits/`,
  `release-manifest.json`, `source-inputs.json`, `export/Ernie.ipa`. Non in Git.
- **Nessun upload TestFlight, deployment o scrittura DB di produzione eseguiti**.

## Passi di rilascio ancora da completare

- Backup aggiornato server, chiave HABITS_ENCRYPTION_KEYS separata da Salute e copia privata di recupero,
  migrazione 0054 e runtime dal Git pubblicato, smoke sintetico cifratura/revoca/isolamento.
- Pubblicazione e scritture in produzione soltanto dopo il via libera esplicito richiesto da HANDOFF.

## Prova su iPhone

L'iPhone del titolare risulta collegato al Mac dell'ufficio; al primo controllo aveva la 118 e l'utente
ha completato l’aggiornamento alla 119, riletta dal dispositivo. Non installare una build precedente. L'ultima build TestFlight riletta da Apple è 119/VALID.
Dopo installazione della build nuova e attivazione backend:

1. Skill spenta: nessuna raccolta; attivare skill non equivale al consenso sul dispositivo.
2. Abilitare esplicitamente questo iPhone; verificare i prompt iOS e il caso precisione ridotta.
3. Eseguire una sosta reale, uscire e rientrare nell'app: orari approssimativi, niente visite duplicate.
4. Pausa locale e revoca del permesso di posizione: nessuna nuova acquisizione o invio; storico consultabile.
5. Offline, chiusura e riavvio: ripresa soltanto con consenso locale valido; lease scade dopo 24 ore.
6. Cambiare account e cancellare: nessun trasferimento o riapparizione delle visite del vecchio account.
7. Osservare il consumo energetico su un intervallo significativo: non attestabile da un test breve.

Il sistema operativo decide quando consegnare le visite; non promettere tracciamento continuo,
aggiornamento istantaneo o garanzia di risveglio dopo chiusura forzata. La verifica automatica non
sostituisce queste prove. La cifratura backend non è end-to-end.
