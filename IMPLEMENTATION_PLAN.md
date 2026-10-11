# Ernie — Piano di implementazione

> Stato aggiornato al 10 ottobre 2026 (allineato ad ARCHITECTURE.md v0.2: le voci A.x/B.x/C.x rimandano a `docs/research/03-revisione.md` §5). Ogni milestone ha criteri di accettazione verificabili; non si passa alla successiva finché la corrente non è verificata (lint, typecheck, test, e dove previsto Docker e smoke test).

Scenario guida e golden set: `docs/USE_CASES.md` (UC-1, lista della spesa → abitudini → ricette).

Legenda: ✅ completata · 🔧 in corso · ⏳ pianificata · ⚠️ bloccata/da chiarire

## Riepilogo

| Milestone | Obiettivo | Stato |
|---|---|---|
| M1 | Fondamenta: monorepo, TypeScript, Fastify, PostgreSQL, Docker Compose, health check, test, CI | ✅ |
| M2 | Agente minimo: Mastra, Soul per utente, sessioni, OpenRouter, streaming WS, persistenza, costi, RLS | ✅ |
| M3 | JEV Router: adapter, soglie calibrate, comandi deterministici, Policy Engine con taint e approvazioni, isteresi di classe, loop detector | ✅ |
| M4 | Memoria: semantica ed episodica, ricerca ibrida RRF, snapshot + memory_search, consolidamento asincrono, export/oblio | ✅ |
| M5 | Tool e skill: registry, executor, permessi, Firecrawl, skill deterministiche, test di sicurezza | ⏳ |
| M6 | Automazioni: BullMQ, scheduler, trigger, storico, notifiche | ⏳ |
| M7 | App iOS: SwiftUI, autenticazione, chat, push-to-talk, STT/TTS, streaming | ⏳ |
| M8 | Voce avanzata: modalità continua, sintesi incrementale, interruzione, errori audio | ⏳ |
| M9 | Ottimizzazione: benchmark token, cache, profilazione, latenza, e2e, hardening | ⏳ |
| M10 | Avatar 3D: three.js + TalkingHead in WKWebView, modulo italiano, lip-sync on-device, integrazione | ⏳ |
| R | Ricerca bibliografica (3 ricercatori + revisore) e integrazione nei documenti | ✅ |

## M1 — Fondamenta ✅

Consegnato:
- Monorepo pnpm (`apps/api`, `apps/worker`, `packages/{config,db,observability,protocol}`), TypeScript 5.9 strict con project references, Biome 2, Vitest 5.
- `@ernie/config`: schema Zod delle variabili d'ambiente, config tipizzata, redazione dei segreti.
- `@ernie/observability`: logger pino con redazione automatica delle credenziali, generatore di ID.
- `@ernie/protocol`: protocollo v1 (13 tipi di evento, envelope con id/sessionId/correlationId/seq/ts, direzione e audience per tipo, deduplica e controllo di sequenza).
- `@ernie/db`: pool `pg`, health check, runner di migrazioni SQL con checksum, transazioni, advisory lock e CLI (`up`, `status`); migrazioni `0001_extensions` (vector, pgcrypto, pg_trgm) e `0002_users_and_api_keys`.
- `apps/api`: Fastify 5 con `GET /health` (liveness) e `GET /ready` (readiness con timeout per controllo, 503 se una dipendenza manca), `x-request-id`, gestione errori JSON, arresto graduale.
- `apps/worker`: BullMQ 6 su coda `system` con job scheduler `heartbeat` (scrive `ernie:worker:heartbeat` in Redis con TTL) e processore deterministico testato.
- Docker: immagine unica multi-stage (Node 24 alpine, solo dipendenze di produzione, utente non root); Compose con `postgres` (pgvector 17), `redis` (AOF), `migrate` (one-shot), `api`, `worker`, profilo opzionale `litellm`; volumi persistenti.
- CI GitHub Actions: lint → build → migrazioni → test con Postgres/Redis reali → build immagine → avvio stack → smoke test.
- Documentazione: `ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/research/00-fonti-verificate.md`, `README.md`.

