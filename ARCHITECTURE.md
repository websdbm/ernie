# Ernie — Architettura tecnica

> Stato: **v0.8** (11 ottobre 2026). La v0.8 registra la M5 realizzata: Tool Registry ed Executor con policy, approvazioni e audit, tool integrati (orario, memoria, lista della spesa, web via Firecrawl), skill deterministica della lista della spesa, ciclo di vita delle skill apprese. La v0.7 registra la M4 realizzata: Memory Engine con fatti semantici ed episodi, ricerca ibrida, consolidamento asincrono, snapshot nel prefisso e tool `memory_search`. La v0.6 registra la M3 realizzata: router JEV con soglie calibrate, router deterministico, Policy Engine con taint e approvazioni monouso, isteresi di classe, rilevatore di loop. La v0.5 introduce il modello multi-utente "companion" (un agente personalizzato per utente: Soul, memoria, sessioni, budget separati) e registra la M2 realizzata. La v0.4 recepisce lo spike M2.1 sul passthrough OpenRouter (`docs/research/05-spike-openrouter-passthrough.md`). La v0.3 registra la decisione dell'utente sull'avatar (three.js + TalkingHead, Unreal escluso). La v0.2 integra la ricerca bibliografica (`docs/research/01`, `02`, `04`) filtrata dalla revisione indipendente (`docs/research/03-revisione.md`: 53 verifiche su fonti primarie, 0 affermazioni false). Le modifiche rispetto alla v0.1 sono elencate in §20. Documento vivo, aggiornato a ogni milestone.

## 1. Scopo e principi

Ernie è un agente AI personale **persistente**: identità configurabile (Soul), memoria a più livelli, tool e skill, automazioni, routing decisionale e un client iOS nativo con interazione vocale e, in prospettiva, un avatar animato. Il backend risiede su una VPS in container Docker; l'agente può cercare in internet, usare tool, ricordare.

Principi non negoziabili:

