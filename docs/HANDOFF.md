# Handoff — stato condiviso del progetto

Su Ernie lavorano due agenti: Claude Code sul **Mac Studio** e un altro agente sul **Mac dell'ufficio**. Questo file è il
passaggio di consegne fra loro e va aggiornato **a fine di ogni sessione di lavoro**, nello stesso push delle
modifiche: cosa è cambiato, cosa è pubblicato e dove, cosa resta aperto. Le regole di rilascio sono in
[AGENTS.md](../AGENTS.md), le note di ogni build in [releases](releases/).

Ultimo aggiornamento: **27 ottobre 2026**, Codex sul Mac dell’ufficio — build **106 disponibile su
TestFlight**, compilata e firmata dall’ufficio senza sbloccare il Mac Studio.

Sorgenti della build `af5a80238278985525ab2bc03811073f5655d3a2`, pubblicati su GitHub prima della compilazione;
272 input iOS confrontati con `origin/main` e con il checkout pulito del Mac Studio: nessuna differenza.
Comprende appuntamenti completi e il pannello liste `89a1f96`. Apple: **VALID**, **IN_BETA_TESTING**, gruppo
**Interni**, note italiane scritte e rilette. Il commit finale della documentazione non cambia i sorgenti.
Backend attivo a `72a027e`, nessuna differenza nei sorgenti server rispetto al commit della build.
Dettagli ed evidenze in [build 106](releases/build-106.md).
Le modifiche locali preesistenti a documentazione e backup sono conservate ed escluse dal rilascio.

## Prima di iniziare

1. `git fetch && git status`: lavora sempre sopra `origin/main` aggiornato, senza force push. Le modifiche locali
   estranee non si scartano e non si includono alla cieca.
2. Leggi questo file e l'ultima nota in `docs/releases/`.
3. Prima di compilare o installare l'app confronta: numero dell'ultima build su TestFlight, `Changelog.json` locale e
   build installata sul telefono (`xcrun devicectl device info apps --device <udid> --bundle-id com.websdbm.ernie`).
   Non installare mai una build più vecchia di quella presente.
4. Gli agenti in worktree lavorano in `.claude/worktrees`: la cartella è esclusa da Biome e non va nei commit.

## Stato attuale

| Cosa | Stato |
|---|---|
| App su TestFlight | build **106**, verificata il 27 ott: `VALID`, `IN_BETA_TESTING`, gruppo Interni; sorgenti `af5a802` |
| iPhone di Giorgio (ad hoc, account figlio) | build **105** (25 ott, verificata). UDID `00008110-001139321E6B801E`; installazione via Wi-Fi con `apps/ios/scripts/adhoc.sh` quando è nel Wi-Fi di casa e sbloccato. Al prossimo collegamento installare l'ultima build disponibile |
| Server staging3 (`/srv/staging3/projects/ernie`) | commit **72a027e** (27 ott); immagine precedente `ernie-app:pre-5abd040`; vedi «Server» |
| Migrazioni | fino alla **0048**, applicate anche sul server |
| Protocollo | v1.**10** (`user.steer` / `assistant.steer`), pubblicato e provato dal vivo |

### Server

Si pubblica **da git**: copia di sicurezza della cartella, `git fetch` + `git reset --hard <commit pubblicato>`
(come root, con `safe.directory`), rimozione di eventuali `._*`, poi come utente staging3
`docker compose build api worker` e `up -d migrate api worker` (migrate applica le migrazioni nuove). Niente copie a
mano. `docker-compose.override.yml` e `.env` esistono solo sul server e non vanno toccati. Pubblicazione in produzione
e scritture sul database di produzione richiedono il via libera esplicito dell'utente. L'API non risponde su
`127.0.0.1:3000` dall'host: verificare da `https://ernie.staging3.eklettica.it/health`.

Copie di sicurezza del 25 ott: `/srv/staging3/backups/ernie-pre-git-sync-20261025/`, immagine `ernie-app:pre-104`.

## Diagnostica dell'app

- **Rapporti di iOS (MetricKit)**: dalla build 63 l'app manda crash, blocchi e chiusure al primo avvio successivo
  (`POST /v1/diagnostics` → tabella `client_diagnostics`). Lettura:
  `SELECT user_id, app_version, kind, period_end, payload FROM client_diagnostics ORDER BY period_end DESC;`
  Per tradurre `Ernie+offset`: `atos -o <archivio>.xcarchive/dSYMs/Ernie.app.dSYM/Contents/Resources/DWARF/Ernie -arch arm64 -l 0x100000000 0x1<offset in esadecimale>` con l'archivio della stessa build.