Criteri di accettazione e verifica (10 ott 2026, macOS, Node 26, Docker Desktop 29):
- [x] `pnpm lint`, `pnpm build`, `pnpm test` verdi: 41 test (unitari + integrazione con Postgres/Redis reali), 0 errori di lint.
- [x] `pnpm migrate up` applica le migrazioni ed è idempotente; `status` riporta 0 pendenti; modifica di una migrazione applicata → errore di checksum (testato).
- [x] `docker compose up -d --wait api worker` porta su lo stack; `tests/smoke.sh` verifica `/health` 200 e `/ready` 200 con controlli `postgres` e `redis` ok (vedi verbale in fondo).
- [x] Nessun segreto nel repository: `.env` ignorato, `.env.example` senza valori, redazione nei log testata.

Deviazioni dichiarate rispetto al prompt: `packages/protocol` anticipato alla M1 (pure tipi + test); LiteLLM reso opzionale (motivazione in ARCHITECTURE.md §2); TypeScript 5.9 invece di 7.0.

## M2 — Agente minimo ✅

Ambito: `packages/agent-core`, `packages/soul`, `packages/model-gateway`; `apps/api` con WebSocket (`@fastify/websocket`), autenticazione con chiave API (hash in `api_keys`), sessioni (Mastra threads), streaming via eventi v1/v1.1; persistenza conversazioni (`PostgresStore`); tabelle `souls`/`soul_versions`, `llm_calls`; primo set di policy RLS.

Criteri di accettazione:
- [x] `session.start` + `user.message` producono `assistant.started`, `assistant.text.delta`*, `assistant.text.completed`, `assistant.completed` con `usage` reale del provider (verificato end-to-end, vedi verbale).
- [x] **Prefisso stabile** (A.3): un agente per sessione con istruzioni/modello fissi (`SessionAgentCache`), modalità vocale marcata nel turno utente; `cache_control` automatico e `session_id` sempre inviati; test online opzionale (`ERNIE_ONLINE_TESTS=1`) che confronta byte per byte il messaggio di sistema di due turni reali. Nota: con il solo Soul (~400 token) il prefisso resta sotto il minimo di 512 token cacheabili dei modelli 5.5; la cache si attiva con tool e snapshot di memoria (M3–M5).
- [x] **Spike passthrough OpenRouter** eseguito l'11 ott 2026 (`docs/research/05-spike-openrouter-passthrough.md`): la stringa nativa di Mastra non ottiene cache; con `@openrouter/ai-sdk-provider` cache hit (−92% sulla seconda chiamata), costo reale nella risposta, `session_id` e `reasoning.effort` passano; payload Mastra stabile tra turni (assemblaggio lasciato a Mastra); `max_tokens` va sempre impostato; cambiare `reasoning` per richiesta azzera la cache; `usage` di Mastra aggregato per step. ID modelli 5.5 verificati su `/api/v1/models`.
- [x] Core Soul ≤ 400 token verificato da test sul seed; Context Soul per `sessions.context_tags` (A.6); Soul per utente clonati dai globali con versioni e `locked`.
- [x] Mappa classi → modelli in configurazione (`MODEL_*`) con `maxOutputTokens`, `reasoning` e `maxSteps` per classe; `session_id` OpenRouter = sessione Ernie; tetto giornaliero per utente (`LLM_DAILY_BUDGET_USD` o `users.settings.dailyBudgetUsd`) con errore `budget_exceeded`.
- [x] **`llm_calls`** per step con costo del provider, stima da listino (entro il 5% dei valori misurati), token in/cache read/cache write/out/reasoning, TTFT, latenza; una riga per step (test).
- [x] **Protocollo v1.1**: `persist`, `user.cancel` idempotente con `spokenThroughIndex`, replay da log Redis con `resumeFromSeq` (test unitari e con Redis reale), controllo `Origin`, `session.pong`, schemi `tool.confirmation.*`, `avatar.*` (vocabolario TalkingHead), `automation.run.updated`.
- [x] Richieste non autenticate → 401 (verificato); **RLS `FORCE`** su users/sessions/llm_calls/souls con ruolo `ernie_app` (test: B non vede né riusa la sessione di A; senza `app.user_id` nessuna riga); `mastra_*` senza RLS, isolamento per `resource` (limite documentato).
- [x] Limiti hard: `maxSteps` e `maxOutputTokens` per classe, budget giornaliero; `AbortSignal` propagato (test di cancellazione). Token non in cache per turno e stuck detector → M3.

