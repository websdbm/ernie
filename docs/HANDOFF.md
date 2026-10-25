# Handoff — stato condiviso del progetto

Su Ernie lavorano due agenti: Claude Code sul **Mac Studio** e un altro agente sul **Mac dell'ufficio**. Questo file è il
passaggio di consegne fra loro e va aggiornato **a fine di ogni sessione di lavoro**, nello stesso push delle
modifiche: cosa è cambiato, cosa è pubblicato e dove, cosa resta aperto. Le regole di rilascio sono in
[AGENTS.md](../AGENTS.md), le note di ogni build in [releases](releases/).

Ultimo aggiornamento: **25 ottobre 2026**, Claude Code sul Mac Studio (revisione generale e correzioni, build 104).

## Prima di iniziare

1. `git fetch && git status`: lavora sempre sopra `origin/main` aggiornato, senza force push. Le modifiche locali
   estranee non si scartano e non si includono alla cieca.
2. Leggi questo file e l'ultima nota in `docs/releases/`.
3. Prima di compilare o installare l'app confronta: numero dell'ultima build su TestFlight, `Changelog.json` locale e
   build installata sul telefono (`xcrun devicectl device info apps --device <udid> --bundle-id com.websdbm.ernie`).
   Non installare mai una build più vecchia di quella presente.

## Stato attuale

| Cosa | Stato |
|---|---|
| App su TestFlight | build **104** (correzioni di questa revisione), `VALID` il 25 ott — [nota](releases/build-104.md) |
| iPhone di Giorgio (ad hoc, account figlio) | build **102** installata il 24 ott; pacchetto **104** pronto sul Mac Studio (`~/Library/Caches/ernie-adhoc/export/Ernie.ipa`), da installare quando il telefono è raggiungibile. UDID `00008110-001139321E6B801E`; installazione via Wi-Fi con `apps/ios/scripts/adhoc.sh` quando è nel Wi-Fi di casa e sbloccato |
| Server staging3 (`/srv/staging3/projects/ernie`) | vedi «Server» sotto |
| Migrazioni applicate | fino alla **0046** |

### Server

In esecuzione: commit **4d9aa7d** (25 ott), allineato a git. Fino al 24 ottobre il server era aggiornato **copiando i singoli file** (git fermo al 16 ottobre, ~150 file modificati,
233 non tracciati, 25 file `._*` creati da macOS). Il 25 ottobre il codice in esecuzione coincideva con `main` (103):
il server è stato riallineato a git con una copia di sicurezza in `/srv/staging3/backups/ernie-pre-git-sync-20261025/` e immagine precedente `ernie-app:pre-104`. **Da qui in poi si pubblica
da git**: `git fetch` + checkout del commit pubblicato, poi `docker compose build` e `up -d` dei soli servizi toccati
(migrate se ci sono migrazioni). Niente copie a mano: lasciano il repository del server incoerente e i file `._*`.
`docker-compose.override.yml` e `.env` sono solo sul server e non vanno toccati.

## Diagnostica dell'app

- **Rapporti di iOS (MetricKit)**: dalla build 63 l'app manda crash, blocchi e chiusure al primo avvio successivo
  (`POST /v1/diagnostics` → tabella `client_diagnostics`). Lettura:
  `SELECT user_id, app_version, kind, period_end, payload FROM client_diagnostics ORDER BY period_end DESC;`
  Per tradurre gli indirizzi `Ernie+offset`: `atos -o <archivio>.xcarchive/dSYMs/Ernie.app.dSYM/Contents/Resources/DWARF/Ernie -arch arm64 -l 0x100000000 0x1<offset in esadecimale>` con l'archivio della stessa build.
- **Crash dal telefono collegato**: `xcrun devicectl device info files --device <udid> --domain-type systemCrashLogs`
  e `xcrun devicectl device copy from … --source Retired/<file>.ips`.

## Revisione generale del 25 ottobre 2026

Revisione di tutto il lavoro dal 16 al 24 ottobre (build 64–103), da sei revisori in parallelo su stabilità iOS,
funzioni nuove iOS, backend (diario, SSH, Todo/promemoria/automazioni, Second Brain/media/ricette,
memoria/gateway/consumi). Typecheck, 915 test del server (anche integrazione con Postgres e Redis reali) e test
dell'app verdi dopo le correzioni.

### Corretto (build 104 e server)

- **Crash alla conferma di lettura** (16 ott build 62, 24 ott build 102, simbolizzato): `AppDelegate`
  `userNotificationCenter(_:didReceive:)`/`willPresent` erano `async` nonisolated; ora completamento esplicito sul main.
- **Crash della dettatura del diario** («Detta sul dispositivo») e della prova vocale in Diagnostica: callback di
  sistema che ereditavano il MainActor, ora `@Sendable`.
- **Privacy del diario**: «scrivi nel diario: … il diario operativo …» finiva in chat e al server; l'esclusione ora
  vale solo subito dopo la parola diario. Ripristino di una copia a diario bloccato: unisce invece di sostituire; si
  sostituisce solo con la chiave invalidata (errore nuovo `keyInvalidated`).
