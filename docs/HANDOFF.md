# Handoff — stato condiviso del progetto

Su Ernie lavorano due agenti: Claude Code sul **Mac Studio** e un altro agente sul **Mac dell'ufficio**. Questo file è il
passaggio di consegne fra loro e va aggiornato **a fine di ogni sessione di lavoro**, nello stesso push delle
modifiche: cosa è cambiato, cosa è pubblicato e dove, cosa resta aperto. Le regole di rilascio sono in
[AGENTS.md](../AGENTS.md), le note di ogni build in [releases](releases/).

Ultimo aggiornamento: **29 ottobre 2026**, Codex sul Mac dell’ufficio — build **111 in preparazione**.
Ultima distribuzione verificata: **110**, TestFlight/Interni (`VALID`, `IN_BETA_TESTING`).
La 111 estende i comandi: `/promemoria` apre l’elenco, con testo invia una richiesta di creazione/modifica/
annullamento; `/ricordami` prepara una bozza e con testo invia al normale flusso di conversazione.
Suggerimenti con esempi, icona e accessibilità distinguono navigazione e richiesta. Nessuna chiamata diretta
a tool: permessi, chiarimenti, recupero del turno e controllo server restano quelli esistenti.
Le richieste possono usare AI e token. Skill «Ricordami» controllata per account; URL e note conservati.
Prima verifica sul Mac Studio: **19 test iOS verdi in tre suite**, senza invii reali né promemoria creati.
In corso verifica finale con versione 111 e anteprima nativa aggiornata, poi archivio e distribuzione.
Xcode dell’ufficio richiede la nuova licenza: test e compilazione vengono eseguiti sul Mac Studio.

**Backend invariato**: API staging3 `f961ab088e88c8e8630d98c8b5b4eeeb4b6e041d`, worker `72a027e`.
Dettagli: [build 111](releases/build-111.md); ultima distribuzione: [build 110](releases/build-110.md).
Documentazione/backup modificati preesistenti e asset non tracciati restano esclusi.

### Firma e distribuzione senza sbloccare il Mac Studio

**Risolto il blocco per la 107.** La firma Development dell’ufficio ora rifiuta la chiave, ma l’export API
usa la firma gestita da Apple, come nella 106. Compilare senza firma; su una copia dell’archivio usare
`apps/ios/scripts/prepare-cloud-signing.py --profiles-from <archivio precedente valido>` per conservare
profili e permessi. Il prefisso può differire dal Team ID (notifiche legacy): lo script lo risolve per target.
Esportare prima su disco, verificare firma/entitlement e isolamento del diario nell’IPA, poi caricarla con
altool e API Apple. Lo script non produce da solo un pacchetto installabile; non caricare gli intermedi.
Nessuna chiave privata di firma trasferita e nessuna protezione del Portachiavi cambiata. Credenziale API
temporanea rimossa. Interni riceve automaticamente tutte le build: attendere lo stato effettivo, senza
forzare un’associazione manuale via API (rifiutata per questo gruppo).

**Per la 107:** 88 test verdi in 11 suite; sette WAV riproducibili; IPA verificata su app e tre estensioni alla 107.
Evidenze e manifest: `~/Library/Caches/ernie-builds/build-107-20261027-sounds/` sul Mac dell’ufficio.
Restano da provare i suoni sul dispositivo fisico (altoparlante/cuffie e silenzioso). Nessuna installazione
diretta sui telefoni in questa sessione. La precedente 106 resta documentata in [build 106](releases/build-106.md).

### Analisi Cindy — 27 ottobre, nessuna implementazione

Analisi statica del repository `makecindy/cindy`, snapshot
`7be4c57d7bdbed3e115685a5fb1aba61772497c7`: README, memoria, apprendimento notturno, scheduler,
scoperta plugin, componenti delle risposte e setup. Il backend cloud non è incluso in quel repository.
Idee proposte: strumenti scoperti su richiesta; registro degli apprendimenti con fonti/ambito/annullamento;
procedure candidate prima di renderle riutilizzabili; piccole schede per chiarire orari e conflitti;
collegamento di servizi con ripresa dell'intento originale; stato delle operazioni più uniforme.
Ernie ha già snapshot selettivi, preferenze esplicite/inferite, controlli prima del modello, deduplica delle
automazioni, schede native e revisione Brain limitata a 24 ore: estendere queste basi, senza ricostruirle.
Conservare il limite giornaliero, il consolidamento locale dopo un'aggiunta e l'esclusione del diario privato.
Priorità suggerita: chiarimenti interattivi, strumenti su richiesta (misurando token e latenza), poi registro
apprendimenti e procedure versionate. Nodo Mac e multiagenti in seconda fase. Prestazioni/integrazioni Cindy
non provate: nessuna installazione, esecuzione del progetto o modifica applicativa. Nessuna nuova build/deploy.