1. **Deterministico prima, LLM dopo.** Ogni richiesta attraversa prima codice deterministico (comandi, procedure note, cache). Un LLM interviene solo dove serve intelligenza. La letteratura di produzione conferma: harness sottili con limiti hard di passi, costo e tempo battono i framework "intelligenti" (01 §2.1).
2. **Scala di escalation.** Deterministico → skill → modello *light* (solo fuori banda) → *standard* → *heavy* con ragionamento esteso. La decisione è presa da un modello decisionale non generativo (Jev) e da regole, mai da un LLM che "sceglie se stesso".
3. **Budget di token come requisito architetturale.** Prefisso di cache **stabile a livello di sessione**, contesto assemblato con budget, retrieval selettivo, tool discovery dinamico, riassunti progressivi. La prompt cache è la leva di costo più forte misurata (−41–80% nei task agentici, 01 §2.2): ogni scelta che varia il prefisso per richiesta va giustificata.
4. **La sicurezza non è delegata ai modelli.** Si parte dall'ipotesi che la prompt injection riesca (attacchi adattivi aggirano >90% delle difese pubblicate, 02 §2.1). I confini sono deterministici: Policy Engine deny → ask → allow fuori dall'LLM, Rule of Two come *taint* di run, sandbox a container per il codice generato, isolamento dei dati per utente con RLS. Nessuna decisione di Jev o di un LLM può aggirarli.
5. **Monolite modulare.** Un'unica base di codice TypeScript con pacchetti a responsabilità singola; due processi (API e worker). Nessun microservizio finché non c'è una ragione misurabile. Mastra fornisce le primitive (storage, memoria, tool, HITL); l'assemblaggio del prompt e i limiti del loop restano nostri.
6. **Un companion per utente.** Ogni utente (all'inizio Alessandro e suo figlio) ha il proprio agente: Soul personale clonato dai modelli globali e poi divergente, memoria e sessioni proprie, chiavi e budget propri. L'isolamento è deterministico (RLS in Postgres, `resource` Mastra = utente), non una preferenza del modello. L'owner gestisce gli account e può imporre policy bloccate (es. per un minore).
7. **Nessuna affermazione senza misura.** Costi reali dal provider, benchmark con baseline (miglior modello singolo, economico fisso, router casuale), eval deterministiche in CI.

## 2. Vincoli verificati e decisioni chiave

Verifiche datate 10 ottobre 2026; fonti in `docs/research/00-fonti-verificate.md` e `03-revisione.md` (§2).

| Tema | Decisione | Alternativa scartata | Motivazione |
|---|---|---|---|
| Router decisionale | **Jev (TypeSafe) via OpenRouter Decisions API** (`POST /api/alpha/decisions`, modello pinnato `typesafe/jev-1.13`) | Classificatore con LLM generativo; `typesafe/jev-router` | Decision model non generativo: risposte tipizzate (`choice`, `noul`, `score`) con probabilità, ≈ $0,042/M token input, output gratuito. Evidenze indipendenti preliminari ma positive (01 §2.5); le probabilità `noul` risultano mal centrate su 0,5 → soglie da tarare su dati etichettati. Rischio: API **alpha**; adapter isolato, mock, fallback deterministico. |
| Framework agentico | **Mastra 1.x** (`@mastra/core` 1.75, `@mastra/pg` 1.30, `@mastra/memory` 1.36) per storage, memoria, tool, `requireApproval`, skill agentskills.io | LangGraph, Agents SDK | Richiesto; nativo TypeScript; Agent con `instructions`/`model`/`tools` dinamici. Attenzione (03 §3.10): le funzioni dinamiche per richiesta variano il prefisso di cache; in M2 si verifica come Mastra ordina tool e system prompt e, se non controllabile, l'assemblaggio del prompt diventa nostro. |
| Model Gateway | **Istanze `@openrouter/ai-sdk-provider` 3.x passate a Mastra** (`usage.include`, `cache_control` automatico, `session_id`, `reasoning` fisso per sessione, `maxOutputTokens` esplicito); **LiteLLM profilo Docker opzionale** | Stringa `openrouter/...` di Mastra; LiteLLM obbligatorio | Spike M2.1: la stringa nativa non invia `cache_control` e non ottiene alcuna cache; con il provider la seconda chiamata costa il 92% in meno e il costo reale torna nella risposta. Un proxy in mezzo appiattirebbe queste opzioni. |
| Provider iniziali | **OpenRouter** (chat + Jev), **OpenAI** (embeddings `text-embedding-3-small`), Anthropic diretto se verrà fornita una chiave | — | ID verificati su `GET /api/v1/models` (11 ott 2026): `anthropic/claude-haiku-5.5` (0,10/0,50 $/M, cache 0,01/0,12), `anthropic/claude-sonnet-5.5` (2/10, cache 0,10/2,50), `anthropic/claude-opus-5.5` (4/20, cache 0,20/5,00), tutti 1M di contesto, cache minima 512 token, `reasoning_effort`, `tools`, `structured_outputs`. Passthrough verificato (spike M2.1). **Saldo OpenRouter esaurito all'11 ott 2026: da ricaricare.** |
| Ricerca web | **Firecrawl** (search v2 + scrape, SDK `firecrawl`) dietro interfaccia `WebSearchProvider` | SearXNG, API dei motori | Richiesto; un servizio per ricerca ed estrazione; contenuti trattati come non fidati; test di injection su pagine reali in M5. |
| Linguaggio/toolchain | TypeScript **5.9**, Node **24 LTS** in container, pnpm 11, Biome 2, Vitest 5 | TypeScript 7 | Ecosistema testato su 5.x; migrazione valutabile in M9. |
| API HTTP/WS | **Fastify 5** con rotte proprie; `@mastra/fastify` non montato | `MastraServer` | Superficie minima sotto la nostra autenticazione. |
| Trasporto | **WebSocket** con eventi v1 (`id`, `seq`, `correlationId`), semantiche v1.1 di 02 (cancel idempotente, snapshot + replay, controllo `Origin`) | SSE + POST con `Idempotency-Key`; AG-UI | L'audio non lascia il dispositivo; WS già implementato; AG-UI senza SDK Swift né ID evento (03 C.1–C.2). |
| Database | PostgreSQL 17 + **pgvector**, migrazioni SQL versionate, **RLS `FORCE`** sulle tabelle utente | ORM dal giorno 1 | Mastra migra le proprie tabelle; SQL espliciti per le nostre. RLS con ruolo applicativo non owner (02 §2.1); limite: tabelle `mastra_*`, da verificare. |
| Code e job | **BullMQ 6** su Redis 8 (AOF) | Temporal/Inngest | Idempotenza + scheduler + dead-letter coprono M6 (03 C.3). |
| Sandbox codice generato | **Container dedicato con gVisor o microVM**, senza rete né segreti | `node:vm`, `isolated-vm` | `node:vm` non è un confine di sicurezza; `isolated-vm` ha avuto un escape critico (GHSA-864f-rcv7-6rh4, ago 2026) (02 §2.1). |
| Speech iOS | **SpeechTranscriber** (iOS 26+, on-device, italiano al lancio) con fallback **SFSpeechRecognizer** (limite 1 minuto, rotazione delle richieste); **AVSpeechSynthesizer**; `AVAudioSession` `.playAndRecord` **+ `setVoiceProcessingEnabled(true)`** | STT/TTS cloud; speech-to-speech | Audio on-device; `.voiceChat` da solo **non** attiva la cancellazione d'eco (02 §2.6, corregge v0.1). Nessuna wake word né microfono dal background. |
| Avatar 3D | **three.js + TalkingHead (MIT) in WKWebView**, deciso dall'utente il 10 ott 2026; asset GLB di proprietà con rig Mixamo, **52 blendshape ARKit + 15 visemi Oculus**; **lip-sync on-device** da `AVSpeechSynthesizer` (audio PCM + tempi di parola → `streamAudio`) con **modulo italiano `lipsync-it.mjs` da scrivere** | **Unreal Engine/MetaHuman** (escluso: nessun embedding iOS documentato, LOD 3 senza blendshape, lip-sync non a runtime, app "UE-first" rifiutata), RealityKit (scartato: pipeline USDZ e bug blendshape aperto), Unity (licenza "Industry"), Godot (community), Model3DView (solo viewer statico su SceneKit) | Unica pipeline open source completa per avatar conversazionali (visemi, umori, gesti, sguardo, streaming con interruzione); glTF nativo; integrazione SwiftUI via `WKWebView` con JS nel bundle (App Review 2.5.2). Rischi: prestazioni WebGL e consumo su iPhone (spike S3), marker fonemici (S1), G2P italiano (S4). |

## 3. Vista d'insieme

```
 iOS (SwiftUI)                         VPS (Docker Compose)
 ┌──────────────────────┐              ┌─────────────────────────────────────────────────────────┐
 │ Speech→Text (device) │  WebSocket   │  api (Fastify)                                            │
 │ Text→Speech (device) │◀────────────▶│  ┌───────────────┐  ┌──────────────────┐  ┌────────────┐ │
 │ Avatar (RealityKit / │  eventi v1   │  │ Session Mgr   │─▶│ Deterministic    │─▶│ JEV        │ │
 │  WKWebView) + lipsync│              │  │ + Auth        │  │ Context Router   │  │ Decision   │ │
 │ Keychain · APNs      │              │  └───────────────┘  └──────────────────┘  │ Router     │ │
 └──────────────────────┘              │          │                    │            └─────┬──────┘ │
                                       │          ▼                    ▼                  ▼        │
                                       │  ┌─────────────────────────────────────────────────────┐ │
                                       │  │ Policy Engine (deny→ask→allow, taint, budget)       │ │
                                       │  ├─────────────────────────────────────────────────────┤ │
                                       │  │ Agent Runtime (Mastra Agent, prefisso stabile)      │ │
                                       │  │  Soul · Memory · Tool Registry · Skill · Gateway    │ │
                                       │  └─────────────────────────────────────────────────────┘ │
                                       │          │ usage/costi/eventi                            │
                                       │          ▼                                               │
                                       │  Observability (llm_calls, router_decisions, metrics)    │
                                       ├─────────────────────────────────────────────────────────┤
                                       │  worker (BullMQ)  consolidamento memoria · automazioni · │
                                       │                   notifiche APNs · job di sistema        │
                                       ├─────────────────────────────────────────────────────────┤
                                       │  sandbox (gVisor/microVM, no rete, no segreti)  [M5]     │
                                       ├─────────────────────────────────────────────────────────┤
                                       │  postgres (pgvector, RLS) · redis (AOF) · [litellm opz.] │
                                       └─────────────────────────────────────────────────────────┘
```

## 4. Moduli e responsabilità

Stato: ✅ realizzato · 🔧 in corso · ⏳ pianificato (milestone tra parentesi).

| # | Modulo | Pacchetto | Responsabilità | Stato |
|---|---|---|---|---|
| 1 | API Gateway & Session Manager | `apps/api` | HTTP/WS, autenticazione per chiave (hash), sessioni con log eventi e replay (Redis), controllo `Origin`, dispatch eventi | ✅ M2 (rate limit ⏳ M9) |
| 2 | Deterministic Context Router | `packages/agent-core` | Comandi riconosciuti senza Jev né LLM; (M5) procedure consolidate | ✅ M3 |
| 3 | JEV Decision Router | `packages/jev-router` | Adapter Decisions API, schema Zod, cache esatta Redis, timeout, fallback, soglie calibrate, `router_decisions` | ✅ M3 |
| 4 | Policy Engine | `packages/agent-core` | deny → ask → allow deterministico, taint di run **e di sessione** (Redis, 30 min), approvazioni monouso (`tool_approvals`), budget | ✅ M3–M5 |
| 5 | Agent Runtime | `packages/agent-core` | Agente per sessione (prefisso stabile), stream Mastra → eventi, memoria conversazionale Postgres, limiti hard, rilevatore di loop, cancellazione | ✅ M2–M3 |
| 6 | Soul Engine | `packages/soul` | Soul per utente clonati dai modelli globali, versionamento, assemblaggio deterministico a budget | ✅ M2 |
| 7 | Memory Engine | `packages/memory` | Fatti semantici ed episodi con provenienza e validità, deduplica esatta e semantica, supersessione, ricerca ibrida RRF, snapshot nel prefisso, `memory_search`, consolidamento asincrono (worker, modello light), export/oblio/purge | ✅ M4 (procedurale e riassunti progressivi ⏳ M5/M9) |
| 8 | Tool Registry & Executor | `packages/tools` | Catalogo con metadati (id@versione, categoria, rischio, scope, timeout, retry, costo), set stabile per sessione, executor con policy → approvazioni → timeout/retry → taint → audit (`tool_calls`), tool integrati: `get_time`, `memory_search`, `shopping_list_*`, `web_search`/`web_fetch` (Firecrawl) | ✅ M5 (meta-tool `tool_search` e MCP ⏳ M9) |
| 9 | Skill Registry & Executor | `packages/skills` | Skill deterministica `shopping_list` (parser italiano, 0 LLM), skill guidate, skill apprese in markdown con ciclo proposta → test → approvazione → attivazione, versioni per hash, scansione alla scrittura e al recupero, rilevamento di procedure ripetute | ✅ M5 (skill con codice e sandbox ⏳ M9) |
| 10 | Automation Engine | `packages/automations` + `apps/worker` | Cron, one-shot, webhook, eventi, idempotenza, storico, budget per run, notifiche | ⏳ M6 (skeleton ✅) |
| 11 | Model Gateway | `packages/model-gateway` | Classi → istanze OpenRouter (cache, costo, session_id, reasoning per classe), listino, `llm_calls` per step, tetto di spesa giornaliero | ✅ M2 (embeddings ⏳ M4) |
| 12 | Observability & Cost Tracking | `packages/observability`, `model-gateway` | Logging con redazione, correlazione, `llm_calls` per step con costo del provider | ✅ M2 (metriche aggregate ⏳ M3) |
| 13 | iOS Client | `apps/ios` | SwiftUI, voce, streaming, sessioni, notifiche, avatar | ⏳ M7–M8, M10 |
| — | Protocollo | `packages/protocol` | Eventi v1 + v1.1 (persist, cancel con `spokenThroughIndex`, conferme tool, `avatar.*`, `automation.*`, pong), deduplica, sequenze | ✅ |
| — | Configurazione / Database | `packages/config`, `packages/db` | Config tipizzata e redatta; pool, migrazioni, CLI | ✅ |

### Interfacce principali

```ts
// Decisione del router (packages/jev-router), validata con Zod
interface RouteDecision {
  route: 'deterministic' | 'skill' | 'llm';
  modelClass: 'light' | 'standard' | 'heavy'; // 'light' solo per chiamate ancillari
  deepReasoning: boolean;
  needsMemory: boolean;
  toolCategories: string[];
  skillId: string | null;
  riskSignal: number;            // noul: può solo restringere la policy
  confidence: number;
  source: 'deterministic' | 'jev' | 'cache' | 'fallback';
  costUsd: number;
}

// Etichette di rischio dei tool (Rule of Two, packages/tools)
interface ToolRisk { readsPrivate: boolean; ingestsUntrusted: boolean; externalEffect: boolean }

// Esito della policy (packages/agent-core)
type PolicyVerdict =
  | { kind: 'allow' }
  | { kind: 'ask'; approvalId: string; expiresAt: string }     // approvazione monouso legata a (tool, hash args, utente)
  | { kind: 'deny'; reason: string };

// Contesto assemblato a prefisso stabile (packages/agent-core)
interface AssembledContext {
  stablePrefix: { tools: ToolDefinition[]; coreSoul: string; contextSoul: string; memorySnapshot: string };
  summary: string;                // riassunto progressivo (cambia raramente)
  history: Message[];             // append-only
  turn: { user: string; memoriesInline: MemoryHit[]; volatile: { now: string } }; // parti variabili in coda
  budget: { maxInputTokens: number; maxUncachedTokens: number; usedTokens: number };
}

// Riga di llm_calls (packages/observability)
interface LlmCall {
  requestId: string; sessionId: string; userId: string; model: string; modelClass: string;
  inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens?: number;
  costReported?: number; costEstimated: number; costSource: 'provider' | 'pricelist';
  ttftMs?: number; latencyMs: number; finishReason: string;
}
```

## 5. Flusso di una richiesta e scala di escalation

1. **Ingresso.** `user.message` via WS; autenticazione, `correlationId`, persistenza (Mastra thread); `assistant.started` appena decisa la rotta. La run vive indipendentemente dalla connessione.
2. **Router deterministico** (M3: `packages/agent-core/commands.ts`). Comandi riconosciuti (`/aiuto`, `/stato`, `/classe standard|heavy`, `/contesto …`) risolti senza Jev né modello e registrati in `router_decisions` con `source = deterministic`; in M5 si aggiungono le procedure consolidate (match esatto/`pg_trgm`). Niente cache semantica delle risposte (falsi hit, 03 C.11).
3. **Jev.** Una sola chiamata con le domande tipizzate (§6), `state` compatto. Timeout iniziale 1,5 s (da ritarare con la telemetria: p50 ≈ 185 ms su benchmark terzi), cache delle decisioni per hash. Timeout/errore → fallback a regole (`standard`, memoria attiva, nessun tool), `source = fallback`.
4. **Policy Engine** (M3: `policy.ts`, `approvals.ts`; deterministico, fail-closed): deny → ask → allow su ogni tool, taint di run (§15), approvazioni monouso in `tool_approvals` legate a (tool, hash argomenti, utente, scadenza) e consumate atomicamente; `tool.confirmation.requested/respond/resolved` nel protocollo. Budget giornaliero per utente. Una decisione di Jev può solo essere **ristretta**. I tool arrivano in M5: il motore è testato con descrittori sintetici.
5. **Esecuzione.** `skill` → Skill Executor (M5). `llm` → Agent Runtime con contesto a prefisso stabile (§4), `model` della classe di **sessione** (§11), tool del set stabile. Limiti hard; **stuck detector** (M3: `loop.ts`, stessa chiamata ripetuta 3 volte, 8 per tool di polling → `error.loop_detected`); cancellazione via `AbortSignal`.
6. **Streaming.** `assistant.text.delta`, `tool.started/completed`, eventuali `avatar.*`, `assistant.completed` con `usage`.
7. **Post-elaborazione asincrona (worker).** Estrazione fatti/episodi in batch con `light`, deduplica, consolidamento; nessuna chiamata LLM sincrona per la memoria.

**Scala di escalation.** Deterministico → skill → `standard` (default conversazionale) → `heavy`. La classe ha **isteresi di sessione** (M3: `sessions.raiseModelClass`): sale quando Jev sceglie `heavy` o `deep_reasoning` supera la soglia, oppure con `/classe heavy`, e non scende più nella sessione, perché ogni cambio di modello invalida la cache (01 §2.5–2.6); al cambio l'agente di sessione viene ricostruito. `light` è riservato a chiamate ancillari fuori banda. Il benchmark M9 (§17) valida questa scelta sui dati di cache.

## 6. JEV Decision Router

### Fatti verificati

- Jev è il primo "System One decision model" di TypeSafe: `state` testuale + domande tipizzate → valori tra quelli definiti dal chiamante con probabilità; niente testo libero né ragionamento.
- **Decisions API** `POST https://openrouter.ai/api/alpha/decisions` (HTTP o `@openrouter/sdk` → `openRouter.alpha.decisions.create({ decisionsRequest })`); **System One API** `POST https://openrouter.ai/api/v1/systemone`. Auth `Authorization: Bearer <OPENROUTER_API_KEY>`.
- Richiesta `{ model, state, questions: { [nome]: { type: 'noul'|'choice'|'score', instructions, criteria } } }`; risposta `{ id, model, provider, answers, usage: { input_tokens, output_tokens, cost } }`. Domande indipendenti e parallele. Contesto 32k. Prezzo (21 set 2026): $0,042/M input, output gratuito. Pinnare `typesafe/jev-1.13`.
- Evidenze indipendenti (01 §2.5): paper arXiv su 37 dataset (favorevole su classificazione), micro-benchmark terzi (94,4% su 72 esempi, ~185 ms, "directional"); le probabilità binarie risultano **"poorly placed relative to 0.5"**.
- `typesafe/jev-router`, plugin Hermes e jevai.org non sono riferimenti per l'integrazione (il primo è candidato nel benchmark M9).

### Schema di decisione

| Domanda | Tipo | Criteri |
|---|---|---|
| `route` | choice | `deterministic`, `skill`, `llm` |
| `model_class` | choice | `standard`, `heavy` (la classe di sessione può solo salire; `light` non è una scelta conversazionale) |
| `deep_reasoning` | noul | pianificazione/analisi multi-passo |
| `needs_memory` | noul | dipende da fatti personali o storici |
| `tool_category` | choice | `none` + categorie attive |
| `skill_candidate` | choice | `none` + fino a 5 skill dal retrieval |
| `risk` | noul | la richiesta implica azioni esterne o dati sensibili → segnale che può solo restringere la policy |

### Garanzie (realizzate in M3, `packages/jev-router`)

Timeout (1,5 s) e fallback deterministico tracciato (`source = fallback`: `llm`, classe della sessione, memoria attiva, rischio 1); cache esatta delle decisioni (Redis, TTL 10 min, chiave = hash del testo normalizzato + impronta del contesto); una riga in `router_decisions` per ogni richiesta (anche deterministica) con token, costo, latenza, confidenza e risposte grezze; `MockJevClient` per i test offline; adapter come unico punto che conosce l'endpoint (API alpha). Nessun bypass delle autorizzazioni: `risk` entra nel Policy Engine come segnale che può solo restringere.

**Calibrazione** (11 ott 2026, `docs/research/06-calibrazione-jev.md`): 60 esempi etichettati in italiano, modello `typesafe/jev-1.13-20260917`, costo 0,0023 $, latenza p50 256 ms / p95 336 ms. Soglie scelte per accuratezza bilanciata: `deep_reasoning` 0,35 (94,1%), `needs_memory` 0,75 (91,0%), `risk` 0,60 (91,3%); a 0,5 sarebbero state 91,5 / 88,2 / 87,3%. `model_class` corretta al 96,7%; `route` all'88,3%, con errori concentrati su domande di memoria o agenda classificate `skill` quando l'unica skill disponibile è la lista della spesa: 5 dei 7 errori hanno confidenza sotto la soglia di rotta (0,5) e il mapping ricade su `llm` quando la skill scelta non è tra le candidate. Le soglie vivono in `infrastructure/router/thresholds.json` e vanno riviste con esempi reali raccolti da `router_decisions` (M9).

## 7. Soul Engine

- **Core Soul** (≤ 400 token, sempre nel prefisso): identità, tono, lingua, regole irrinunciabili.
- **Context Soul** per tag, scelto **a livello di sessione** (o inserito dopo il breakpoint di cache), mai cambiato turno per turno: variarlo invalida il prefisso (03 A.6).
- **Operational Policies** per situazione (conferme, privacy, formato vocale: frasi brevi, niente markdown se `inputMode = voice`).
- **Per utente** (v0.5): `souls(key, user_id)`; i Soul con `user_id IS NULL` sono i **modelli globali** (seminati dalla migrazione 0005: `core`, `ctx:cucina`, `policy:voce`). Alla creazione di un utente la CLI li **clona** come Soul personali, che da quel momento evolvono per conto proprio (`soul_versions`, autore e motivo per ogni versione). In assemblaggio il Soul dell'utente sostituisce il globale con la stessa chiave; il nome del companion (`users.companion_name`) sostituisce "Ernie" nel core. I Soul `locked` sono modificabili solo da un `owner`: è il meccanismo con cui un genitore impone policy al companion del figlio.
- Persistenza: `souls` e `soul_versions` (storico immutabile) con RLS: i globali sono leggibili da tutti, i personali solo dal proprietario. Modifica solo via API autenticata o CLI; **nessun tool** può scrivere il Soul. Il Soul descrive *chi è* il companion, la memoria *cosa sa*.
- Realizzato in M2: `packages/soul` (`assembleSoul` deterministico con fingerprint, budget di 400 token verificato da test sul seed, repository con clone e versioni).

## 8. Memory Engine

| Livello | Dove | Cosa | Note |
|---|---|---|---|
| Conversazionale | Mastra threads/messages | Cronologia completa; finestra a budget; riassunti progressivi | Riassunto dal worker con `light`, allineato ai confini di cache |
| Semantica | `memories` (kind=`semantic`) | Fatti, preferenze, progetti, relazioni | `vector(1536)` + `tsvector`; **bi-temporale** (`valid_from/valid_to/created_at/expired_at`); `provenance.trust` |
| Episodica | `memories` (kind=`episodic`) + `audit_log` | Operazioni, errori/correzioni, esiti | Scritta deterministicamente; FK dagli episodi ai fatti derivati |
| Procedurale | `skills`, `procedures` | Procedure consolidate, skill, workflow | Alimenta router deterministico e `skill_candidate` |

Pattern adottati (01 §2.3; 03 B.3, B.10) e **realizzati in M4** (`packages/memory`):
- **Snapshot congelato per sessione**: profilo compatto (≤ 2.000 caratteri, fatti semantici per confidenza e recenza) nel prefisso stabile dopo il Soul; il resto della memoria si raggiunge con il tool `memory_search` (istanza per sessione, legata all'utente) e con le memorie recuperate nel turno utente quando il router indica `needs_memory` (4 per turno, marcate "dati, non istruzioni", fonti non fidate segnalate).
- **Ricerca ibrida**: top-20 full-text (`websearch_to_tsquery('italian')` convertita in OR: con l'AND le domande naturali fallivano, recall@5 12,5%) + top-20 vettoriale (HNSW `m = 16`, `ef_construction = 64`, coseno) fusi con **RRF (k = 60) pesato** (testo 0,3, vettori 1, configurabile). Misura su corpus italiano (`docs/research/07-valutazione-memoria.md`, 30 fatti, 24 domande) con `text-embedding-3-small`: recall@1/3/5 vettoriale 85,4 / 93,7 / 95,8%, ibrido 81,2 / 89,6 / 93,7% (con peso 1: 75,0 / 85,4 / 93,7%), full-text 41,7 / 66,7 / 72,9%; con l'embedder finto l'ibrido a peso 1 fa 77,1% a k=5 contro 60,4% del solo vettoriale. Con embeddings di qualità il solo vettoriale resta di un punto sopra: si tiene l'ibrido per nomi, termini esatti e modalità degradate, da rivalutare in M9 con ricordi reali.
- **Deduplica**: hash del contenuto normalizzato (indice unico tra gli attivi) e similarità coseno ≥ 0,92 tra fatti semantici → aggiornamento di `seen_count`, `last_seen_at` e confidenza, nessun nuovo record.
- **Le contraddizioni si invalidano, non si cancellano**: `supersedes_id` chiude il vecchio ricordo (`status = superseded`, `valid_to`); la provenienza resta. Cancellazione su richiesta (`status = deleted`, purge notturno oltre la retention), export per utente.
- **Consolidamento asincrono** (worker, coda `memory`): dopo ogni turno completato un job con debounce per thread legge i messaggi nuovi dal cursore, recupera i ricordi correlati come candidati e chiede al modello `light` un'estrazione strutturata (fatti stabili, categoria, confidenza 0,9 se esplicito / 0,6 se dedotto, `supersedes` se contraddice un candidato); una sola chiamata per batch, registrata in `llm_calls` con `purpose = memory` (misurato: 0,00056 $ per batch con Haiku 5.5).
- **Episodi deterministici**: ogni turno produce un episodio (richiesta, rotta, modello, esito, costo, latenza) senza LLM; memoria da contenuti esterni porta `trust` basso.
- Embeddings: OpenAI `text-embedding-3-small` (1536 dim, 0,02 $/M token) scelto dopo la misura; senza chiave OpenAI la memoria degrada a full-text. Riassunti progressivi e compressione a gradini della cronologia → M9 con il benchmark; memoria procedurale → M5 con le skill.

## 9. Tool Registry e Skill

**Tool** (M5, `packages/tools`): `ToolSpec` con `id@version`, descrizione ≤ 1 frase, `category`, etichette di rischio **`readsPrivate` / `ingestsUntrusted` / `externalEffect` / `write`** (Rule of Two), `requiredScopes`, `timeoutMs`, `retry`, `costEstimateUsd`, schemi Zod di input e output (convertiti da Mastra in JSON Schema draft-07). L'**executor** avvolge ogni tool: policy deterministica (deny → ask → allow) → approvazione monouso con `tool.confirmation.requested/respond/resolved` e consumo atomico → timeout e retry sui soli errori transitori → validazione dell'output → marcatura della run **e della sessione** come contaminate se il tool ingerisce contenuti esterni → audit in `tool_calls` (hash degli argomenti, verdetto, approvazione, esito, durata, taint prima/dopo) → tetto sulla dimensione del risultato. Gli errori tornano al modello come `{ error, reason }`, mai come eccezioni.

**Set stabile per sessione** (03 A.4): il registry seleziona i tool per categorie abilitate (`TOOL_CATEGORIES`) più il nucleo (`memory_search`, `get_time`), una volta per sessione; il contesto del turno (utente, richiesta, `RunContext`, emettitore di eventi, segnale di annullamento) viene iniettato per riferimento prima di ogni turno. Il meta-tool `tool_search` per cataloghi grandi è rinviato a M9.

**Ricerca web** (M5): **Firecrawl** v2 (`/v2/search` con `scrapeOptions`, `/v2/scrape`; SDK non usato: client `fetch` con schemi Zod sui soli campi letti). Misurato: ricerca con estrazione 3–12 s, scrape ~3 s; 2 crediti per 10 risultati + 1 per pagina estratta. I tool `web_search`/`web_fetch` sanificano il markdown (immagini, link, parametri di tracciamento), lo troncano a 3.000 caratteri per risultato, applicano allow/deny list di domini e marcano la run come contaminata: ogni scrittura o effetto esterno successivo, **anche nei turni seguenti della stessa sessione** (taint persistito in Redis per 30 minuti, perché il contenuto resta nella cronologia), richiede conferma esplicita. Verificato end-to-end con una pagina reale.

**MCP**: adapter opzionale rinviato (M9), con spec 2026-07-28 e solo Streamable HTTP.

**Skill** (M5, `packages/skills`): **deterministiche** come `shopping_list` (parser italiano per aggiungere, togliere, leggere e svuotare; 0 LLM, ~15 ms, risposta via tre eventi) riconosciute dal registry **prima di Jev**; **guidate** (istruzioni + tool consentiti) eseguite dal modello della sessione con la procedura nel turno; le candidate entrano nella domanda `skill_candidate` di Jev. **Skill apprese**: formato markdown (agentskills.io: titolo, descrizione, trigger, tool consentiti, istruzioni), stati `draft → proposed → tested → approved → active → deprecated/rejected`, versioni immutabili per hash, scansione del contenuto alla scrittura e al recupero (niente codice, tool esistenti, lunghezza), classe di rischio alta se usano tool con scrittura o effetti esterni (approvazione solo da un owner), una sola attiva per chiave, rilevamento deterministico delle procedure ripetute dall'audit dei tool (`admin:skills detect/propose/test/approve/activate`). Le skill con **codice generato** restano fuori: richiedono la sandbox gVisor/microVM (M9) e non vengono generate finché non esiste.

## 10. Automation Engine

Realizzato nella M6 (`packages/automations`, migrazione 0009). **Definizioni** in `automations`: chiave per utente, titolo, `kind` (`deterministic` | `guided`), trigger (`cron` con pattern e fuso IANA, `once`, `webhook` con segreto per automazione, `event` con nome), `action` (skill deterministica con la frase da eseguire, oppure istruzioni autosufficienti + allowlist di tool + classe massima + context tag), `budget_usd` per run, `catch_up` (`none` predefinito | `latest`), jitter, notifica, versione; RLS per utente più una policy di sola lettura per lo scheduler (`app.scheduler = on`). Validazione alla creazione: pattern analizzabile, intervallo minimo di 5 minuti, nessuna occorrenza nella fascia 01:00–03:59 del fuso dell'automazione, tool consentiti presenti nel registry, budget per run entro `AUTOMATION_MAX_RUN_BUDGET_USD`.

**Run** in `automation_runs`: una riga per esecuzione, stati `scheduled / claimed / running / succeeded / failed / skipped / budget_exceeded / awaiting_approval`, esito strutturato (`outcome`: riepilogo, dati, azioni sospese) distinto dall'errore infrastrutturale, costo, chiamate LLM e tool, tentativo, sessione. **Idempotenza**: `UNIQUE (automation_id, dedupe_key)` con chiave `cron:<istante pianificato>` (l'ultima occorrenza ≤ ora del tick: uguale per qualunque scheduler e ritardo), `once:<istante>`, `webhook:<idempotency key>`, `event:<id evento>`, `manual:<id>`; il reclamo è un `INSERT … ON CONFLICT` che riprende la riga solo per un retry con numero di tentativo superiore; lo stesso valore è il `jobId` BullMQ. **Scheduler**: job scheduler BullMQ per i cron (uno per automazione e versione, fuso incluso), sincronizzati ogni `AUTOMATION_SYNC_EVERY_S` da ogni worker (idempotente, più worker coesistono); il tick calcola l'istante canonico, applica il jitter e accoda la `run`; una tantum come job ritardato, disabilitata dopo l'esecuzione; `catchUp = none` salta le run più in ritardo di `AUTOMATION_CATCHUP_TOLERANCE_S` + jitter.

**Esecuzione nel worker, senza client.** Deterministica = skill del registry (0 LLM). Guidata = sessione nuova (`client_platform = automation`), Soul dell'utente + context tag, snapshot di memoria, tool = allowlist ∩ registry, decisione del router (classe ≤ quella dell'azione; `light` ammesso perché fuori banda; `riskSignal` nella policy; memorie recuperate se `needs_memory`), prompt autosufficiente con il payload esterno marcato come **dati non fidati** → run tainted (Rule of Two). **Budget per run**: il recorder delle `llm_calls` somma il costo riportato a ogni step e interrompe il turno oltre il tetto → `budget_exceeded`. **Azioni sensibili**: l'executor in modalità `deferred` crea l'approvazione (TTL `AUTOMATION_APPROVAL_TTL_S`), non esegue il tool e risponde `approval_pending` al modello; la run termina `awaiting_approval` con le azioni sospese (tool, argomenti, motivo) nell'esito e una notifica; `POST /v1/approvals/:id` consuma l'approvazione (monouso, legata a tool e hash degli argomenti) ed esegue il tool con gli stessi argomenti, aggiornando la run. **Retry** solo su errori transitori (rete, connessione, 429/5xx): 3 tentativi con backoff esponenziale + jitter, `UnrecoverableError` per il resto; dead-letter = notifica deduplicata per automazione e giorno. **Anti-ricorsione**: il worker non pubblica eventi, `depth > 0` rifiutata.

**Notifiche** in `notifications` (lette all'apertura dell'app: `GET /v1/notifications`) ed evento `automation.run.updated` pubblicato su Redis (`ernie:user-events`) e inoltrato dall'API alle sessioni WebSocket connesse dell'utente. **Webhook**: `POST /v1/webhooks/:id` senza chiave API, firma HMAC-SHA256 del corpo grezzo in `x-ernie-signature`, idempotenza da `x-idempotency-key` (o hash del corpo), lookup tramite funzione `SECURITY DEFINER` che espone solo utente, segreto e stato. **Eventi interni**: `POST /v1/events` dal client e `shopping_list.cleared` emesso dall'API alla chiusura della spesa. CLI `admin:automations` con i preset del caso d'uso guida (`weekly-recipes`, `daily-list`). Rinviato: cifratura a riposo dei segreti webhook e APNs (M7/M9); episodi di memoria per le run.

## 11. Model Gateway

| Classe | Uso | Mappa predefinita (ID da confermare in M2) |
|---|---|---|
| `light` | riassunti, estrazione memoria, prefissi contestuali, titoli (**solo fuori banda**) | `anthropic/claude-haiku-5.5` su OpenRouter (0,10/0,50 $/M); `claude-haiku-5-5` se Anthropic diretto |
| `standard` | conversazione, tool use ordinario | `anthropic/claude-sonnet-5.5` (2/10 $/M); `claude-sonnet-5-5` diretto |
| `heavy` | pianificazione multi-step, analisi, `deepReasoning` | `anthropic/claude-opus-5.5` (4/20 $/M), effort alto; `claude-opus-5-5` diretto |
| `embedding` | memoria semantica | `text-embedding-3-small` (OpenAI) o fastembed, dopo misura |

`resolveModel(class, session)` → istanza `openrouter.chat(id, { usage: { include: true }, extraBody: { cache_control: { type: 'ephemeral' }, session_id }, reasoning })` (spike M2.1: è l'unica via che ottiene cache e costo reale). **Isteresi di sessione** per classe **e per configurazione di ragionamento**: cambiare `reasoning` per richiesta invalida la cache (D1). `maxOutputTokens` sempre esplicito per classe, comprensivo dei reasoning token (OpenRouter verifica il saldo su `max_tokens` e i modelli 5.x ragionano di default). Il ragionamento è attivo di default sui modelli 5.x. Listino `model_prices` versionato per la stima; costo riportato dal provider salvato accanto. Batch API non disponibile via OpenRouter (03 C.4).

## 12. Observability e cost tracking

- Logging pino JSON con redazione (attiva), `requestId`/`correlationId`.
- **`llm_calls` è la fonte di verità dei costi** (03 A.8): una riga **per chiamata HTTP (step)**, non per `generate` (Mastra aggrega `usage` sugli step: C1 dello spike riporta 12.439 token su due chiamate da ~6.220); campi `cost_reported` (`usage.raw.raw.cost` / `providerMetadata.openrouter.usage.cost`), `cost_estimated`, `cost_source`, token input / cache read / cache write / output / reasoning (`usage.raw.inputTokens.*`, `usage.raw.outputTokens.*`), TTFT, latenza; riconciliazione su `GET /api/v1/generation` con i campi `native_tokens_*` (i `tokens_*` normalizzati differiscono: 3.449 vs 5.781); **test contro i doppi conteggi**. `router_decisions` per Jev. `request_metrics` aggregato.
- KPI: costo per richiesta e sessione, **cache hit rate**, tasso di rotte deterministiche, fallback del router, p50/p95 di latenza e TTFT.
- OpenTelemetry opzionale e tardivo (M9): le GenAI semantic conventions sono ancora in sviluppo e senza costo nello standard; se adottate, semconv **fissate**, token solo sugli span di inferenza, contenuti opt-in redatti. Nessuna piattaforma di tracing come dipendenza.

## 13. Client iOS

Realizzato nella M7 (`apps/ios`, SwiftUI, iOS 26, Swift 6 con concorrenza stretta; progetto generato da `project.yml` con XcodeGen). **Decisione dell'utente (11 ott 2026): interfaccia essenziale, una sola schermata in stile chat**, senza schede né comandi ridondanti: in alto lo spazio riservato all'avatar (`AvatarStage`, segnaposto animato consumatore della macchina a stati, sostituito nella M10 dal `WKWebView`), al centro la conversazione, in basso un campo e **un solo pulsante** (microfono da tenere premuto; invio quando c'è testo; stop mentre Ernie parla = barge-in). Le richieste di conferma dei tool (`tool.confirmation.requested`) e le notifiche delle automazioni (`/v1/notifications`, aggiornate a ogni `automation.run.updated` o push) sono **schede dentro la conversazione** con Approva / Rifiuta; l'approvazione richiede lo step-up (Face ID / codice) e per le azioni sospese chiama `POST /v1/approvals/:id`. Menu: nuova conversazione, impostazioni (lettura vocale delle risposte scritte, interruttore di emergenza con step-up, diagnostica, account).

Porting del protocollo v1.1 in Swift: `AgentEvent` Codable con payload per tipo (tipi sconosciuti ignorati), `EventDeduper`, `SequenceTracker` (solo segnalazione: dopo una ripresa il replay porta `seq` inferiori a quello di `session.started`), `SequenceSource`; `ProtocolClient` (actor) su `URLSessionWebSocketTask` con `Authorization: Bearer`, `session.start` con `resumeFromSeq`, ping ogni 25 s non persistito, riconnessione con backoff 1→30 s, una sessione per connessione (nuova conversazione = nuova sessione). Cronologia locale per sessione (JSON in Application Support, protezione completa del file). Chiave e URL nel Keychain. Push: registrazione del token APNs su `POST /v1/devices` (ambiente per build), invio dal worker con autenticazione a token (JWT ES256, HTTP/2), notifiche sempre anche in-app. **Interruttore di emergenza** = `users.settings.killSwitch`: il worker salta ogni run finché è attivo (`PATCH /v1/me/settings`).

**Voce (M7)**: voce a un tocco (tocca → ascolto, ↑ → invio, ✕ → annulla; decisione dell'utente dell'11 ott 2026, al posto del push-to-talk: stato, livello del microfono e trascrizione sempre visibili; modello italiano di SpeechTranscriber scaricato in anticipo con avanzamento); `AVAudioSession` `.playAndRecord` + `.voiceChat` e `setVoiceProcessingEnabled(true)` sull'input node; cattura con `AVAudioEngine`; trascrizione con `SpeechAnalyzer` + `SpeechTranscriber` (iOS 26, asset via `AssetInventory`, risultati volatili, conversione al formato migliore) scelta a runtime se l'italiano è supportato, altrimenti `SFSpeechRecognizer` con rotazione delle richieste ogni 55 s (limite di un minuto); invio come `inputMode: voice`; risposte lette con `AVSpeechSynthesizer` per frasi man mano che arrivano (voce italiana di qualità più alta installata), `willSpeakRangeOfSpeechString` per lo `spokenThroughIndex` del barge-in; latenza per stadio (`LatencyTrace`: rilascio → trascrizione finale → invio → primo token → prima parola) con p50/p95 in Diagnostica. Spike S1 eseguito (docs/research/08): `write()` senza marker con le voci italiane, `speak()` con callback di parola e nessun fonema → lip-sync M10 in variante B.

**Voce** (02 §2.6; 03 A.13–A.14, B.7). Pipeline a cascata (STT → testo → LLM → testo → TTS). Fasi: (1) push-to-talk; (2) conversazione continua **in primo piano** con VAD e fine turno semantico (spike Smart Turn v3 in Core ML; fallback silenzio 500–800 ms); (3) barge-in = stop locale del TTS + `user.cancel` con `spokenThroughIndex` (il testo oltre quell'indice non viene considerato pronunciato). Vincoli verificati: `SpeechTranscriber` iOS 26+, asset via `AssetInventory`, controllo `supportedLocales`/`installedLocales` a runtime (italiano al lancio); `SFSpeechRecognizer` con **limite di 1 minuto** per richiesta (rotazione) e quote giornaliere; `AVAudioSession` `.playAndRecord` + **`setVoiceProcessingEnabled(true)`** per AEC/AGC (il modo `.voiceChat` da solo non basta); nessuna wake word per app terze né avvio del microfono dal background; `AudioRecordingIntent` richiede una Live Activity. **Obiettivo di latenza udibile: p50 < 1,5 s, 800 ms come ambizione**, strumentata per stadio. Contenuti esterni letti ad alta voce con prefisso attributivo (injection vocale). Mute logico del riconoscitore durante la sintesi.

**Avatar** (04; 03 A.15, B.11–B.12, C.13–C.21; decisione utente 10 ott 2026). Richiesta iniziale: avatar tridimensionale con "Unreal Engine o equivalenti". La ricerca verificata ha escluso **Unreal/MetaHuman** per un'app SwiftUI on-device (nessun percorso di embedding iOS documentato; MetaHuman mobile al LOD 3 senza blendshape; lip-sync da audio non supportato a runtime; licenze non verificabili; un'app "UE-first" rinuncerebbe a SwiftUI e alle API iOS 26) e l'utente ha scelto **three.js + TalkingHead in WKWebView**.

Fatti verificati su TalkingHead (repository met4citizen/TalkingHead, MIT, npm `@met4citizen/talkinghead`, three.js 0.180): avatar GLB full-body con rig compatibile Mixamo (root "Armature"), 52 blendshape ARKit e 15 visemi Oculus (`sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, I, O, U`); `speakAudio(audio, opt)` con `words/wtimes/wdurations` oppure `visemes/vtimes/vdurations`; API di streaming `streamStart({ sampleRate, lipsyncLang, lipsyncType: 'words' | 'visemes' | 'blendshapes' })`, `streamAudio({ audio: PCM16LE, words, wtimes, wdurations })`, `streamNotifyEnd()`, `streamInterrupt()`; moduli lingua `modules/lipsync-xx.mjs` (classe `LipsyncXx` con `preProcessText` e `wordsToVisemes` → `{ visemes, times, durations }`), disponibili en, fi, lt, de, fr, pt-br, **italiano assente**; `setMood` (`neutral, happy, angry, sad, fear, disgust, love, sleep`), `playGesture` (`handup, index, ok, thumbup, thumbdown, side, shrug`), `lookAt`, `makeEyeContact`, `playAnimation` (FBX Mixamo); `modelFPS` predefinito 30; testato su desktop e iPad, non documentato su iPhone.

Architettura dell'integrazione:
- **Hosting**: `WKWebView` in un `UIViewRepresentable`; three.js, TalkingHead, moduli lingua e avatar **nel bundle** (nessun codice scaricato: App Review 2.5.2); ponte Swift→JS con `callAsyncJavaScript`, JS→Swift con `WKScriptMessageHandler`.
- **Lip-sync on-device**: `AVSpeechSynthesizer.write(_:toBufferCallback:toMarkerCallback:)` produce PCM e marker con offset in campioni; i marker di parola (garantiti) diventano `words/wtimes/wdurations`; il **modulo `lipsync-it.mjs`** (G2P italiano a regole: c/g contestuali, geminate, accento; riferimento kokorog2p Apache-2.0, **niente eSpeak NG** GPL) converte le parole in visemi. Se lo spike S1 conferma marker fonemici dalle voci italiane, si passa `visemes/vtimes/vdurations` direttamente. Due varianti di riproduzione da decidere in S3: (A) audio riprodotto da TalkingHead (AudioWorklet nel WKWebView) con sincronia garantita; (B) audio riprodotto da `AVSpeechSynthesizer` e TalkingHead pilotato solo dai tempi. La cancellazione d'eco (`setVoiceProcessingEnabled(true)`) va verificata con l'uscita audio del WKWebView.
- **Stato ed espressività**: l'avatar è **consumatore** della macchina a stati Swift (idle / listening / thinking / speaking); barge-in = `stopSpeaking` + `streamInterrupt()` entro un frame; gli eventi `avatar.emotion` dal backend mappano sul vocabolario chiuso `setMood`, `avatar.gesture` su `playGesture`, `avatar.gaze` su `lookAt`.
- **Asset**: **decisione dell'utente (11 ott 2026): l'immagine di Ernie è una mascotte peluche 3D** (corpo morbido blu, cuffie, grandi occhi lucidi, sorriso; riferimento in `docs/assets/ernie-mascot.png`, generata e già usata come icona dell'app e nello spazio avatar della M7), non un volto umano. Per la M10 il GLB va modellato su questa mascotte in Blender con rig compatibile Mixamo (o rig semplificato), 52 blendshape ARKit e 15 visemi Oculus sulla bocca; MPFB/Avaturn/VRoid decadono come sorgenti. Da valutare in S3 anche un rig 2D/2.5D (Rive) come alternativa più leggera per uno stile peluche. Compressione Meshopt via `gltf-transform`; primo download < 200 MB; `modelFPS` 30 e `modelPixelRatio` 1 come base, riduzione con Reduce Motion, stato termico e basso consumo.
- **Spike prima dell'implementazione** (M7–M8): **S1** marker emessi da `speak()`/`write()` con voci italiane compact/enhanced/premium su iOS 26; **S3** WKWebView + TalkingHead su iPhone: FPS, CPU, batteria, termica per 10 minuti, latenza marker→visema, AEC con audio dal WKWebView; **S4** `lipsync-it.mjs` valutato contro un lessico fonetico italiano; **S6** App Thinning Size Report. Lo spike S2 (RealityKit) decade.

## 14. Protocollo client-server

**v1** (realizzato): envelope `{ v: 1, id, sessionId, correlationId, seq, ts, type, payload }`; client→server `session.start` (con `resumeFromSeq`), `user.message`, `user.cancel`, `session.ping`; server→client `session.started`, `assistant.started`, `assistant.text.delta`, `assistant.text.completed`, `tool.started`, `tool.completed`, `assistant.completed` (con `usage`), `assistant.cancelled`, `error`. Direzione e **audience** (`user` / `runtime`) per tipo. Deduplica per `id`, ordinamento per `seq`.

**v1.1** (M2; 03 A.9–A.10): la **run vive indipendentemente dalla connessione**; `user.cancel` **idempotente** e con `spokenThroughIndex`; ripresa = **snapshot + replay** dal log eventi per sessione (Redis, TTL) tramite `resumeFromSeq`; `persist: bool` sugli eventi; auth e controllo **`Origin`** sull'upgrade WS; nessuna connessione verso URL ricevuti da deep link o query string (lezione CVE-2026-25253 OpenClaw); `tool.confirmation.requested/resolved` (approvazioni monouso); **`avatar.emotion {name, intensity}`, `avatar.gesture {name}`, `avatar.gaze {target}`** ancorati a `charOffset` nel testo, con **vocabolario chiuso** (preset VRM / mood TalkingHead) prodotti dall'LLM via output strutturato, mai da testo libero; `automation.*` per lo stato delle automazioni.

**v1.2** (11 ott 2026, richiesta dell'utente: «widget grafici per certi tipi di risposte»): evento `assistant.block {blockId, block}` con **blocchi a schema chiuso** (`web_results`, `list`, `recipes`; Zod in `packages/protocol`, Codable in Swift, tipi sconosciuti ignorati dal client). I blocchi nascono solo da codice deterministico: il gancio `present(input, output)` dei tool nell'executor (`web_search` → risultati, `shopping_list_get/add` → elenco), le skill (`SkillReply.blocks`), e il **tool di presentazione** `present_recipes` (nessun effetto, nessun dato privato) che il modello chiama per mostrare ricette come schede; il testo libero del modello non produce mai markup. L'app li rende come schede native sotto il messaggio: risultati web scorrevoli con link apribili in Safari, lista come checklist, ricette con ingredienti, passaggi, fonte e pulsante «aggiungi gli ingredienti» (che invia una richiesta alla skill deterministica). Stile delle risposte (migrazione 0011 sul Soul core): emoji con misura, elenchi puntati o numerati per liste e ricette; l'app rende il markdown a blocchi e il TTS ignora emoji e marcatori di elenco.

## 15. Sicurezza

- **Autenticazione** (M2): chiavi API per dispositivo (`ernie_…`, hash SHA-256 in `api_keys`, scope, revoca), `Authorization: Bearer` sull'upgrade WebSocket (401 altrimenti), controllo `Origin` (403 se presente e non in allowlist); TLS dal reverse proxy (Caddy, M9) o dal provider.
- **Policy Engine** (03 A.1): **deny → ask → allow** deterministico, fuori dall'LLM, **fail-closed** per tool sconosciuti; approvazione legata a **(tool, hash degli argomenti, utente, scadenza)**, **monouso** e consumata atomicamente; audit append-only con ID approvazione e versione della policy; nessun controllo in punti scavalcabili da una regola allow. Contro l'approval fatigue (~93% dei prompt approvati) i confini sono ambientali, non più finestre di conferma.
- **Rule of Two come taint di run** (03 A.2): quando entra contenuto non fidato (web, webhook, MCP, memoria a `trust` basso) la run è *tainted* e ogni tool `externalEffect` o `write` passa in `ask`; le automazioni con payload esterno partono tainted.
- **Prompt injection**: contenuti esterni delimitati e marcati; schemi Zod su tutti gli input; il taint rende deterministica la regola "mai eseguire azioni su sola istruzione di un tool result".
- **Sandbox** (03 B.1): codice generato **mai nel processo Node**, né con `node:vm` né con `isolated-vm`; container dedicato con **gVisor o microVM**, nessuna rete per default, nessun segreto montato (un proxy esterno allega il token alle sole operazioni approvate), capability droppate, `no-new-privileges`, tmpfs `noexec`, limiti CPU/memoria/tempo/processi, egress con allowlist per dominio trattata come capability.
- **Isolamento dati** (M2): `user_id` su ogni tabella; **RLS `FORCE`** su `users`, `sessions`, `llm_calls`, `souls`, `soul_versions` con ruolo applicativo `ernie_app` (LOGIN impostato dalla CLI di migrazione, privilegi predefiniti sulle tabelle future); ogni unità di lavoro gira in una transazione con `SET LOCAL app.user_id` (`withUser`). Esenzione documentata: `api_keys` (solo hash e metadati, ricerca per hash prima di conoscere l'utente). Le tabelle `mastra_*` non hanno RLS: l'isolamento conversazionale è per `resource` = utente dentro Mastra (limite noto, da rivalutare in M4). Namespace per utente su Redis/BullMQ (M6); validazione di ciò che si scrive in memoria (M4).
- **Segreti**: fuori dal codice (`.env` ignorato; Docker secrets in M9), redazione nei log, rate limiting per chiave, audit immutabile, cifratura dei campi sensibili e retention configurabile (M9).
- Le decisioni di Jev e degli LLM non sostituiscono mai questi controlli.

## 16. Deployment

Docker Compose su VPS: `postgres` (pgvector, volume), `redis` (AOF, volume), `migrate` (one-shot), `api`, `worker`, `litellm` (profilo), dalla M5 `sandbox` (gVisor/microVM). Immagine unica multi-stage (Node 24 alpine, dipendenze di produzione, utente non root). `/health` e `/ready`. Lo stato vive nei volumi (criterio 10); backup Postgres in M9. CI: lint, build, migrazioni, test con Postgres/Redis reali, build immagine, stack e smoke test.

## 17. Ottimizzazione dei token e benchmark

Leve: prefisso stabile e `cache_control` (M2), set di tool stabile + meta-tool (M3/M5), classe con isteresi (M3), snapshot di memoria + `memory_search` (M4), compressione a gradini (M4), skill deterministiche (M5), memoria asincrona (M4), limiti hard e stuck detector (M2–M3), cache esatta delle decisioni (M3). **Benchmark M9** (03 B.8): corpus di 20–50 scenari da fallimenti reali + corpus rappresentativo; bracci **router completo vs miglior modello singolo vs economico fisso vs router casuale**; misure: token (in cache e non), costo reale, latenza, TTFT, qualità (grader deterministici prima, giudice LLM di famiglia diversa calibrato su ~100 esempi), **pass^k (k = 3–5)** per automazioni e azioni sensibili; run ripetute con intervalli di confidenza; valore di Jev misurato separatamente su memoria/tool/skill. Solo questi numeri sostengono affermazioni di risparmio.

## 18. Struttura del repository

```
Ernie/
├── apps/
│   ├── api/               Fastify: health, (M2) WS v1.1, auth, sessioni
│   ├── worker/            BullMQ: job di sistema, (M4) memoria, (M6) automazioni
│   └── ios/               (M7) Xcode SwiftUI; (M10) avatar
├── packages/
│   ├── config/ db/ observability/ protocol/        ✅
│   ├── agent-core/        (M2) runtime, (M3) router deterministico + policy engine
│   ├── jev-router/        (M3)
│   ├── soul/ model-gateway/   (M2)
│   ├── memory/            (M4)
│   ├── tools/ skills/     (M5)
│   └── automations/       (M6)
├── infrastructure/        Dockerfile, LiteLLM, migrazioni SQL, (M5) sandbox
├── tests/                 smoke e2e, (M9) benchmark ed eval
├── docs/                  CONFIGURATION.md, research/ (00–04)
├── docker-compose.yml · ARCHITECTURE.md · IMPLEMENTATION_PLAN.md · README.md
```

## 19. Rischi e punti aperti

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Decisions API di Jev in alpha; soglie `noul` mal centrate | rottura o decisioni sbagliate | adapter isolato, mock, fallback; soglie tarate; telemetria dal M3 |
| Passthrough OpenRouter: **verificato** per cache, costo, `session_id`, `reasoning.effort` (spike M2.1); non verificati tool search nativo, `input_examples`, context editing | leve secondarie incerte | verificare quando servono (M5) |
| Ordine del payload Mastra: **verificato stabile** (system → turni; tool invariati tra turni; hash identico C1/C2) | — | mantenere `instructions`/`tools`/`model` costanti per sessione |
| Saldo OpenRouter esaurito (48 $ su 48 $ all'11 ott 2026) | blocco dei test online e della M2 | ricarica da parte dell'utente; tetto di spesa in configurazione |
| RLS sulle tabelle `mastra_*` | isolamento parziale | verifica in M2; schema dedicato o filtro applicativo |
| Limiti iOS (1 min SFSpeechRecognizer, niente background, asset modelli) | esperienza vocale degradata | fallback e rotazione; modalità continua solo in primo piano |
| Avatar TalkingHead: prestazioni WebGL e consumo su iPhone (non documentati), marker fonemici delle voci italiane, AEC con audio dal WKWebView, modulo italiano da scrivere | qualità e autonomia del lip-sync | spike S1, S3, S4, S6 prima dell'implementazione M10; variante (B) con audio nativo come ripiego |
| Sandbox: complessità operativa di gVisor/microVM su VPS | skill con codice rinviate a M9 | nessuna generazione di codice finché la sandbox non esiste; skill apprese solo in markdown |
| Escalation a `heavy` con isteresi: la soglia `deep_reasoning` 0,35 fa salire la sessione su Opus anche per richieste domestiche (misurato: 9–10× il costo di Sonnet, turni da 0,01–0,04 $ con contenuti web) | costo per sessione | M9: ritarare la soglia su dati reali e valutare l'escalation per turno anziché per sessione |
| Mastra 1.x evolve rapidamente | breaking change | pin, test di integrazione |

## 20. Registro delle modifiche v0.1 → v0.2

Fonte: `docs/research/03-revisione.md` (§5). Adottato subito (A): Policy Engine deny→ask→allow fail-closed con approvazioni monouso (A.1); Rule of Two come taint di run (A.2); prefisso di cache stabile e ordine fisso (A.3); set di tool stabile + meta-tool (A.4); classe di modello con isteresi di sessione, `light` solo fuori banda (A.5); Context Soul e memoria fuori dal prefisso, snapshot congelato + `memory_search` (A.6); budget rigidi e stuck detector (A.7); `llm_calls` fonte di verità dei costi (A.8); protocollo v1.1 (A.9) con eventi `avatar.*` a vocabolario chiuso (A.10); soglie Jev tarate (A.11); RLS `FORCE` (A.12); correzione audio iOS: voice processing e limite di 1 minuto (A.13); obiettivo di latenza vocale (A.14); avatar riformulato: RealityKit / TalkingHead, Unreal e MetaHuman declassati (A.15). Pianificato (B): sandbox gVisor/microVM (B.1), skill agentskills.io con stati e versioni immutabili (B.2), memoria bi-temporale con RRF e LongMemEval (B.3–B.4), tool con JSON Schema 2020-12 e MCP 2026-07-28 (B.5), automazioni con stati e idempotenza (B.6), client iOS (B.7), valutazione con baseline e pass^k (B.8), hardening (B.9), compressione a gradini (B.10), spike avatar S1–S6 (B.11), pipeline lip-sync (B.12). Respinto o in attesa (C): SSE+POST, AG-UI, Temporal, Batch API, keepalive cache, memoria su git, multi-agente, Langfuse/Helicone, cache semantica, speech-to-speech, Unreal embedded, Pixel Streaming, Unity (attesa), Godot (attesa), Audio2Face/OVRLipSync, Ready Player Me/Soul Machines, eSpeak NG, export MetaHuman (attesa), Rive/Live2D (riserva). Confermate senza modifiche: tutte le decisioni di §2 della v0.1 non citate sopra (03 §6).

**v0.2 → v0.3** (decisione utente, 10 ott 2026): avatar su **three.js + TalkingHead in WKWebView**; Unreal/MetaHuman esclusi (app "UE-first" rifiutata); RealityKit scartato come traccia primaria; spike S2 decaduto; aggiunti i fatti verificati su TalkingHead (API `speakAudio`/`stream*`, moduli lingua, requisiti dell'asset) e il modulo `lipsync-it.mjs` come lavoro da svolgere.

**v0.3 → v0.4** (spike M2.1, 11 ott 2026): Model Gateway su istanze `@openrouter/ai-sdk-provider` anziché stringa nativa di Mastra (nessuna cache con la stringa; −92% sulla seconda chiamata con il provider); ID e prezzi dei modelli 5.5 verificati su `/api/v1/models`; `maxOutputTokens` esplicito; configurazione di ragionamento fissa per sessione (cambiarla azzera la cache); `llm_calls` per step HTTP con costo del provider e riconciliazione sui campi nativi di `/api/v1/generation`; assemblaggio del prompt lasciato a Mastra (prefisso verificato stabile); rischi aggiornati, incluso il saldo OpenRouter esaurito.

**v0.4 → v0.5** (M2, 11 ott 2026): modello multi-utente "companion" (`users.role/companion_name/settings`, Soul per utente clonati dai globali, `locked` per policy imposte dall'owner); Soul Engine, Model Gateway, Agent Runtime, API WebSocket v1.1 e `llm_calls` realizzati; RLS attiva con ruolo applicativo; tetto di spesa giornaliero per utente; CLI `admin:create-user`, `bootstrap:storage`; protocollo v1.1 implementato. Verifica M2 nel piano.

**v0.5 → v0.6** (M3, 11 ott 2026): router JEV realizzato (`packages/jev-router`: sette domande, soglie calibrate su 60 esempi, cache esatta, timeout e fallback, `router_decisions`); router deterministico dei comandi; Policy Engine deny → ask → allow con taint di run e approvazioni monouso in `tool_approvals`; isteresi di classe per sessione con ricostruzione dell'agente; rilevatore di loop nel turno; configurazione `JEV_*`/`ROUTER_*`; metriche del router nell'evento `assistant.completed` (`routerTokens`, costo incluso).

**v0.6 → v0.7** (M4, 11 ott 2026): Memory Engine realizzato (migrazione 0007: `memories` con `tsvector` italiano, `vector(1536)` HNSW, provenienza, validità, supersessione, RLS; `memory_cursors`); ricerca ibrida RRF misurata (recall@5 95,8%); snapshot nel prefisso e tool `memory_search` per sessione; memorie recuperate nel turno quando `needs_memory`; consolidamento asincrono nel worker con modello light; episodi deterministici; export, oblio e purge; con Soul + snapshot + tool il prefisso supera i 512 token e la cache dei prompt si attiva (760 token letti al secondo turno, −37% di costo).

**v0.7 → v0.8** (M5, 11 ott 2026): Tool Registry ed Executor (`packages/tools`), tool integrati, Firecrawl per il web, skill deterministica della lista della spesa e ciclo di vita delle skill apprese (`packages/skills`, migrazione 0008 con `tool_calls`, `shopping_items`, `skills`); contaminazione estesa alla sessione (Redis, 30 min); contesto dei tool per turno con pulizia protetta; CLI `admin:skills`; avviso in produzione per password predefinita del database.

**v0.8 → v0.9** (M6, 11 ott 2026): Automation Engine realizzato (`packages/automations`, migrazione 0009: `automations`, `automation_runs`, `notifications`, policy di lettura per lo scheduler, funzione `webhook_target`); chiave di idempotenza generalizzata (`dedupe_key`, per i cron l'istante pianificato canonico) al posto di `automation_id:scheduled_at`; approvazioni differite nell'executor (`mode: deferred`) con esecuzione all'approvazione dell'utente; budget per run tramite il recorder; REST `/v1/automations`, `/v1/runs`, `/v1/notifications`, `/v1/approvals`, `/v1/events`, `/v1/webhooks`; eventi per utente via Redis pub/sub verso le sessioni connesse; fascia notturna 01:00–03:59 e intervallo minimo di 5 minuti validati alla creazione; apostrofo tipografico normalizzato nella skill della spesa; recorder delle decisioni spostato in `@ernie/jev-router`.

**v0.9 → v0.10** (M7, 11 ott 2026): client iOS realizzato (`apps/ios`): una sola schermata in stile chat con spazio per l'avatar e un solo pulsante (decisione dell'utente), schede di conferma e notifica nella conversazione, porting del protocollo, push-to-talk con `SpeechTranscriber`/`SFSpeechRecognizer`, TTS incrementale con barge-in, latenza per stadio, Keychain, step-up, interruttore di emergenza; backend: `GET /v1/me`, `PATCH /v1/me/settings`, `POST /v1/devices` (migrazione 0010), invio push APNs dal worker (JWT ES256 + HTTP/2, configurazione `APNS_*`), `getUserSettings` nel repository delle automazioni; spike S1 misurato (docs/research/08).

**v0.10 → v0.11** (11 ott 2026): immagine di Ernie = mascotte peluche 3D (decisione dell'utente): icona dell'app e spazio avatar nella M7, asset di riferimento in `docs/assets/`, piano M10 aggiornato (GLB modellato sulla mascotte, Rive come alternativa da valutare in S3); pubblicazione su TestFlight: scheda App Store Connect «Ernie» (id 6821598639), gruppo interno «Interni», firma automatica con chiave API; app solo iPhone.

**Sezione Skill** (richiesta dell'utente, 11 ott 2026; `packages/skills/src/catalog.ts`): ogni skill ha un interruttore per utente (`users.settings.skills`), i tool che le appartengono e, se guidata, le istruzioni; `GET/PATCH /v1/skills`. Due livelli: `skillsAvailable` (impostazioni: quali compaiono nel pannello ✦) e `skills` (pannello ✦: quali sono accese); attiva = disponibile ∧ accesa. Un cambio vale nella conversazione in corso: il server rilegge `users.settings` e ricostruisce gli agenti delle sessioni dell'utente al turno successivo (la memoria è per sessione). Spenta una skill, sparisce dal registry deterministico, dalle candidate del router e dal set di tool del modello (`disabledToolIds`), salvo i tool condivisi con una skill accesa; l'app offre gli interruttori in Impostazioni → Skill e apre una nuova conversazione al cambio. Prima skill guidata con dati propri: **Ricette** (migrazione 0012: `recipes` con titolo normalizzato, ingredienti, passaggi, versioni in `recipe_versions`, ricerca full-text; tool `recipe_search/get/save/delete` che presentano schede `recipes`; procedura: cercare tra le salvate, proporre con `present_recipes`, salvare o affinare su richiesta con nuova versione). Le schede ricetta nell'app hanno «Salva», «Affina» (prepara il messaggio) e «Ingredienti» (lista della spesa).

**v0.11 → v0.12** (11 ott 2026): protocollo v1.2 con blocchi strutturati (`assistant.block`: risultati web, elenco, ricette) emessi da tool, skill e dal tool di presentazione `present_recipes`; app iOS con schede native, markdown a blocchi, emoji filtrate dal TTS; Soul core v2 con regole di stile (emoji con misura, elenchi, ricette come schede); lista della spesa a elenco oltre quattro voci; categoria di tool `presentation`.

**v0.12 → v0.13** (11 ott 2026): sezione Skill con interruttori per utente e catalogo; skill «Ricette» con dati versionati e tool `recipe_*`; tool filtrati per skill; build TestFlight 10 (audio più robusto) e 11 (skill e schede).
