# Ernie — Architettura tecnica

> Stato: v0.1 (10 ottobre 2026). Documento vivo: viene aggiornato a ogni milestone e dopo l'integrazione della ricerca bibliografica (`docs/research/`).

## 1. Scopo e principi

Ernie è un agente AI personale **persistente**: identità configurabile (Soul), memoria a più livelli, tool e skill, automazioni, routing decisionale e un client iOS nativo con interazione vocale. Il backend risiede su una VPS in container Docker; l'agente può cercare in internet, usare tool, ricordare.

Principi non negoziabili:

1. **Deterministico prima, LLM dopo.** Ogni richiesta attraversa prima codice deterministico (comandi, procedure note, cache). Un LLM interviene solo dove serve intelligenza.
2. **Scala di escalation.** Le richieste salgono di livello solo se necessario: deterministico → skill → modello *light* → *standard* → *heavy* con ragionamento esteso. La decisione è presa da un modello decisionale non generativo (Jev) e da regole, mai da un LLM generativo che "sceglie se stesso".
3. **Budget di token come requisito architetturale.** Prompt core compatto, contesto assemblato con budget, retrieval selettivo, tool discovery dinamico, riassunti progressivi, cache. Ogni richiesta è misurata (token, costo, latenza, chiamate).
4. **La sicurezza non è delegata ai modelli.** Autorizzazioni, isolamento utenti, conferme per azioni sensibili e sandbox del codice generato sono controlli deterministici che nessuna decisione di Jev o di un LLM può aggirare.
5. **Monolite modulare.** Un'unica base di codice TypeScript con pacchetti a responsabilità singola e interfacce tipizzate; due processi (API e worker) che condividono le stesse librerie. Nessun microservizio finché non c'è una ragione misurabile.

## 2. Vincoli verificati e decisioni chiave

Le verifiche sono datate 10 ottobre 2026; fonti in `docs/research/00-fonti-verificate.md`.

| Tema | Decisione | Alternativa scartata | Motivazione |
|---|---|---|---|
| Router decisionale | **Jev (TypeSafe) via OpenRouter Decisions API** (`POST /api/alpha/decisions`, modello `typesafe/jev-1.13`, alias `~typesafe/jev-latest`) | Classificatore con LLM generativo | Jev è un *decision model* non generativo: risposte tipizzate (`choice`, `noul`, `score`) con probabilità e confidenza, input ≈ $0,042/M token, output gratuito, nessun testo da parsare. Rischio: API in **alpha**; mitigato con adapter isolato, mock e fallback deterministico. |
| Framework agentico | **Mastra 1.x** (`@mastra/core` 1.75, `@mastra/pg` 1.30, `@mastra/memory` 1.36) | LangGraph, Agents SDK | Richiesto; nativo TypeScript; Agent con `instructions`/`model`/`tools` dinamici per richiesta; Memory con storage Postgres e PgVector; hook `beforeToolCall`/`afterToolCall`; streaming con usage. Richiede Node ≥ 22.13 e Zod 3.25+/4. |
| Model Gateway | **Model router di Mastra** (`provider/model`, 200+ provider, credenziali da env, endpoint OpenAI-compatibili custom) come percorso primario; **LiteLLM come profilo Docker opzionale** | LiteLLM obbligatorio in mezzo a ogni chiamata | Un proxy aggiunge un container, un database e un salto di rete, e appiattisce le opzioni native dei provider (thinking adattivo, effort, cache dei prompt). Il cost tracking per richiesta lo facciamo comunque internamente (sez. 12). LiteLLM resta disponibile per chi vuole budget e virtual key centralizzati. |
| Provider LLM iniziali | **OpenRouter** (chiave disponibile) per i modelli di chat; **OpenAI** (chiave disponibile) per gli embeddings `text-embedding-3-small`; Anthropic diretto se verrà fornita una chiave | — | Le classi di modello (sez. 11) sono configurazione: gli ID concreti vengono risolti nella M2 interrogando `GET https://openrouter.ai/api/v1/models`, non ipotizzati. |
| Ricerca web | **Firecrawl** (search v2 + scrape, SDK `firecrawl`) | SearXNG self-hosted, API dei motori, ricerca nativa del provider | Richiesto dall'utente; un solo servizio per ricerca ed estrazione in markdown, costi per credito prevedibili. Rischio: dipendenza esterna; mitigata da interfaccia `WebSearchProvider` sostituibile. |
| Linguaggio/toolchain | TypeScript **5.9** (non 7.0), Node **24 LTS** in container (26 in locale), pnpm 11, Biome 2, Vitest 5 | TypeScript 7 (compilatore nativo) | TS 7 è appena uscito; l'ecosistema (Mastra, tipi Fastify) è testato su 5.x. Migrazione valutabile nella M9. |
| API HTTP/WS | **Fastify 5** con rotte proprie; `@mastra/fastify` **non** montato | `MastraServer` di `@mastra/fastify` | Il server Mastra espone una superficie generica (agenti, workflow, OpenAPI) che non vogliamo esporre a Internet; le nostre rotte restano minime e sotto la nostra autenticazione. Riconsiderabile per strumenti interni. |
| Database | PostgreSQL 17 + **pgvector** (immagine `pgvector/pgvector:pg17`), migrazioni SQL versionate con runner proprio (checksum, advisory lock) | ORM (Drizzle) dal giorno 1 | Mastra crea e migra da sé le proprie tabelle (`mastra_*`); per le nostre tabelle bastano SQL espliciti e query tipizzate. Un query builder verrà introdotto solo se la complessità lo giustifica (M4). |
| Code e job | **BullMQ 6** su Redis 8 (AOF attivo) | Cron di sistema, Temporal | Richiesto; job scheduler per cron, ritardi, retry/backoff, storico; connessione ioredis con `maxRetriesPerRequest: null` per i worker. |
| Speech iOS | **SpeechAnalyzer/SpeechTranscriber** (iOS 26+, on-device, italiano incluso al lancio) con fallback **SFSpeechRecognizer**; **AVSpeechSynthesizer** per il TTS | STT/TTS cloud | Richiesto: l'audio resta sul dispositivo; verso il backend viaggiano testo ed eventi. Ascolto continuo illimitato in background **non** garantito da iOS: la modalità continua è prevista solo in primo piano. |
| Protocollo | Eventi JSON versionati (`v: 1`) con `id`, `sessionId`, `correlationId`, `seq`, `ts` su **WebSocket** (SSE come ripiego) | gRPC | Semplicità lato Swift, riconnessione con `resumeFromSeq`, deduplica per `id`, ordinamento per `seq`. |