### Verbale di verifica M2 (11 ott 2026)

- `pnpm lint` 0 errori; `pnpm build` ok; `pnpm test` con Postgres (ruolo `ernie_app`) e Redis reali: 15 file, 74/74 test; test online opzionale sul prefisso: superato.
- Migrazioni 0003–0005 applicate; ruolo `ernie_app` con LOGIN; `bootstrap:storage` crea le tabelle `mastra_*` con i grant ereditati.
- End-to-end reale: `admin:create-user` → API locale → client demo WebSocket, due turni nella stessa sessione con `anthropic/claude-sonnet-5.5`: turno 1 "Ciao! Mi chiamo Ernie…" (407 token in, 73 out, 0,001544 $ riportati, TTFT 2,2 s); turno 2 ricorda la domanda precedente (511 in, 37 out, 0,001392 $); 4 messaggi nel thread Mastra; sessione ripresa dalla seconda connessione (seq 6); upgrade senza chiave → 401.
- Docker: immagine ricostruita con i nuovi pacchetti; `migrate` esegue migrazioni + `init-storage`; smoke test ok (vedi commit).
- GitHub Actions: minuti del piano esauriti l'11 ott 2026; la CI non ha potuto girare sugli ultimi commit. Verifica locale completa; workflow ridotto (ignora modifiche ai soli documenti, avvio manuale disponibile).

## M3 — JEV Router ✅

Ambito: `packages/jev-router` (client Decisions API, `MockJevClient`, schema Zod con 7 domande, cache esatta Redis, timeout, fallback), router deterministico, **Policy Engine** in `agent-core`, tabella `router_decisions`.

Criteri:
- [x] Comandi riconosciuti (`/aiuto`, `/stato`, `/classe`, `/contesto`) non chiamano né Jev né LLM (test con contatori; end-to-end ~20 ms, `llmCalls: 0`); decisioni identiche servite dalla cache esatta (test).
- [x] Decisione Jev in una sola chiamata con le sette domande; timeout/errore → fallback tracciato (`source = fallback`, test); **soglie calibrate su 60 esempi etichettati** (`docs/research/06-calibrazione-jev.md`): deep 0,35, memoria 0,75, rischio 0,60; accuratezza bilanciata 91–94%.
- [x] **Policy Engine deny → ask → allow** fail-closed (tool sconosciuto → deny, scope mancante → deny, `denyTools`/`alwaysAsk`), approvazioni in `tool_approvals` legate a (tool, hash argomenti, utente, scadenza) con consumo atomico monouso; eventi `tool.confirmation.*` gestiti dalla connessione. Collegamento ai tool reali in M5.
- [x] **Taint di run** (A.2): `RunContext.markUntrusted` + etichette `readsPrivate`/`ingestsUntrusted`/`externalEffect`/`write`; dopo contenuto non fidato ogni tool `write|external` → `ask` (test). Il test con pagina web reale arriva con Firecrawl in M5.
- [x] **Classe con isteresi di sessione**: `sessions.raiseModelClass` (SQL monotono), salita da Jev (`heavy`/`deep_reasoning`) o da `/classe heavy`, agente ricostruito; `light` rifiutato per la conversazione. End-to-end: richiesta complessa → sessione `heavy` → turno su Opus 5.5.
- [x] **Stuck detector** su hash(tool, argomenti): 3 ripetizioni (8 per tool di polling) → `error.loop_detected` e chiusura del turno (test).
- [x] Metriche in `router_decisions` (source, rotta, classe, flag, rischio, confidenza, token, costo, latenza, modello Jev, risposte grezze) e nell'evento `assistant.completed` (`routerTokens`, costo incluso). Latenza Jev misurata: p50 256 ms, p95 336 ms (timeout 1,5 s confermato).
- [x] Test offline con `MockJevClient`; calibrazione online riproducibile (`calibrate:jev`).

