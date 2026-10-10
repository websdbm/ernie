# Ernie — Piano di implementazione

> Stato aggiornato al 10 ottobre 2026. Ogni milestone ha criteri di accettazione verificabili; non si passa alla successiva finché la corrente non è verificata (lint, typecheck, test, e dove previsto Docker e smoke test).

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
| M10 | Avatar 3D: valutazione motori (Unreal o equivalenti), spike, integrazione | ⏳ |
| R | Ricerca bibliografica (3 ricercatori + revisore) e integrazione nei documenti | 🔧 |

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

Ambito: `packages/agent-core`, `packages/soul`, `packages/model-gateway`; `apps/api` con WebSocket (`@fastify/websocket`), autenticazione con chiave API (hash in `api_keys`), sessioni (Mastra threads), streaming testuale via eventi v1; persistenza conversazioni in Postgres (`PostgresStore`); tabelle `souls`/`soul_versions`, `llm_calls`.

Criteri di accettazione:
- [ ] `session.start` + `user.message` producono `assistant.started`, `assistant.text.delta`*, `assistant.text.completed`, `assistant.completed` con `usage` reale del provider.
- [ ] Core Soul ≤ 400 token verificato da test; Context Soul caricato per tag.
- [ ] Mappa classi → modelli risolta da `GET https://openrouter.ai/api/v1/models` e salvata in configurazione (nessun ID ipotizzato).
- [ ] Riconnessione con `resumeFromSeq` rinvia gli eventi mancanti; `user.cancel` interrompe lo stream (`assistant.cancelled`).
- [ ] Ogni chiamata LLM registrata in `llm_calls` con token, costo stimato/effettivo, latenza, modello.
- [ ] Richieste non autenticate → 401; dati filtrati per `user_id`.

## M3 — JEV Router ⏳

Ambito: `packages/jev-router` (client Decisions API, `MockJevClient`, schema Zod, cache Redis, timeout, fallback), router deterministico in `agent-core`, Policy Engine, tabella `router_decisions`.

Criteri: 
- [ ] Richieste con comando riconosciuto o risposta in cache non chiamano né Jev né LLM (test con contatore di chiamate).
- [ ] Decisione Jev valida in una sola chiamata con le sei domande; timeout → fallback deterministico tracciato (`source = fallback`).
- [ ] Policy Engine degrada decisioni non autorizzate (test: tool non consentito → eseguito senza tool).
- [ ] Metriche: costo Jev per richiesta, confidenza, tasso di fallback, hit rate cache.
- [ ] Test offline con mock; test online opzionale con `OPENROUTER_API_KEY`.

## M4 — Memoria ⏳

Ambito: `packages/memory`: tabella `memories` (kind, content, embedding `vector(1536)`, `tsvector`, provenance, scope, confidence, status, validità), ricerca ibrida con RRF, deduplica, supersessione dei fatti, cancellazione; job del worker per estrazione in batch e consolidamento con modello `light`; riassunti progressivi; scelta embeddings (OpenAI vs fastembed) con misura.

Criteri: recupero pertinente in test con corpus etichettato; nessuna chiamata LLM sincrona per operazione di memoria; contraddizioni gestite con versioning; isolamento per utente testato.

## M5 — Tool e skill ⏳

Ambito: `packages/tools` (registry, categorie, permessi, timeout/retry, audit, selezione dinamica, tool `web_search`/`web_fetch` su Firecrawl, adapter MCP opzionale), `packages/skills` (skill deterministiche, skill guidate, pipeline di apprendimento con sandbox e approvazione), conferme per azioni sensibili (protocollo v1.1).

Criteri: il modello riceve solo i tool pertinenti (test sul payload); una skill deterministica completa senza chiamate LLM; test di sicurezza: prompt injection da risultato web non attiva tool con side effect; codice generato non eseguibile fuori sandbox.

## M6 — Automazioni ⏳