## 3. Vista d'insieme

```
 iOS (SwiftUI)                         VPS (Docker Compose)
 ┌──────────────────────┐              ┌─────────────────────────────────────────────────────────┐
 │ Speech→Text (device) │  WebSocket   │  api (Fastify)                                            │
 │ Text→Speech (device) │◀────────────▶│  ┌───────────────┐  ┌──────────────────┐  ┌────────────┐ │
 │ Avatar 3D (M10)      │  eventi v1   │  │ Session Mgr   │─▶│ Deterministic    │─▶│ JEV        │ │
 │ Keychain · APNs      │              │  │ + Auth        │  │ Context Router   │  │ Decision   │ │
 └──────────────────────┘              │  └───────────────┘  └──────────────────┘  │ Router     │ │
                                       │          │                    │            └─────┬──────┘ │
                                       │          ▼                    ▼                  ▼        │
                                       │  ┌─────────────────────────────────────────────────────┐ │
                                       │  │ Agent Runtime (Mastra Agent)                        │ │
                                       │  │  Soul Engine · Memory Engine · Tool Registry ·      │ │
                                       │  │  Skill Executor · Model Gateway · Policy Engine     │ │
                                       │  └─────────────────────────────────────────────────────┘ │
                                       │          │ usage/costi/eventi                            │
                                       │          ▼                                               │
                                       │  Observability (Postgres: llm_calls, request_metrics)    │
                                       ├─────────────────────────────────────────────────────────┤
                                       │  worker (BullMQ)  consolidamento memoria · automazioni · │
                                       │                   notifiche APNs · job di sistema        │
                                       ├─────────────────────────────────────────────────────────┤
                                       │  postgres (pgvector) · redis (AOF) · [litellm opz.]      │
                                       └─────────────────────────────────────────────────────────┘
```

## 4. Moduli e responsabilità

Ogni modulo è un pacchetto del monorepo con interfacce esportate e dipendenze minime (nessun ciclo). Stato: ✅ realizzato · 🔧 in corso · ⏳ pianificato (milestone tra parentesi).