### Verbale di verifica M3 (11 ott 2026)

- `pnpm lint` 0 errori; `pnpm build` ok; `pnpm test` con Postgres (ruolo `ernie_app`) e Redis reali: 18 file, 95 test più 1 online opzionale.
- Migrazione 0006 (`router_decisions`, `tool_approvals`, RLS) applicata.
- Chiamata reale alla Decisions API: forma conforme allo schema, 836 ms la prima, p50 256 ms sulle 60 successive; calibrazione totale 0,0023 $.
- End-to-end con API reale in una sessione: `/stato` e `/contesto cucina` → `route: deterministic`, 0 chiamate, 20–200 ms; "cosa cucino con pasta, uova e guanciale" → Jev (754 token, 0,00003 $, rischio 0,03) → Sonnet 5.5 con il contesto cucina (risposta con tempo di preparazione e ingredienti mancanti, 0,0024 $); "pianifica i pasti della settimana con 60 euro" → `deep_reasoning` sopra soglia → sessione portata a `heavy` → Opus 5.5 (667 token di ragionamento, 0,021 $); `/stato` conferma classe `heavy` e contesto `cucina`; 5 righe coerenti in `router_decisions`.
- Osservazione per M9: un turno `heavy` costa circa 9 volte uno `standard`; l'isteresi tiene la sessione su `heavy` fino alla chiusura. Va misurato se conviene una discesa controllata dopo N turni semplici.

## M4 — Memoria ✅

Realizzato (`packages/memory`, migrazione 0007, worker): tabella `memories` (kind, category, content, tags, `provenance` con `trust`, confidence, status, **`valid_from/valid_to/expired_at`**, `episode_id`, `supersedes_id`, hash, `vector(1536)` HNSW m=16/ef_construction=64, `tsvector` italiano, RLS); ricerca ibrida **top-20 + top-20 con RRF k = 60**; deduplica esatta e semantica (coseno ≥ 0,92); supersessione delle contraddizioni; **snapshot congelato per sessione** (≤ 2.000 caratteri) + tool `memory_search` (A.6); memorie recuperate nel turno utente quando `needs_memory`; episodi deterministici per turno; **consolidamento asincrono** nel worker (coda `memory`, debounce per thread, estrazione strutturata con modello light, cursori); export, oblio, purge con retention; valutazione del recupero (`docs/research/07-valutazione-memoria.md`).

Criteri:
- [x] recall@k su corpus italiano etichettato (30 fatti, 24 domande) con `text-embedding-3-small`: vettoriale 85,4 / 93,7 / 95,8%, ibrido RRF pesato (testo 0,3) 81,2 / 89,6 / 93,7%, full-text in OR 41,7 / 66,7 / 72,9% (in AND era 12,5%); con l'embedder finto l'ibrido a peso 1 fa 60,4 / 68,7 / 77,1% contro 41,7 / 56,3 / 60,4% del solo vettoriale. Scelta: OpenAI + ibrido con peso testo 0,3 (configurabile); fastembed non valutato (download di un modello ONNX: rinviato a M9).
- [x] nessuna chiamata LLM sincrona per operazione di memoria: scrittura, ricerca, episodi e deduplica sono deterministici; l'unica chiamata è l'estrazione asincrona per batch (0,00056 $ misurati).
- [x] contraddizioni gestite con bi-temporalità (`supersedes_id` → `superseded`, `valid_to`), testato anche nel consolidamento.
- [x] memorie da contenuto non fidato: `provenance.trust` e marcatura "(fonte non verificata)" nel contesto; il taint di run per i tool arriva con Firecrawl (M5).
- [x] isolamento per utente con RLS (test: i ricordi di B non compaiono per A).
- [ ] Observational Memory di Mastra in A/B interno (B.4) → rinviato a M9 insieme ai riassunti progressivi (B.10).
- [ ] valutazione su LongMemEval → M9 (serve harness dedicato).