- **Spesa**: niente chiusura dell'app con id duplicati.
- **YouTube** («dati non leggibili», riprodotto 3 volte su 3): il campo tempo superava 40 caratteri e veniva scartata
  l'intera ricetta; limiti 120 e campi accorciati invece di scartare.
- **Todo e cambio dell'ora**: il modello scriveva `+02:00` dopo il 25 ottobre e il promemoria suonava un'ora prima;
  `todo_save` ora rifiuta solo questa confusione (UTC e liste salvate dall'app restano valide; orari inesistenti con
  messaggio dedicato).
- **SSH**: output ripulito anche da `define('DB_PASSWORD', …)`, `*_TOKEN=`, tabelle di `wp config list`, token negli
  URL; `wp config get <segreto>` non si esegue.
- **API**: scope `chat` richiesto anche da sintesi vocale, consumi e prestazioni; diario: errori del server 503 invece
  di 400; WebSocket: lo stato di replay non resta bloccato dopo `session_forbidden`; avvio dell'API che non cade se il
  primo recupero dei Todo fallisce; data delle foto nel fuso di Roma.

### Corretto dopo la build 104 (solo server, da pubblicare con le migrazioni 0047 e 0048)

- **Foto geolocalizzate**: il luogo nuovo si chiama «Luogo fotografato il 2 luglio 2026» (con «(2)», «(3)» se il
  titolo c'è già), coordinate solo nei metadati; un luogo nato da una foto, mai rinominato né modificato, sparisce
  quando non resta nessuna foto o nota collegata; questi luoghi non vanno al revisore del Second Brain.
- **Coda delle risorse Brain** (`brain-resources.ts`): lotto letto in una transazione breve, poi un job alla volta con
  transazioni proprie (niente Git ed embedding dentro una transazione); lock di sessione per utente su una
  connessione dedicata. Un job che fallisce va in fondo con attesa crescente (30 s × 2ⁿ, massimo 6 h, colonne
  `attempts`/`next_attempt_at`) e non blocca gli altri; una modifica della risorsa lo rende subito ritentabile.
  Migrazione 0047: il trigger `brain_resource_relink` rimette in coda solo le risorse che citano il titolo (vecchio o
  nuovo), quelle collegate a mano e, per i luoghi, le foto entro ~200 m.
- **Un solo livello di tentativi verso i modelli**: `maxRetries: 0` in consolidamento, giudice, riassunto,
  health-extract, clarify (con `abortSignal` legato alla scadenza del chiarimento), titolo dei promemoria e
  documenti; un test controlla che ogni `modelSettings` dei pacchetti lo abbia.
- **YouTube**: con durata sconosciuta o video non verificato come pubblico si rifiuta con un messaggio chiaro
  (`video_duration_unknown` / `video_unavailable`) invece di analizzare senza limite. Se YouTube blocca la lettura
  della pagina dal server, i video non vengono più analizzati.
- **Minori**: coda `turn-memory` con completati rimossi dopo 1 h e falliti dopo 3 giorni; budget giornaliero nel
  giorno di Roma; sintesi vocale non registrata come spesa se la connessione al fornitore non si apre; PATCH delle
  preferenze operative che non riaccende `active`; prestazioni che scartano solo la misura non valida (risposta
  `{accepted, rejected}`); recupero dei promemoria Todo con attesa crescente per le liste che falliscono (migrazione
  0048, `todo_pending_reminders(uuid[])`); scheda di conferma di `reminder_create` con la ricorrenza in parole; JPEG
  con più di un SOF (o SOF non supportato) rifiutati e `-max_pixels` a ffmpeg; costo della revisione Brain registrato
  anche in caso di errore.

### Aperto, in ordine di gravità

Ogni voce: file, problema, correzione proposta. Chi la prende la toglie da qui nel suo commit.

**Media**
1. *Blocchi da watchdog (0x8BADF00D) in background, build 97–98*: lavoro pesante sul main durante l'aggiornamento della
   scena. Candidati: `SidePanel` → `TranscriptStore.list` decodifica fino a 80 conversazioni sul main;
   `MediaPresentation.prepare` decodifica e ricodifica foto intere sul main (anche rischio di memoria);
   `DiaryStore.persist`/`exportBackup`/`restore` cifrano l'intero diario e fanno PBKDF2 sul main a ogni pausa di
   digitazione. Spostare fuori dal main (funzioni `nonisolated`, `CGImageSourceCreateThumbnailAtIndex`, bozza del
   diario in un file separato).
2. *SSH disponibile a ogni account* (`packages/skills/src/catalog.ts` `ssh` `defaultAvailable: true`) e sonda verso
   `100.64.0.0/10` su qualunque porta senza limite di frequenza (`ssh-transport.ts`, `ssh/service.ts` hostProbe):
   decidere se solo per il titolare; limitare porte e frequenza; timeout sul DNS. **Decisione dell'utente.**
3. *SSH: revoca della chiave e scollegamento del provider bloccati* con skill spenta o interruttore di emergenza
   (`ssh/service.ts` `lock` con `check=true`); manca la cancellazione di server, siti e credenziali.
4. *SSH: esito perso* se l'intervento viene approvato vicino alla scadenza (`recoverExpired` usa `expires_at` della
   creazione anche per le righe `running`).