| # | Modulo | Pacchetto | Responsabilità | Stato |
|---|---|---|---|---|
| 1 | API Gateway & Session Manager | `apps/api` | HTTP/WS, autenticazione client, sessioni, rate limit, dispatch eventi | ✅ health/ready · ⏳ WS/auth (M2) |
| 2 | Deterministic Context Router | `packages/agent-core` | Comandi riconosciuti, procedure note, cache risposte, pre-filtri; decide se chiamare Jev | ⏳ M3 |
| 3 | JEV Decision Router | `packages/jev-router` | Adapter Decisions API, schema decisione Zod, cache, timeout, fallback, metriche | ⏳ M3 |
| 4 | Agent Runtime | `packages/agent-core` | Assemblaggio contesto con budget, esecuzione Mastra Agent, limiti di step, loop detection, cancellazione | ⏳ M2 |
| 5 | Soul Engine | `packages/soul` | Core/Context Soul e policy, versionamento, caricamento selettivo | ⏳ M2 |
| 6 | Memory Engine | `packages/memory` | 4 livelli di memoria, ricerca ibrida, consolidamento asincrono | ⏳ M4 |
| 7 | Tool Registry & Executor | `packages/tools` | Catalogo tool, selezione per categoria, permessi, timeout/retry, audit, adapter MCP | ⏳ M5 |
| 8 | Skill Registry & Executor | `packages/skills` | Skill deterministiche e guidate, pipeline di apprendimento con isolamento e approvazione | ⏳ M5 |
| 9 | Automation Engine | `packages/automations` + `apps/worker` | Cron, one-shot, webhook, eventi, idempotenza, storico, notifiche | ⏳ M6 (skeleton worker ✅) |
| 10 | Model Gateway | `packages/model-gateway` | Classi di modello → provider/ID, opzioni per provider, prezzi, embeddings | ⏳ M2 |
| 11 | Observability & Cost Tracking | `packages/observability` | Logging strutturato con redazione, ID di correlazione, metriche per richiesta, costi | ✅ logger · ⏳ metriche (M2–M3) |
| 12 | iOS Client | `apps/ios` | SwiftUI, voce, streaming, sessioni, notifiche, avatar 3D | ⏳ M7–M8, M10 |
| — | Protocollo | `packages/protocol` | Schemi Zod degli eventi v1, deduplica, sequenze | ✅ |
| — | Configurazione | `packages/config` | Schema Zod delle variabili d'ambiente, config tipizzata e redatta | ✅ |
| — | Database | `packages/db` | Pool `pg`, health, runner migrazioni + CLI | ✅ |

### Interfacce principali (contratti tra moduli)

```ts
// Decisione del router (packages/jev-router) — validata con Zod
interface RouteDecision {
  route: 'deterministic' | 'skill' | 'llm';
  modelClass: 'light' | 'standard' | 'heavy';
  deepReasoning: boolean;        // effort alto / thinking esteso
  needsMemory: boolean;
  toolCategories: string[];      // es. ['web_search', 'calendar']; [] = nessun tool
  skillId: string | null;        // skill nota da eseguire
  confidence: number;            // 0..1, dal router
  source: 'deterministic' | 'jev' | 'cache' | 'fallback';
  costUsd: number;               // costo della decisione (usage.cost di Jev)
}

// Contesto assemblato con budget (packages/agent-core)
interface AssembledContext {
  system: string;                // Core Soul + Context Soul + policy applicabili
  memories: MemoryHit[];         // recupero selettivo, già compresso
  tools: ToolDefinition[];       // solo i tool pertinenti
  history: Message[];            // finestra + riassunto progressivo
  budget: { maxInputTokens: number; usedTokens: number };
}

// Esito misurato di una richiesta (packages/observability)
interface RequestMetrics {
  requestId: string; sessionId: string; userId: string;
  route: RouteDecision['route']; model?: string; modelClass?: string;
  inputTokens: number; outputTokens: number; reasoningTokens?: number; cachedInputTokens?: number;
  routerTokens: number; memoryTokens: number;
  llmCalls: number; toolCalls: number;
  costUsdEstimated: number; costUsdActual?: number;
  latencyMs: number; firstTokenMs?: number;
}
```

## 5. Flusso di una richiesta e scala di escalation