### Verbale di verifica M4 (11 ott 2026)

- `pnpm lint` 0 errori; `pnpm build` ok; `pnpm test`: 20 file, 104 test (più 1 online opzionale), inclusa l'integrazione su Postgres con ruolo `ernie_app`.
- End-to-end con API e worker reali: due turni con fatti personali → il worker consolida dopo 3 s: 4 fatti semantici corretti ("Preferisce essere chiamato Ale" 0,9; "Ha un figlio di nome Leo, che ha dodici anni" 0,9; "Non vuole mai ricette con i funghi" 0,9; "Il sabato mattina fa la spesa e compra sempre il latte intero" 0,6 dedotto) e 2 episodi, tutti con embedding; nuova sessione: "Tuo figlio si chiama Leo, e nelle ricette niente funghi" e "Di solito compri il latte intero, Ale, il sabato mattina"; `needs_memory` vero in tutte le decisioni.
- Cache dei prompt attiva: con Soul + snapshot + tool il prefisso supera i 512 token; secondo turno della nuova sessione con 760 token letti dalla cache, costo 0,0014 $ contro 0,0022 $.
- Spesa cumulativa di sviluppo (spike, calibrazione, prove, valutazioni): circa 0,05 $ (tetto autorizzato: 3 €).

## M5 — Tool e skill ⏳

Ambito: `packages/tools` (registry con JSON Schema 2020-12 strict, `response_format`, paginazione, tetto di token con handle, errori `isError`, idempotency key, etichette di rischio, **set stabile per sessione + `tool_search`/`call_tool`** (A.4), tool `web_search`/`web_fetch` su **Firecrawl**, adapter MCP 2026-07-28 solo Streamable HTTP, conferme via `requireApproval` con storage) (B.5); `packages/skills` (formato agentskills.io, stati `draft→proposed→tested→approved→active→deprecated`, versioni immutabili per hash, scansione alla scrittura e al recupero, eval con/senza skill, pipeline di apprendimento con approvazione) (B.2); **sandbox** come servizio Compose dedicato con gVisor o microVM, senza rete né segreti, limiti di risorse, egress con allowlist (B.1).

Criteri: il modello riceve solo il nucleo stabile + definizioni caricate via meta-tool (test sul payload e sulla stabilità del prefisso); una skill deterministica completa senza chiamate LLM; **test di sicurezza**: injection da pagina Firecrawl reale non attiva tool con side effect (taint → `ask`); codice generato non eseguibile fuori sandbox (test negativo); skill con codice mai attivata automaticamente; suite di regressione delle skill ripetuta su due modelli.

## M6 — Automazioni ⏳

Ambito (B.6): `automations` (versionate, allowlist tool, `budgetUsd` per run, timezone IANA, `catchUp: none|latest`), `automation_runs` con stati `scheduled/claimed/running/succeeded/failed/skipped/budget_exceeded/awaiting_approval` ed esito strutturato; `jobId = automation_id:scheduled_at`; retry con backoff + jitter solo su errori transitori e in un solo livello; dead-letter con alert deduplicato; anti-ricorsione; payload esterni non fidati (run tainted); jitter sugli orari; sessione nuova e prompt autosufficiente per run; notifiche; risultati letti all'apertura dell'app.

Criteri: un'automazione gira e produce un risultato con **nessun client connesso**; retry, dead-letter e storico verificabili; automazione deterministica senza LLM; automazione con ragionamento passa dal router e dal Policy Engine con budget; azione sensibile → `awaiting_approval`; due scheduler concorrenti non duplicano le run (idempotenza testata).

## M7 — App iOS ⏳