### Analisi Agent-Reach — 27 ottobre, nessuna integrazione

Analisi statica di `Panniantong/Agent-Reach`, snapshot `14c213405669414492bda0f8d52cc6531d062c45`
(v1.6.0, MIT). Interessanti: contratto JSON comune con fonte/backend/tentativi, fallback classificati,
pausa dei backend guasti e diagnostica per canale; ricerca YouTube e sottotitoli come percorso economico.
Il canale YouTube usa yt-dlp per metadati/search/subtitle; l'ASR scarica audio, usa ffmpeg e richiede Groq
oppure OpenAI diretto, senza supporto OpenRouter nel codice esaminato. Non è una soluzione a costo zero
universale né evita la gestione media sul server quando serve ASR.
Instagram è sperimentale, con browser/login: azioni search utenti, profile e posts recenti, nessuna azione
specifica Reel-URL → trascrizione. Non risolve da solo le scritte nei fotogrammi.
Ernie ha già metadati e analisi visiva YouTube via OpenRouter/Google AI Studio senza download locale:
valutare sottotitoli come alternativa per riassunti, conservando visione per ricette con dati sullo schermo.
Riuso selettivo da provare sul VPS con limiti di durata/costo e isolamento degli account; browser/cookie non
vanno condivisi fra utenti Ernie. Nessuna installazione, accesso account, servizio aggiunto, build o deploy.

### Implementazione selettiva Agent-Reach — 27 ottobre, build 108

Autorizzata dall’utente dopo l’analisi. Contratto di provenienza YouTube; tentativo di sottotitoli pubblici
solo per riassunti espliciti, fallback visivo e pausa per account; diagnostica GET `/v1/content-readers`
con esiti Redis a scadenza 24h, schermata iOS in Diagnostica. Ricette e immagini conservano il video.
Nessun nuovo provider, cookie, audio scaricato o integrazione Instagram. 101 test backend e TypeScript verdi;
23 test iOS verdi in tre suite; API pubblicata, 108 disponibile su TestFlight/Interni. I tre link pubblici provati non hanno dato sottotitoli utilizzabili:
il risparmio reale resta da misurare. Dettagli e limiti in [build 108](releases/build-108.md).

### Schede messaggi in famiglia — 27 ottobre, build 109

Destinatario, urgenza, ora, testo e conferma riuniti nella stessa superficie. Palette dell’orso e testo grande,
nessun bordo rosso spesso; stati distinti fra invio e lettura confermata. Azioni ricevuti da 44 pt, verticali
con Dynamic Type accessibile. Stesse API e schermata di conferma; il risultato del tool richiede al modello
un riscontro breve senza presumere audio/consegna. 27 test iOS e 10 backend verdi; nessun invio reale di prova.
API pubblicata e 109 disponibile in TestFlight/Interni: [build 109](releases/build-109.md).

### Comandi rapidi — 28 ottobre, build 110

Menu locale con `/`, filtro durante la digitazione, `/messaggio` e testo facoltativo per preparare il
compositore Famiglia. Altri comandi aprono sezioni; `/aiuto` li elenca. Skill attive controllate per account;
errori locali senza perdere bozza o allegati; nessun invio automatico e nessun modello coinvolto.
Intervento solo iOS; backend invariato. 110 disponibile su TestFlight/Interni. Dettagli e verifiche: [build 110](releases/build-110.md).

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
| App su TestFlight | build **110**, verificata il 28 ott: `VALID`, `IN_BETA_TESTING`, gruppo Interni; sorgenti iOS `e7bd0f3` |
| iPhone di Giorgio (ad hoc, account figlio) | build **105** (25 ott, verificata). UDID `00008110-001139321E6B801E`; installazione via Wi-Fi con `apps/ios/scripts/adhoc.sh` quando è nel Wi-Fi di casa e sbloccato. Al prossimo collegamento installare l'ultima build disponibile |
| Server staging3 (`/srv/staging3/projects/ernie`) | API **f961ab0** (27 ott, messaggi); worker ancora **72a027e**. Immagine di recupero API `ernie-app:pre-family-card-109`; vedi build 109 |
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