1. **Ingresso.** `user.message` arriva via WS; il Session Manager autentica, assegna `correlationId`, persiste il messaggio (Mastra thread) ed emette `assistant.started` appena decisa la rotta.
2. **Router deterministico.** Normalizza il testo; riconosce comandi (`/`, parole chiave registrate), procedure già consolidate (procedural memory con match esatto/fuzzy `pg_trgm`), e risposte in cache. Se risolve, risponde **senza alcun modello** (`route = deterministic`, 0 token).
3. **Jev.** Altrimenti costruisce uno `state` compatto (testo utente, ultimi turni riassunti, categorie di tool disponibili, skill candidate dal retrieval, flag di sessione) e pone in **una sola chiamata** le domande tipizzate (sez. 6). Timeout 1,5 s; cache delle decisioni per hash del testo normalizzato + fingerprint del contesto (TTL breve). In caso di timeout/errore: fallback a regole (classe `standard`, memoria attiva, nessun tool) e metrica `source = fallback`.
4. **Policy Engine.** Applica deterministicamente autorizzazioni e budget: una decisione di Jev che chiede un tool non autorizzato per l'utente o una classe oltre il budget viene **degradata**, mai eseguita.
5. **Esecuzione.** `route = skill` → Skill Executor (deterministico quando possibile). `route = llm` → Agent Runtime assembla il contesto con budget e invoca il Mastra Agent con `model` della classe scelta, `tools` filtrati per categoria, `instructions` dal Soul Engine, memoria in base a `needsMemory`. Limite di step configurabile, rilevamento di loop (stessa chiamata tool ripetuta N volte → stop), cancellazione via `AbortSignal`.
6. **Streaming.** I delta di testo diventano `assistant.text.delta`; i tool emettono `tool.started/completed`; alla fine `assistant.completed` con `usage`.
7. **Post-elaborazione asincrona (worker).** Estrazione di fatti/episodi in batch con un modello *light*, deduplica, consolidamento; nessuna chiamata LLM sincrona per la memoria.

**Scala di escalation** (dal più economico): deterministico → skill deterministica → `light` (riformulazioni, estrazioni, risposte brevi) → `standard` (conversazione con tool) → `heavy` (ragionamento esteso, pianificazione multi-step, `deepReasoning = true`). Jev decide il gradino; la policy può solo abbassarlo. Dalla M9 un benchmark confronta questa scala con un modello fisso (sez. 17).

## 6. JEV Decision Router

### Fatti verificati (ottobre 2026)

- Jev è il primo "System One decision model" di TypeSafe. Non è un LLM: prende uno `state` testuale e domande tipizzate, restituisce **solo** valori tra quelli definiti dal chiamante con probabilità; niente tracce di ragionamento né testo libero.
- Accesso: **Decisions API** `POST https://openrouter.ai/api/alpha/decisions` (HTTP o SDK OpenRouter: `@openrouter/sdk` → `openRouter.alpha.decisions.create({ decisionsRequest })`) oppure **System One API** `POST https://openrouter.ai/api/v1/systemone` (per chi usa gli SDK TypeSafe). Autenticazione: `Authorization: Bearer <OPENROUTER_API_KEY>`.
- Richiesta: `{ model, state: object, questions: { [nome]: { type: 'noul' | 'choice' | 'score', instructions, criteria } } }`. `noul` → `criteria: { true, false }`; `choice` → `criteria: { opzione: descrizione }`; `score` → `criteria: string[]` ordinato.
- Risposta: `{ id, model, provider, answers: { [nome]: … }, usage: { input_tokens, output_tokens, cost } }`. `noul` restituisce `noul` (P(sì)); `choice` restituisce `choice`, `probabilities`, `confidence`; `score` restituisce `score`, `probabilities`, `legend`, `confidence`.
- Le domande della stessa richiesta sono indipendenti e parallele (non vedono le risposte reciproche). Contesto 32k token (state + domande). Prezzo (OpenRouter, 21 set 2026): $0,042/M token input, output gratuito; pinnare `typesafe/jev-1.13` per soglie stabili.
- Esiste anche `typesafe/jev-router`, un router di modelli OpenAI-compatibile basato su Jev che sceglie modello ed effort per richiesta. **Non** lo usiamo come percorso primario: sceglie solo tra modelli OpenRouter e non decide memoria/tool/skill; resta un candidato per il benchmark della M9.
- Un plugin Hermes `jev-model-router` e il sito jevai.org esistono ma sono progetti terzi/non ufficiali: non sono riferimenti per l'integrazione.

### Schema di decisione

Una chiamata, sei domande (nomi stabili per cache e metriche):

