# Build 120 — Abitudini

10 novembre 2026. **API/worker pubblicati e verificati, migrazione 0054 applicata** dopo autorizzazione
esplicita dell’utente. Build 120 caricata su TestFlight; elaborazione e disponibilità ancora da verificare.
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
- Pubblicazione autorizzata dall’utente dopo firma e verifiche.

## Backend pubblicato e verificato

Checkout server da Git `1e4092339a7d45eff4d82ed4b91139935d431ff1` (sorgenti applicativi `62f097c`),
immagine API/worker `sha256:f533f499e3132b561f8a3eb802056ba3bbf9e60cd01f6d1ce96e5b5f7a835c18`.
Otto moduli compilati identici per SHA-256 a quelli dei test. Migrazione 0054 applicata, 53 precedenti
riconosciute; API/worker sani, health/ready HTTPS verdi. Postgres e Redis non ricreati.

Backup progetto/configurazione e dump preliminare/cutover con indice pg_restore verificato in
`/srv/staging3/backups/ernie-pre-120-20261110/`. Chiave HABITS_ENCRYPTION_KEYS casuale dedicata,
copia riservata `/srv/staging3/secrets/ernie-habits/keyring-20261110-v1.json` e recupero sul Mac ufficio
fuori Git, checksum corrispondenti senza esposizione del segreto. Configurazione precedente preservata,
sola aggiunta della chiave; override invariato. Nessuna prova integrale di ripristino del backup.

Smoke HTTPS nel runtime reale: autenticazione, default spento, attivazione esplicita, deduplica,
archivio senza coordinate/etichette in chiaro, RLS forzata tra due account, consenso AI versionato e
revocabile, contesto privo di coordinate/storico grezzo, rifiuto vecchi epoch dopo disattivazione,
cancellazione e retry con ID sconosciuto. Zero chiamate LLM/SSH/provider e zero scritture Brain/documenti/Media.
Account sintetici/API key/dati rimossi. Nessun contenuto privato delle fixture nei log né errori API/worker.
Evidenze `runtime-smoke.json`, `migration-0054.log`, `containers-before.txt`, `containers-after.txt` nel backup,
copia locale `/tmp/ernie120-runtime-smoke-result.json`. Nessun consenso attivato agli account esistenti.

## TestFlight

Upload riuscito senza errori, ricevuta `2e08b05d-86cb-4919-9278-2c2ec8903e65`, 82.870.043 byte.
Stato Apple e gruppo Interni da rileggere prima di dichiarare disponibile la build.
Controllo avviato sul Mac Studio (`release-watcher.mjs`, massimo 40 tentativi ogni 25 s): solo dopo
VALID scrive/rilegge note italiane, assegna il gruppo Interni esistente e verifica entrambi. Esiti in
`release-watcher-result.json`, `asc-final.json`, `release-manifest.json`; non ripete upload e non aggiunge tester.
Ultima lettura in sessione: `processing_pending`, build ancora assente dalla lista Apple. Non confondere
la ricevuta di upload con disponibilità TestFlight. Alla ripresa leggere prima questi file.

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