Ambito: `packages/automations` + worker: definizioni versionate, cron/one-shot/webhook/eventi, idempotenza, retry/backoff, dead-letter, `automation_runs`, notifiche.

Criteri: un'automazione gira e produce un risultato con **nessun client connesso**; retry e storico verificabili; automazione deterministica senza LLM; automazione con ragionamento passa dal router con budget.

## M7 — App iOS ⏳

Ambito: progetto Xcode SwiftUI in `apps/ios`; autenticazione (Keychain); chat testuale; WebSocket con protocollo v1 (porting deduplica/sequenze); push-to-talk con `SpeechTranscriber` (fallback `SFSpeechRecognizer`); TTS con `AVSpeechSynthesizer`; streaming; cronologia e sessioni; APNs.

Criteri: l'utente parla, il testo arriva al backend, la risposta viene letta a voce; funziona su device con iOS 26; controllo runtime di `supportedLocales`.

## M8 — Conversazione vocale avanzata ⏳

Modalità continua in primo piano con turni; sintesi incrementale per frasi; barge-in; gestione eco (`.voiceChat`, mute logico del riconoscitore durante la sintesi); gestione errori audio.

## M9 — Ottimizzazione e hardening ⏳

Benchmark routing vs modello fisso (token, costo, latenza, qualità) su corpus rappresentativo; cache risposte; profilazione; latenza primo token; test e2e; TLS (Caddy), backup Postgres, retention e cifratura, rate limiting, OpenTelemetry opzionale; valutazione TypeScript 7.

## M10 — Avatar 3D ⏳

Valutazione comparativa (Unreal Engine 5 su iOS/MetaHuman, Unity as a Library, Godot, RealityKit nativo, web) su integrazione SwiftUI, peso, licenza, lip-sync con TTS on-device; spike con due candidati; eventi `avatar.*` nel protocollo; integrazione nell'app. Dipende dagli esiti di `docs/research/04-avatar-3d-ios.md`.

## R — Ricerca bibliografica 🔧

Tre ricercatori (Opus): architettura degli agenti (`docs/research/01`), buone prassi operative (`02`), avatar 3D su iOS (`04`); un revisore (Fable) valuta i report (`03`) e produce le implicazioni per l'architettura, integrate in ARCHITECTURE.md v0.2 e in questo piano.

## Blocchi e dipendenze esterne

- Chiave Anthropic non disponibile: i modelli Anthropic passano da OpenRouter (chiave presente). Nessun blocco.
- Chiave Firecrawl non ancora disponibile: necessaria dalla M5.
- Account Apple Developer e dispositivo con iOS 26 necessari dalla M7 (APNs richiede account a pagamento).
- Decisions API di Jev in alpha: monitorare i cambiamenti di contratto.

## Verbale di verifica M1

Esecuzione locale del 10 ott 2026 (macOS 26.6, Node 26.8, pnpm 11.7, Docker Desktop 29.5):

- `pnpm lint`: 44 file, 0 errori. `pnpm build`: ok. `pnpm test` con `DATABASE_URL`/`REDIS_URL` verso i container: 8 file, 41/41 test.
- `pnpm migrate up`: applicate `0001_extensions.sql` e `0002_users_and_api_keys.sql`; `pnpm migrate status`: 0 pendenti.
- `docker compose build`: immagine `ernie-app:local` da 285 MB. `docker compose up -d --wait api worker`: `migrate` terminato con successo, `api` healthy, `worker` avviato.
- `tests/smoke.sh`: `/health` → `{"status":"ok", "version":"0.1.0", …}`; `/ready` → 200, `checks.postgres.status = ok` (11 ms), `checks.redis.status = ok` (1 ms).
- Worker: log `worker pronto` sulla coda `system`; chiave Redis `ernie:worker:heartbeat` scritta dal job scheduler.
- Nei log del container le credenziali risultano redatte (`[REDACTED]`), inclusa la password nella URL di Postgres.