| Domanda | Tipo | Criteri |
|---|---|---|
| `route` | choice | `deterministic` (risposta nota/convenevole), `skill` (procedura esistente), `llm` (serve generazione) |
| `model_class` | choice | `light`, `standard`, `heavy` con descrizioni delle capacità richieste |
| `deep_reasoning` | noul | serve pianificazione/analisi multi-passo |
| `needs_memory` | noul | la risposta dipende da fatti personali o storici |
| `tool_category` | choice | `none` + categorie attive del registry (es. `web_search`, `calendar`, `files`) |
| `skill_candidate` | choice | `none` + fino a 5 skill candidate dal retrieval deterministico |

Le risposte vengono validate con Zod e convertite in `RouteDecision`. Soglie di confidenza configurabili e tarate su dati etichettati (M9), non su numeri tondi: sotto soglia si sceglie il gradino più sicuro (es. `standard` invece di `light`).

### Garanzie

- **Timeout e fallback** deterministici; **cache** delle decisioni (Redis, TTL ~10 min, chiave = hash di testo normalizzato + fingerprint contesto); **metriche**: token, costo (`usage.cost`), latenza, `source`, tasso di fallback.
- **Mock tipizzato** (`JevClient` con implementazione `MockJevClient`) per test e per ambienti senza chiave; stesso schema di risposta.
- **Nessun bypass** delle autorizzazioni: la decisione è un suggerimento che il Policy Engine può solo restringere.
- **Rischio API alpha**: l'adapter è l'unico punto che conosce l'endpoint; un cambiamento di contratto si isola lì.

## 7. Soul Engine

- **Core Soul** (≤ 400 token, sempre presente): identità, tono, lingua, regole irrinunciabili.
- **Context Soul** (per tag, caricati su richiesta): comportamenti per dominio (lavoro, casa, programmazione…), selezionati deterministicamente da tag della sessione/richiesta o dalla `tool_category` di Jev.
- **Operational Policies** (per situazione): regole su conferme, privacy, formato risposte vocali (frasi brevi, niente markdown quando `inputMode = voice`).
- Persistenza: tabelle `souls` (id, kind, tags, content, token_count) e `soul_versions` (storico immutabile, autore, motivo). Modifica solo tramite API autenticata o file di configurazione versionato; **nessun tool** dell'agente può scrivere il Soul. Separato dalla memoria: il Soul descrive *chi è* Ernie, la memoria *cosa sa*.
- Il Soul entra nelle `instructions` dinamiche del Mastra Agent (funzione del `requestContext`), con conteggio token verificato in test (budget rispettato).

## 8. Memory Engine

Quattro livelli, tutti con metadati di provenienza, ambito (`user_id`, `scope`), data, confidenza e stato.

| Livello | Dove | Cosa | Note |
|---|---|---|---|
| Conversazionale | Mastra threads/messages (Postgres) | Cronologia completa; finestra con `messageHistory.maxTokens`; riassunti progressivi | Riassunto generato dal worker con modello *light* quando la finestra supera il budget |
| Semantica | `memories` (kind=`semantic`) | Fatti, preferenze, progetti, relazioni | Embedding `vector(1536)` + `tsvector`; ricerca ibrida con Reciprocal Rank Fusion |
| Episodica | `memories` (kind=`episodic`) + `audit_log` | Operazioni eseguite, errori/correzioni, esiti, provenienza | Scritta deterministicamente dal runtime (nessun LLM) |
| Procedurale | `skills`, `procedures` | Procedure consolidate, skill apprese, workflow | Alimenta il router deterministico e `skill_candidate` |

Regole: deduplica per hash normalizzato e similarità coseno sopra soglia; aggiornamento dei fatti con `valid_from/valid_to` (le contraddizioni non sovrascrivono: la nuova versione supersede la vecchia e conserva la provenienza); cancellazione su richiesta (`status = deleted`, purge con retention); consolidamento asincrono in batch (worker) con un modello *light*, mai una chiamata LLM per singola operazione. Il recupero è selettivo: `topK` piccolo, soglia di punteggio, compressione dei risultati prima dell'inserimento nel contesto. Embeddings: `text-embedding-3-small` (OpenAI, 1536 dim) con alternativa locale `@mastra/fastembed` da valutare nella M4 (costo zero, 384 dim).

## 9. Tool Registry e Skill

**Tool**: `id@version`, descrizione ≤ 1 frase, schema input/output Zod, `category`, `permissions` (scope richiesti), `timeout`, `retry`, `cost` (stima), `sideEffects` (`none | read | write | external`). Il modello riceve **solo** i tool delle categorie decise dal router (più una ricerca BM25 sulle descrizioni per richieste ambigue), mai il catalogo intero. Ogni chiamata è registrata in `audit_log` (chi, cosa, argomenti redatti, esito, durata). Azioni con `sideEffects = write | external` oltre una soglia richiedono conferma esplicita (`tool.started` con `requiresConfirmation` nel protocollo v1.1).