- **Crash dal telefono collegato**: `xcrun devicectl device info files --device <udid> --domain-type systemCrashLogs`
  e `xcrun devicectl device copy from … --source Retired/<file>.ips`.
- **API in locale con il modello vero**, senza toccare la produzione: Postgres temporaneo
  (`initdb -E UTF8 --locale=C`) e Redis, migrazioni, poi
  `node --import tsx --conditions=development apps/api/src/cli/init-storage.ts` (tabelle di Mastra) e
  `apps/api/src/index.ts` con le chiavi del `.env` locale e `DATABASE_URL` sul ruolo `ernie_app` (il superutente
  scavalca la RLS e falsa i test).

## Fatto il 25 ottobre (build 104 e 105)

Revisione generale delle build 64–103 da sei revisori in parallelo, poi correzioni. Dettagli in
[build-104](releases/build-104.md) e [build-105](releases/build-105.md).

- **Crash**: conferma di lettura degli urgenti (AppDelegate), dettatura del diario, prova vocale in Diagnostica.
- **Diario**: testo privato che finiva in chat; ripristino che sostituiva un diario integro; apertura senza rete;
  eliminazione di pagina e diario; Writing Tools spenti; lettura, decifratura e scritture fuori dal main.
- **Prestazioni iOS**: storico del pannello con indice letto in background, foto ridotte con `CGImageSource` fuori dal
  main, rapporti MetricKit passati serializzati in background, copia dei widget legata all'account,
  `LegacyTranscriber` sotto lock.
- **Server**: YouTube (tempo oltre 40 caratteri; rifiuto con durata sconosciuta o video non pubblico), Todo e cambio
  dell'ora, segreti nell'output SSH, scope chat su speech/usage/performance, diario 503, replay WebSocket, luoghi
  delle foto con titolo neutro e rimossi quando orfani, coda delle risorse Brain senza transazione lunga e con
  tentativi (0047), un solo livello di retry verso i modelli (`maxRetries: 0`), coda `turn-memory` a scadenza,
  budget del gateway nel giorno di Roma, sintesi vocale non addebitata se non parte, PATCH delle preferenze,
  prestazioni, recupero dei promemoria Todo con attesa (0048), conferma di `reminder_create` leggibile, JPEG con più
  SOF, costo della revisione Brain registrato anche in errore.
- **SSH**: rete Tailscale `100.64.0.0/10` solo al titolare, blocklist completata, timeout DNS, limite di frequenza su
  sonde e diagnosi, porte 22 e 1024–65535; revoca, scollegamento e rifiuto anche a skill spenta; rotte di
  cancellazione `DELETE /v1/ssh/servers/:id` e `/v1/ssh/sites/:id`; esito non perso vicino alla scadenza;
  `--allow-root`; istanze del provider lette fuori dal lock; piani invalidati solo quando cambia il permesso SSH.
- **Funzioni nuove (105)**: precisazione scritta o detta mentre Ernie risponde, che entra nel turno al passo
  successivo senza fermarlo (`prepareStep` di Mastra, `packages/agent-core/src/turn.ts`; `onUserSteer` in
  `apps/api/src/ws/connection.ts`); se il turno non ha più passi il server risponde `late` e l'app la manda come
  messaggio nuovo a turno finito. Tocco lungo sui propri messaggi: «Rimanda», «Modifica e rimanda», «Copia».

### Decisioni dell'utente (25 ott)

- **SSH**: la skill resta disponibile a tutti, ma ognuno la usa **solo con i propri accessi**: server, chiavi e
  provider sono per utente (RLS) e nessuno vede quelli degli altri. La rete Tailscale di casa è solo del titolare.
- **Documenti scansionati**: fanno parte del Second Brain come le altre note (non riservati). L'unica parte riservata è
  il **diario personale**, che è una skill separata e cifrata sul telefono.
- Precisazioni durante la risposta: «entra senza fermare».

## Aperto

1. *Salvataggio della chat sul main*: `ConversationStore.persist` → `TranscriptStore.save` codifica e scrive l'intera
   conversazione sul main a ogni aggiornamento. Spostarlo in una coda serializzata richiede di adeguare i test che
   rileggono subito il file. Guardare i rapporti MetricKit della 105: se i blocchi da watchdog (0x8BADF00D) restano,
   è il primo candidato.
2. *Todo, doppio aggiornamento*: ogni salvataggio dalla chat produce la scheda del tool e un evento da
   `todo-reminders` `onChanged` (che serve agli altri dispositivi), quindi sul telefono `TodoStore.apply` e
   `reminders.refresh` girano due volte. Correzione: escludere la connessione d'origine o deduplicare per lista e
   revisione nell'app.