Ambito: progetto Xcode SwiftUI in `apps/ios`; autenticazione (Keychain); chat testuale; WebSocket con protocollo v1.1 (porting deduplica/sequenze, snapshot + replay); push-to-talk con `SpeechTranscriber` (controllo `supportedLocales`/`installedLocales`, download asset) e fallback `SFSpeechRecognizer` con **rotazione entro il limite di 1 minuto**; TTS con `AVSpeechSynthesizer`; `.playAndRecord` + **`setVoiceProcessingEnabled(true)`** (A.13); streaming; cronologia e sessioni; APNs; nessuna immagine markdown da URL esterni; step-up Face ID per azioni critiche; kill switch (B.7). **Spike S1** (marker di `speak()`/`write()` con voci italiane) e **S6** (App Thinning Size Report) avviati qui perché toccano il TTS (B.11).

Criteri: l'utente parla, il testo arriva al backend, la risposta viene letta a voce; funziona su device con iOS 26; latenza udibile strumentata per stadio con obiettivo **p50 < 1,5 s** (A.14); esito di S1 documentato.

## M8 — Conversazione vocale avanzata ⏳

Modalità continua **solo in primo piano** (o `AudioRecordingIntent` + Live Activity) con VAD e **fine turno semantico** (spike Smart Turn v3 in Core ML; fallback silenzio 500–800 ms); sintesi incrementale per frasi; **barge-in** = stop locale + `user.cancel` con `spokenThroughIndex`; mute logico del riconoscitore durante la sintesi; contenuti esterni letti con prefisso attributivo; gestione errori audio (B.7). **Spike S3** (WKWebView + TalkingHead su iPhone: FPS, CPU, batteria, termica per 10 minuti, latenza marker→visema, AEC con audio dal WKWebView) eseguito qui; S2 (RealityKit) decaduto con la scelta di TalkingHead.

Criteri: nessuna trascrizione della voce sintetica come input utente in un test registrato; barge-in interrompe entro 300 ms; esito di S3 documentato con misure su dispositivo.

## M9 — Ottimizzazione e hardening ⏳

**Valutazione** (B.8): test deterministici in CI (router, policy, skill, idempotenza); 20–50 scenari da fallimenti reali valutati sullo stato finale; giudice LLM di famiglia diversa calibrato su ~100 esempi; **pass^k (k = 3–5)** per automazioni e azioni sensibili; **benchmark appaiato** router completo vs miglior modello singolo vs economico fisso vs router casuale, con costo reale, cache hit rate e intervalli di confidenza; valore di Jev misurato separatamente su memoria/tool/skill; gate di regressione a ogni cambio. **Hardening** (B.9): TLS (Caddy), backup Postgres, retention e cifratura, rate limiting, Docker secrets, OTel opzionale con semconv fissate; profilazione e latenza TTFT; valutazione TypeScript 7.

Criteri: numeri del benchmark pubblicati nel repo con metodo riproducibile; nessuna affermazione di risparmio non supportata; ripristino da backup provato.

## M10 — Avatar 3D ⏳

Decisione dell'utente (10 ott 2026): **three.js + TalkingHead (MIT) in WKWebView**. Unreal/MetaHuman esclusi (nessun embedding iOS documentato, MetaHuman mobile senza blendshape, lip-sync da audio non a runtime, app "UE-first" rifiutata); RealityKit, Unity, Godot scartati o in attesa (ARCHITECTURE.md §2, §13).

Ambito:
- **Hosting**: `WKWebView` in `UIViewRepresentable`; three.js 0.180, TalkingHead (`@met4citizen/talkinghead`), moduli lingua e avatar GLB nel bundle; ponte `callAsyncJavaScript` / `WKScriptMessageHandler`.
- **Modulo italiano `lipsync-it.mjs`** (classe `LipsyncIt` con `preProcessText` e `wordsToVisemes` → `{ visemes, times, durations }`): G2P a regole in JavaScript (riferimento kokorog2p, Apache-2.0; niente eSpeak NG), normalizzazione di numeri, date e simboli in italiano (spike S4, valutazione contro lessico fonetico).
- **Lip-sync**: `AVSpeechSynthesizer.write()` → PCM + marker di parola → `streamStart({ lipsyncLang: 'it', lipsyncType: 'words' })` + `streamAudio({ audio, words, wtimes, wdurations })`; marker fonemici → `visemes/vtimes/vdurations` se S1 li conferma; variante (A) audio riprodotto dal WKWebView o (B) audio nativo e solo tempi, scelta in S3.
- **Stato ed espressività**: macchina a stati Swift (idle/listening/thinking/speaking) di cui l'avatar è consumatore; barge-in = `stopSpeaking` + `streamInterrupt()`; `avatar.emotion` → `setMood`, `avatar.gesture` → `playGesture`, `avatar.gaze` → `lookAt`, con vocabolario chiuso nel protocollo v1.1.
- **Asset**: GLB di proprietà con rig Mixamo, 52 blendshape ARKit, 15 visemi Oculus (Blender/MPFB o modello custom; Avaturn solo con licenza commerciale); compressione Meshopt; `modelFPS` 30; modalità ridotta (Reduce Motion, termica, basso consumo); primo download < 200 MB.