**Ricerca web** è una categoria di prima classe (`web_search`, `web_fetch`): l'agente in container deve poter cercare in internet. Provider scelto: **Firecrawl** (API v2: `POST https://api.firecrawl.dev/v2/search` con `scrapeOptions` per ottenere direttamente il markdown delle pagine; scrape/crawl per il `web_fetch`; SDK Node `firecrawl`; costo 2 crediti per 10 risultati + 1 credito per pagina estratta, verificato il 10 ott 2026). I tool `web_search` e `web_fetch` incapsulano l'SDK con limiti configurabili (`limit` basso, timeout, dominio incluso/escluso) e compressione dei risultati prima dell'inserimento nel contesto; i contenuti web sono trattati come **dati non fidati** (sez. 15). Chiave: `FIRECRAWL_API_KEY`.

**MCP**: adapter opzionale tramite `@mastra/mcp` per server esterni; i tool MCP entrano nel registry con gli stessi metadati e permessi.

**Skill**: procedure riutilizzabili = tool + istruzioni + condizioni. Due tipi: **deterministiche** (modulo TypeScript, nessun LLM; es. "riassumi la mia agenda di domani" se i dati sono strutturati) e **guidate** (prompt + tool consentiti + budget). Apprendimento di nuove skill solo via pipeline: identificazione procedura ripetuta → proposta (modello *standard*) → test in ambiente isolato → validazione automatica → **approvazione umana** dall'app → registrazione versionata. Il codice generato non gira mai fuori dalla sandbox e mai senza approvazione (tecnologia di isolamento scelta nella M5 con il supporto della ricerca bibliografica).

## 10. Automation Engine

BullMQ su Redis: job scheduler per cron e one-shot; webhook via rotta Fastify con firma HMAC e chiave di idempotenza; trigger su eventi interni (bus in-process + Redis pub/sub tra api e worker). Ogni automazione ha: definizione versionata, condizioni, `budgetUsd`, retry con backoff esponenziale, dead-letter, storico in `automation_runs`, notifica (APNs dalla M7). Automazioni deterministiche non chiamano LLM; quelle che richiedono ragionamento passano dal router con lo stesso Policy Engine delle richieste interattive. Il worker scrive un heartbeat in Redis (`ernie:worker:heartbeat`) già dalla M1.

## 11. Model Gateway

Le **classi** sono l'unità di routing; la mappa classe → modello è configurazione (per provider), non codice.

| Classe | Uso | Mappa predefinita (da confermare in M2) |
|---|---|---|
| `light` | riassunti, estrazione memoria, riformulazioni, titoli | Haiku 5.5 (`claude-haiku-5-5` diretto Anthropic, oppure slug equivalente su OpenRouter) |
| `standard` | conversazione, tool use ordinario | Sonnet 5.5 (`claude-sonnet-5-5` / slug OpenRouter) |
| `heavy` | pianificazione multi-step, analisi, `deepReasoning` | Opus 5.5 (`claude-opus-5-5` / slug OpenRouter), effort alto |
| `embedding` | memoria semantica | `text-embedding-3-small` (OpenAI) |

Implementazione: `resolveModel(class, opts)` restituisce il valore accettato dal campo `model` di Mastra (stringa `provider/model`, istanza AI SDK o `{ id, url }` per endpoint OpenAI-compatibili, incluso LiteLLM). Le opzioni specifiche del provider (effort/thinking, cache dei prompt) passano in `providerOptions` solo quando il provider è nativo. Un listino prezzi versionato (`model_prices`) consente la stima dei costi; il costo effettivo, quando il provider lo riporta (OpenRouter lo fa), viene salvato accanto alla stima.

## 12. Observability e cost tracking

- Logging: pino JSON con redazione automatica di credenziali e header sensibili (già attiva), `requestId` propagato (`x-request-id`) e `correlationId` negli eventi.
- Tabelle (M2–M3): `llm_calls` (una riga per chiamata: modello, classe, token in/out/reasoning/cached, costo stimato/effettivo, latenza, esito, `requestId`), `router_decisions` (Jev: domande, risposte, confidenza, costo, `source`), `request_metrics` (aggregato per richiesta, sez. 4).
- Metriche derivate: costo per richiesta e per sessione, tasso di rotte deterministiche, hit rate delle cache, fallback del router, p50/p95 di latenza e primo token.
- OpenTelemetry opzionale (M9) con le semantic conventions GenAI.
- **Nessuna dichiarazione di risparmio senza benchmark** (sez. 17).