3. *Todo con Redis giù*: il salvataggio risponde errore anche se la lista è salvata; voluto e coperto da test
   (riprovare lo stesso salvataggio riallinea); valutare se dire «salvata, promemoria in sospeso».
4. *Foto*: i luoghi creati prima della 105 hanno ancora il titolo con le coordinate (esclusi dal revisore e rimossi
   quando orfani); rinominarli richiede una migrazione del vault.
5. *SSH*: l'app non ha ancora i pulsanti per le nuove rotte di cancellazione di server e siti; un server salvato su una
   porta sotto 1024 diversa dalla 22 va spostato; limite di frequenza in memoria per istanza; paginazione Vultr;
   sonde HTTP di `site-probe.ts` non riviste.
6. *Spese delle automazioni*: il tetto in `packages/automations/src/repository.ts` usa ancora il giorno UTC.
7. *Diario dopo l'uscita dall'account*: file e chiave restano (si eliminano da «Elimina diario…»); decidere se
   l'uscita debba chiederlo. Tastiere di terze parti sui campi del diario si possono escludere solo per tutta l'app.
8. *WebSocket*: nessun tetto alle connessioni sospese per utente (`ws/plugin.ts`).
9. *Test iOS*: `avvioRealeMicrofonoRiceveBufferEFermaSenzaCrash` aspetta il permesso del microfono su un simulatore
   nuovo (escluderlo con `-skip-testing`); `TerminalChatTests.focusProgrammaticoECambioSkinNellaBarraCompleta` a volte
   fallisce nella suite completa e da solo passa. Sul Mac Studio usare il simulatore «Ernie prova»: «iPhone 17» è
   usato da un'altra sessione.

10. *YouTube dal server*: la pagina del video arriva spesso col controllo anti-bot (IP di Contabo), senza durata.
   Gli Short si analizzano comunque (massimo 3 minuti), i video normali solo quando la pagina è leggibile; altrimenti
   rifiuto «non riesco a leggere la durata». Soluzione stabile: YouTube Data API v3 (`videos.list`
   `contentDetails,status`) con una chiave dedicata, da decidere con l'utente.

## Decisioni in sospeso per l'utente

- YouTube Data API per la durata dei video normali (voce 10 di «Aperto»).
- DNS di riserva sul server (Cloudflare/Quad9 accanto a quelli di Contabo): il 16 ott un guasto DNS di pochi secondi ha
  fatto fallire un turno.

## Registro delle sessioni

- **27 ott 2026 (mattina) — Mac Studio (Claude Code)**: pannello laterale con Spesa e Attività separate e righe
  compatte, giornate passate archiviate (`TodoTime.isArchived`, solo nell'app), unite alla build 106 preparata dal
  Mac dell'ufficio. Server pubblicato a `72a027e` (correzione spesa + parte server degli appuntamenti del 26 ott).
  106 non ancora su TestFlight.
- **27 ott 2026 — Mac Studio (Claude Code)**: spesa, «Aggiungi alla lista di cose da comprare una confezione di porridge»
  aggiungeva la voce «alla» alla Spesa dopo una domanda inutile; corretto il parser (`5abd040`, solo server, da
  pubblicare con il via libera dell'utente). YouTube Data API facoltativa (`46c36a2`, `YOUTUBE_API_KEY`): chiave da
  creare nella console Google (serve che l'utente confermi la password dell'account) e da mettere nel `.env` del server.
- **25 ott 2026 (sera) — Mac Studio (Claude Code + tre agenti in worktree)**: precisazioni durante la risposta e
  messaggi riusabili (protocollo v1.10), provati con il modello vero su API locale (precisazione entrata dopo
  `web_search`, risposta adeguata); chiusura delle voci aperte su SSH, backend, prestazioni e diario dell'app; 944 test
  del server verdi con integrazione su Postgres e Redis reali; build 105 preparata.
- **25 ott 2026 — Mac Studio (Claude Code)**: revisione generale delle build 64–103, build 104, server riallineato a
  git, questo file e la regola dell'handoff in AGENTS.md.
- **16–24 ott 2026 — Mac dell'ufficio**: build 64–103 (widget con scorciatoie, Automazioni, ErnieTRIX, indice del
  Second Brain, Todo con timeline, SSH, media e ricette, consumi, diario personale cifrato). Dettagli nelle note di
  `docs/releases/`.
- **16 ott 2026 — Mac Studio**: stile e lessico, discesa da heavy, memoria (schema dell'estrazione), backup notturno,
  diagnostica MetricKit (build 62–63).