Criteri: lip-sync intelligibile su un set di frasi italiane di test, giudicato da almeno due persone; sincronia audio–labbra entro ~45 ms; barge-in chiude la bocca entro un frame; FPS ≥ 30 e consumo misurati su iPhone per 10 minuti con stato termico nominale; dimensione dell'app verificata con App Thinning Size Report; nessun codice JavaScript scaricato a runtime.

## R — Ricerca bibliografica ✅

Tre ricercatori (Opus): `docs/research/01-architettura-agenti.md` (133 fonti), `02-buone-prassi-agenti.md` (137 fonti), `04-avatar-3d-ios.md` (64 fonti). Revisore (Fable): `03-revisione.md`, 53 verifiche su fonti primarie (45 confermate, 6 imprecise, 2 non verificabili, 0 false), voti 4–5/5, implicazioni A/B/C integrate in ARCHITECTURE.md v0.2 (§20) e in questo piano. Lacune residue da colmare con spike (03 §4): passthrough OpenRouter, costruzione del payload Mastra, embeddings in italiano, injection via Firecrawl, turn detection on-device, marker fonemici, prestazioni su iPhone, G2P italiano.

## Blocchi e dipendenze esterne

- Chiave Anthropic non disponibile: i modelli Anthropic passano da OpenRouter (chiave presente).
- **Saldo OpenRouter esaurito** (11 ott 2026: 48 $ accreditati, 48,09 $ usati). I test online della M2 richiedono una ricarica; i test offline con mock procedono.
- Chiave Firecrawl non ancora disponibile: necessaria dalla M5.
- Account Apple Developer e dispositivo con iOS 26 necessari dalla M7 (APNs richiede account a pagamento).
- Decisions API di Jev in alpha: monitorare i cambiamenti di contratto.
- Avatar: serve un asset GLB con licenza compatibile con un'app commerciale (Avaturn è gratuito solo per uso non commerciale); la produzione in Blender è lavoro da pianificare in M10.
- Sandbox gVisor/microVM: verificare il supporto del provider VPS (virtualizzazione annidata o kernel compatibile) prima della M5.

## Verbale di verifica M1

Esecuzione locale del 10 ott 2026 (macOS 26.6, Node 26.8, pnpm 11.7, Docker Desktop 29.5):

- `pnpm lint`: 44 file, 0 errori. `pnpm build`: ok. `pnpm test` con `DATABASE_URL`/`REDIS_URL` verso i container: 8 file, 41/41 test.
- `pnpm migrate up`: applicate `0001_extensions.sql` e `0002_users_and_api_keys.sql`; `pnpm migrate status`: 0 pendenti.
- `docker compose build`: immagine `ernie-app:local` da 285 MB. `docker compose up -d --wait api worker`: `migrate` terminato con successo, `api` healthy, `worker` avviato.
- `tests/smoke.sh`: `/health` → `{"status":"ok", "version":"0.1.0", …}`; `/ready` → 200, `checks.postgres.status = ok` (11 ms), `checks.redis.status = ok` (1 ms).
- Worker: log `worker pronto` sulla coda `system`; chiave Redis `ernie:worker:heartbeat` scritta dal job scheduler.
- Nei log del container le credenziali risultano redatte (`[REDACTED]`), inclusa la password nella URL di Postgres.