## 13. Client iOS

Interfaccia principale. SwiftUI; autenticazione con chiave nel Keychain; WebSocket con il protocollo v1 (porting in Swift di deduplica e sequenze); cronologia e sessioni; stato delle automazioni; APNs.

**Voce** (fasi): (1) push-to-talk con trascrizione locale e risposta vocale; (2) conversazione continua con app attiva e gestione dei turni (VAD, fine frase); (3) barge-in con rilevamento voce durante la sintesi e gestione dell'eco. Vincoli verificati: `SpeechTranscriber` richiede iOS 26 e modelli linguistici installati (`AssetInventory`; controllare `supportedLocales`/`installedLocales`); `SFSpeechRecognizer` come fallback; `AVSpeechSynthesizer` per TTS con sintesi incrementale per frasi e interruzione; `AVAudioSession` `.playAndRecord` + `.voiceChat` per la cancellazione d'eco di sistema. Per evitare che il sintetizzatore venga trascritto come voce dell'utente: mute logico del riconoscitore durante la sintesi + soglia di energia + confronto temporale con le utterance in riproduzione; l'ascolto continuo illimitato in background non è garantito e non è un requisito.

**Avatar 3D** (traccia di valutazione, M10): l'utente vuole un avatar tridimensionale animato, con **Unreal Engine o equivalenti**. Opzioni da confrontare con la ricerca bibliografica dedicata (`docs/research/04-avatar-3d-ios.md`): Unreal Engine 5 su iOS (MetaHuman, integrazione in app SwiftUI esistente, dimensione binario, licenza), Unity as a Library, Godot, RealityKit/SceneKit nativi (USDZ, blend shapes), soluzioni web (three.js in WKWebView). Vincolo architetturale: il TTS è on-device (`AVSpeechSynthesizer`), quindi il lip-sync deve avvenire sul dispositivo (visemi da fonemi/testo, audio-to-viseme, o ampiezza) e il backend può solo inviare **suggerimenti strutturati** (emozione, gesto, stato) tramite eventi `avatar.*` riservati nel protocollo (v1.1). Criteri di scelta: integrazione con SwiftUI, dimensione app e consumo, qualità, licenza, costo di sviluppo. La decisione viene presa dopo la ricerca; nessuna tecnologia è ancora fissata.

## 14. Protocollo client-server (v1)

Envelope: `{ v: 1, id, sessionId, correlationId, seq, ts, type, payload }`. Eventi client→server: `session.start` (con `resumeFromSeq`), `user.message` (`text`, `inputMode`, `locale`), `user.cancel`, `session.ping`. Server→client: `session.started`, `assistant.started` (rotta e classe), `assistant.text.delta`, `assistant.text.completed`, `tool.started`, `tool.completed`, `assistant.completed` (con `usage`), `assistant.cancelled`, `error`. Ogni tipo ha **direzione** e **audience** (`user` = contenuto mostrabile, `runtime` = stato interno) dichiarate in `EVENT_DIRECTION` / `EVENT_AUDIENCE`. Riconnessione: il client invia `resumeFromSeq`, il server rinvia gli eventi mancanti dal buffer di sessione (Redis, TTL). Deduplica per `id`, ordinamento per `seq`, cancellazione per `correlationId`. Estensioni riservate per v1.1: `tool.confirmation.*`, `avatar.*`, `automation.*`. Schemi Zod e test in `packages/protocol`.

## 15. Sicurezza

- **Autenticazione**: chiavi API per dispositivo (hash SHA-256 in `api_keys`, scope, revoca), header `Authorization: Bearer`; TLS terminato dal reverse proxy (Caddy, profilo Docker della M9) o dal provider VPS.
- **Autorizzazioni**: scope per tool e skill; Policy Engine deterministico applicato dopo il router; conferma esplicita per azioni sensibili; `user_id` su ogni tabella e in ogni query (isolamento dei dati tra utenti, test dedicati).
- **Prompt injection**: contenuti esterni (risultati web, documenti, output di tool) marcati come dati non fidati e racchiusi in delimitatori; le istruzioni operative restano nel system prompt; i tool con `sideEffects` non vengono mai eseguiti su sola istruzione contenuta in un tool result senza conferma; schemi Zod su tutti gli input.
- **Codice generato**: solo in sandbox isolata e dopo approvazione (M5).
- **Segreti** fuori dal codice (`.env` ignorato da git, `.env.example` senza valori); redazione nei log; rate limiting per chiave; audit log immutabile; cifratura dei campi sensibili (pgcrypto o AES-GCM applicativo) e retention configurabile (M9).
- Le decisioni di Jev e degli LLM non sostituiscono mai questi controlli.

