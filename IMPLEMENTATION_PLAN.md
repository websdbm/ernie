# Ernie — Piano di implementazione

> Stato aggiornato al 10 ottobre 2026 (allineato ad ARCHITECTURE.md v0.2: le voci A.x/B.x/C.x rimandano a `docs/research/03-revisione.md` §5). Ogni milestone ha criteri di accettazione verificabili; non si passa alla successiva finché la corrente non è verificata (lint, typecheck, test, e dove previsto Docker e smoke test).

Legenda: ✅ completata · 🔧 in corso · ⏳ pianificata · ⚠️ bloccata/da chiarire

## Riepilogo

| Milestone | Obiettivo | Stato |
|---|---|---|
| M1 | Fondamenta: monorepo, TypeScript, Fastify, PostgreSQL, Docker Compose, health check, test, CI | ✅ |
| M2 | Agente minimo: Mastra, Soul, sessioni, un provider, streaming, persistenza | ⏳ |
| M3 | JEV Router: adapter, routing deterministico, schema decisione, fallback, metriche | ⏳ |
| M4 | Memoria: semantica, episodica, ricerca ibrida, consolidamento asincrono | ⏳ |
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

## M2 — Agente minimo ⏳

Ambito: `packages/agent-core`, `packages/soul`, `packages/model-gateway`; `apps/api` con WebSocket (`@fastify/websocket`), autenticazione con chiave API (hash in `api_keys`), sessioni (Mastra threads), streaming via eventi v1/v1.1; persistenza conversazioni (`PostgresStore`); tabelle `souls`/`soul_versions`, `llm_calls`; primo set di policy RLS.

Criteri di accettazione:
- [ ] `session.start` + `user.message` producono `assistant.started`, `assistant.text.delta`*, `assistant.text.completed`, `assistant.completed` con `usage` reale del provider.
- [ ] **Prefisso stabile** (A.3): ordine fisso tool → Core Soul → snapshot → riassunto → turni → messaggio; parti variabili in coda; JSON deterministico; `cache_control` sul blocco stabile; test che due turni consecutivi producano lo stesso prefisso byte-per-byte.
- [ ] **Spike passthrough OpenRouter** (03 §4): richieste reali con lettura di `cached_tokens`/`cache_write_tokens`; verifica di quali feature native sopravvivono; log del payload costruito da Mastra (ordine tool, posizione `instructions`); esito documentato in `docs/research/00-fonti-verificate.md`. Se l'ordine non è controllabile: assemblaggio proprio, Mastra per storage/memoria/tool.
- [ ] Core Soul ≤ 400 token verificato da test; Context Soul scelto a livello di sessione (A.6).
- [ ] Mappa classi → modelli risolta da `GET https://openrouter.ai/api/v1/models` e salvata in configurazione; `session_id` OpenRouter = sessione Ernie.
- [ ] **`llm_calls`** con `cost_reported`, `cost_estimated`, `cost_source`, token input/cache read/cache write/output/reasoning, TTFT, latenza (A.8); test contro i doppi conteggi.
- [ ] **Protocollo v1.1** (A.9–A.10): `persist`, `user.cancel` idempotente con `spokenThroughIndex`, snapshot + replay con `resumeFromSeq`, controllo `Origin` sull'upgrade, nessuna connessione verso URL da deep link; schemi `avatar.emotion/gesture/gaze` con vocabolario chiuso e test.
- [ ] Richieste non autenticate → 401; dati filtrati per `user_id`; **RLS `FORCE`** sulle tabelle proprie con ruolo applicativo non owner (A.12), verifica su `mastra_*`.
- [ ] Limiti hard: step, token non in cache, costo per turno; `AbortSignal` propagato (A.7).

## M3 — JEV Router ⏳

Ambito: `packages/jev-router` (client Decisions API, `MockJevClient`, schema Zod con 7 domande, cache esatta Redis, timeout, fallback), router deterministico, **Policy Engine** in `agent-core`, tabella `router_decisions`.

Criteri:
- [ ] Richieste con comando riconosciuto o in cache esatta non chiamano né Jev né LLM (contatore di chiamate).
- [ ] Decisione Jev valida in una sola chiamata; timeout → fallback deterministico tracciato (`source = fallback`); **soglie per domanda** tarate su un set etichettato iniziale (≥ 50 esempi), mai 0,5 di default (A.11).
- [ ] **Policy Engine deny → ask → allow** fuori dall'LLM, fail-closed per tool sconosciuti; approvazioni legate a (tool, hash argomenti, utente, scadenza), monouso e consumate atomicamente; audit append-only (A.1). Test: approvazione riusata → deny; tool sconosciuto → deny.
- [ ] **Taint di run** (A.2): tool etichettati `readsPrivate`/`ingestsUntrusted`/`externalEffect`; dopo contenuto non fidato ogni tool `write|external` passa in `ask`. Test con un risultato web che "ordina" un'azione.
- [ ] **Classe con isteresi di sessione** (A.5): sale, non scende; `light` mai per turni conversazionali.
- [ ] **Stuck detector** su hash(tool, argomenti, esito) con soglie per tool di polling (A.7).
- [ ] Metriche: costo Jev per richiesta, confidenza, tasso di fallback, hit rate cache, latenza (per ritarare il timeout).
- [ ] Test offline con mock; test online opzionale con `OPENROUTER_API_KEY`.

## M4 — Memoria ⏳

Ambito: `packages/memory`: tabella `memories` (kind, content, embedding `vector(1536)`, `tsvector`, `provenance` con `trust`, scope, confidence, status, **`valid_from/valid_to/created_at/expired_at`**, FK all'episodio), ricerca ibrida **top-20 + top-20 con RRF k = 60**, HNSW `m = 16`/`ef_construction = 64`, chunk con prefisso contestuale da `light`; deduplica; supersessione dei fatti; cancellazione, export e retention; **snapshot congelato per sessione** (1–3k caratteri) + tool `memory_search` (A.6); **compressione a gradini** (clearing/masking → riassunto) allineata ai confini di cache (B.10); job del worker per estrazione e consolidamento; scelta embeddings con misura.

Criteri: recall@k su corpus italiano etichettato per OpenAI 1536 vs fastembed 384; valutazione su **LongMemEval S/M** e golden set (non LoCoMo); nessuna chiamata LLM sincrona per operazione di memoria; contraddizioni gestite con bi-temporalità; memorie da contenuto non fidato contano come gamba [A] del taint; isolamento per utente testato con RLS; Observational Memory di Mastra in A/B interno (B.4).

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

- Chiave Anthropic non disponibile: i modelli Anthropic passano da OpenRouter (chiave presente). Nessun blocco.
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
