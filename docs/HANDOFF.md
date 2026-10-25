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
6. *Foto geolocalizzate*: nota «Luogo fotografato (lat, lon)» con 5 decimali, non riservata, mandata al revisore; resta
   anche dopo aver cancellato la foto. Proposta: titolo neutro, coordinate solo nei metadati, pulizia dei luoghi orfani.
7. *Second Brain: transazione lunga* in `brain-resources.ts` `syncUser` (git, embedding e 100 job dentro una
   transazione con advisory lock) e un job che fallisce blocca la coda dell'utente; trigger `brain_resource_relink`
   (0041) che rimette in coda tutte le risorse a ogni nuova nota.
8. *Tentativi annidati verso i modelli*: `retryModelCall` (3) dentro i retry di Mastra (2 di default) → fino a 9
   chiamate con un 429; impostare `maxRetries: 0` nei `modelSettings` di consolidamento, giudice, riassunto,
   health-extract, clarify, titolo dei promemoria; a clarify passare anche `abortSignal`.
9. *YouTube*: con durata sconosciuta (pagina non letta) il limite dei 20 minuti non vale (`youtube.ts`).
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
- Todo: doppio blocco `todo_list` per salvataggio dalla chat; `todo_pending_reminders` può fermarsi su liste che
  falliscono sempre; scheda di conferma di `reminder_create` con i giorni in numero.
- Coda `turn-memory`: testo del messaggio in Redis 7 giorni, per sempre se il job fallisce (`memory/queue.ts`).
- Budget giornaliero in UTC mentre il pannello consumi usa Europe/Rome (`model-gateway/budget.ts`).
- Sintesi vocale registrata come spesa anche se la richiesta non parte (`speech.ts`).
- Preferenze operative: un PATCH riattiva una preferenza spenta (`active` con default).
- Prestazioni: un'osservazione non valida annulla tutto il lotto.
- SSH: diagnosi WordPress come root senza `--allow-root`; paginazione Vultr; lettura delle istanze dentro il lock;
  ogni cambio d'impostazione invalida i piani in attesa; costo della revisione Brain non registrato se va in errore.
- Immagini: possibile JPEG con doppio SOF oltre i limiti di pixel (`media-image.ts`).
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