## 16. Deployment

Docker Compose su VPS: `postgres` (pgvector, volume `pgdata`), `redis` (AOF + snapshot, volume `redisdata`), `migrate` (one-shot, gira prima di `api`), `api`, `worker`, `litellm` (profilo opzionale). Un'unica immagine applicativa (`infrastructure/docker/Dockerfile`, multi-stage, Node 24 alpine, dipendenze di produzione soltanto, utente non root) con comandi diversi per servizio. Health check su `/health` (liveness) e `/ready` (readiness con controllo di Postgres e Redis). Lo stato vive nei volumi: il riavvio dei container non perde dati (criterio 10); backup di Postgres programmato nella M9. CI (GitHub Actions): lint, build, migrazioni e test con Postgres/Redis reali, poi build dell'immagine, avvio dello stack e smoke test.

## 17. Ottimizzazione dei token e benchmark

Leve implementate per milestone: prompt core compatto (M2), finestra conversazionale a budget con riassunti progressivi (M2/M4), cache delle decisioni e delle risposte (M3), retrieval selettivo (M4), tool discovery dinamico (M5), skill deterministiche (M5), memoria asincrona (M4), limiti di step e loop detection (M2), routing tra classi (M3). Benchmark (M9): un corpus di richieste rappresentative eseguito in due modalità — routing completo vs. modello `standard` fisso — misurando token, costo, latenza e qualità (valutazione umana + controlli deterministici). Solo questi numeri potranno sostenere affermazioni di risparmio.

## 18. Struttura del repository

```
Ernie/
├── apps/
│   ├── api/               Fastify: health, (M2) WS, auth, sessioni
│   ├── worker/            BullMQ: job di sistema, (M4) memoria, (M6) automazioni
│   └── ios/               (M7) progetto Xcode SwiftUI
├── packages/
│   ├── config/            schema env + config tipizzata        ✅
│   ├── db/                pool pg, migrazioni, CLI              ✅
│   ├── observability/     logger, id                            ✅
│   ├── protocol/          eventi v1, deduplica, sequenze        ✅
│   ├── agent-core/        (M2) runtime, (M3) router deterministico
│   ├── jev-router/        (M3)
│   ├── soul/              (M2)
│   ├── memory/            (M4)
│   ├── tools/  skills/    (M5)
│   ├── automations/       (M6)
│   └── model-gateway/     (M2)
├── infrastructure/
│   ├── docker/            Dockerfile, litellm.config.yaml
│   └── migrations/        SQL versionate
├── tests/                 smoke e2e, (M9) benchmark
├── docs/                  CONFIGURATION.md, research/
├── docker-compose.yml · ARCHITECTURE.md · IMPLEMENTATION_PLAN.md · README.md
```

## 19. Rischi e punti aperti

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Decisions API di Jev in alpha | rottura del router | adapter isolato, mock, fallback deterministico, pin del modello |
| ID dei modelli 5.x su OpenRouter non verificati | mappa classi errata | risoluzione via `GET /api/v1/models` in M2; nessun ID ipotizzato in codice |
| Qualità/latenza del routing non misurate | decisioni sbagliate su classe/memoria | soglie tarate su dati etichettati; benchmark M9; telemetria dal M3 |
| Limiti iOS su audio in background e disponibilità modelli SpeechTranscriber | esperienza vocale degradata | fallback SFSpeechRecognizer; modalità continua solo in primo piano; controllo asset a runtime |
| Avatar 3D: peso del motore, licenze, lip-sync con TTS Apple | costi e dimensione app | ricerca dedicata, spike comparativo prima di scegliere (M10) |
| Isolamento del codice generato | sicurezza | nessuna esecuzione fuori sandbox e senza approvazione; scelta tecnologica in M5 |
| Mastra 1.x evolve rapidamente | breaking change | pin delle versioni, test di integrazione, aggiornamenti controllati |

Gli esiti della ricerca bibliografica (architettura, buone prassi, avatar) verranno integrati in una revisione v0.2 di questo documento.