5. *Second Brain: OCR dei documenti scansionati* in note non riservate, proposte in chat da `index.suggest` e spinte sul
   remoto Git (`brain-resources.ts` `private: false`). Proposta: scansioni riservate o fuori da `suggest`.
   **Decisione dell'utente.**
6. *Foto geolocalizzate, schede già esistenti*: i luoghi creati prima della correzione hanno ancora il titolo
   «Luogo fotografato (lat, lon)» (esclusi comunque dal revisore e rimossi quando restano senza foto); per rinominarli
   servirebbe una migrazione del vault. Valutare se farla.
10. *Diario offline*: senza profilo (avvio senza rete) il diario locale non si apre e il testo dettato si perde
    (`DiaryViews.swift` `DiaryEntrance` richiede `model.profile?.userId`): salvare lo scope in locale.
11. *Todo*: con Redis giù il salvataggio risponde errore anche se la lista è salvata (`todo.ts` `save` → `onChanged`).
    Comportamento voluto e coperto da test (il nuovo salvataggio identico riprova); valutare se all'utente va detto
    «salvata, promemoria in sospeso».

**Bassa**
- Diario: la prima dettatura può bloccare il diario (avviso di permesso → `scenePhase .inactive` → `lock`); la
  dettatura sovrascrive il testo scritto a mano nel frattempo; limiti superati con messaggi d'errore sbagliati; nessuna
  cancellazione di pagine o del diario e chiave che resta dopo l'uscita dall'account; `DiaryEntrance` con
  `NavigationStack` annidato da Impostazioni; Writing Tools e tastiere di terze parti sui campi del diario.
- Widget con i dati dell'account precedente se l'uscita avviene durante un aggiornamento (`ErnieSummary.fetch`).
- `LegacyTranscriber` (`SpeechInput.swift`): `task`/`publish` senza lock.
- `DiagnosticsReporter.start`: `jsonRepresentation()` dei rapporti passati sul main all'avvio.
- WebSocket: le connessioni sospese per utente non hanno un tetto (`ws/plugin.ts`).
- Todo: doppio blocco `todo_list` per salvataggio dalla chat (scheda del tool nel turno + evento utente di
  `todo-reminders` `onChanged` a tutte le connessioni, che serve agli altri dispositivi). Sul telefono non si vede
  doppio (il secondo aggiorna la scheda), ma `TodoStore.apply` e `reminders.refresh` girano due volte. Correzione
  pulita: escludere la connessione d'origine in `ConnectionRegistry.push`/`ws/connection.ts` o deduplicare per
  `blockId` sull'app; non fatta per non toccare `connection.ts`.
- SSH: diagnosi WordPress come root senza `--allow-root`; paginazione Vultr; lettura delle istanze dentro il lock;
  ogni cambio d'impostazione invalida i piani in attesa.
- Test iOS: `TerminalChatTests.focusProgrammaticoECambioSkinNellaBarraCompleta` fallisce a volte nella suite completa
  (focus non ancora assegnato), da solo passa; `avvioRealeMicrofonoRiceveBufferEFermaSenzaCrash` resta in attesa del
  permesso del microfono su un simulatore nuovo (escluderlo con `-skip-testing` o concedere il permesso).

## In programma (decisioni dell'utente)

- **Build 105 — riusare i messaggi vecchi** (richiesta del 25 ott 2026): tenendo premuto un proprio messaggio,
  «Rimanda» (stesso testo, es. il link di un video) e «Modifica e rimanda» (testo nel campo di scrittura).
  **Precisazione durante una risposta**: scelta dell'utente «entra senza fermare», cioè la precisazione arriva al
  modello al passo successivo del turno in corso (fra una chiamata di strumento e l'altra), senza annullare il lavoro
  fatto. Serve un evento nuovo nel protocollo (precisazione legata al `correlationId` attivo) e l'iniezione nel loop
  dell'agente sul server; oggi un messaggio durante un turno riceve `busy` e va in coda. Assegnata a: Mac Studio.

## Decisioni in sospeso per l'utente

- DNS di riserva sul server (Cloudflare/Quad9 accanto a quelli di Contabo): il 16 ott un guasto DNS di pochi secondi ha
  fatto fallire un turno.
- SSH solo per il titolare o anche per i familiari (voce 2).
- Documenti scansionati riservati nel Second Brain (voce 5).

## Registro delle sessioni

- **25 ott 2026 — Mac Studio (Claude Code)**: revisione generale delle build 64–103, correzioni sopra, build 104,
  server riallineato a git, questo file.
- **16–24 ott 2026 — Mac dell'ufficio**: build 64–103 (widget con scorciatoie, Automazioni, ErnieTRIX, indice del
  Second Brain, Todo con timeline, SSH, media e ricette, consumi, diario personale cifrato). Dettagli nelle note di
  `docs/releases/`.
- **16 ott 2026 — Mac Studio**: stile e lessico, discesa da heavy, memoria (schema dell'estrazione), backup notturno,
  diagnostica MetricKit (build 62–63).
