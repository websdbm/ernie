# Fonti verificate (10 ottobre 2026)

Verifiche effettuate direttamente sulla documentazione ufficiale durante l'analisi dell'ambiente. I report bibliografici estesi sono in `01-`, `02-`, `04-`; la revisione in `03-`.

## Jev (TypeSafe) — router decisionale

- Documentazione su OpenRouter: https://openrouter.ai/docs/guides/community/jev — decision model non generativo; primitive `choice`, `noul`, `score`; modelli `typesafe/jev-1.13` e alias `~typesafe/jev-latest`; Decisions API `POST https://openrouter.ai/api/alpha/decisions`; System One API `POST https://openrouter.ai/api/v1/systemone`; contesto 32k; output gratuito.
- Tutorial con esempi di richiesta/risposta: https://openrouter.ai/docs/guides/community/jev-tutorial — struttura `state` + `questions`, risposta con `answers` e `usage.cost`; domande indipendenti e parallele; pin del modello per soglie stabili.
- Spiegazione e prezzi: https://openrouter.ai/blog/insights/what-is-jev/ — $0,042/M token input, $0 output (21 set 2026); casi d'uso: routing, classificazione, gating di azioni, verifica.
- SDK TypeScript: https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README — pacchetto `@openrouter/sdk`, `openRouter.alpha.decisions.create({ decisionsRequest })`, classi di errore per codice HTTP.
- Jev Router (modello OpenAI-compatibile che sceglie modello ed effort): https://openrouter.ai/typesafe/jev-router
- Non ufficiali / terzi: plugin Hermes `jev-model-router` (https://hermes-agent.nousresearch.com/docs/plugins/jev-model-router), hub comunitario jevai.org.

## Mastra (framework agentico)

- Indice documentazione: https://mastra.ai/llms.txt (ogni pagina è leggibile come Markdown aggiungendo `.md`).
- Agent: https://mastra.ai/reference/agents/agent.md — `instructions`, `model`, `tools`, `memory` statici o funzioni del `requestContext`; `hooks` (`beforeToolCall`, `afterToolCall`); processori di input/output.
- Modelli: https://mastra.ai/models.md — stringhe `provider/model`, credenziali da env, endpoint OpenAI-compatibili con `{ id, url }`, istanze AI SDK, `providerOptions`.
- Streaming: https://mastra.ai/reference/streaming/agents/stream.md — `agent.stream(messages, options)` con `memory: { thread, resource }`, `maxSteps`, `abortSignal`, `onFinish`, `onChunk`, `modelSettings`; ritorna `MastraModelOutput` (`textStream`, `fullStream`, `text`).
- PostgreSQL: https://mastra.ai/integrations/databases/postgresql.md — `@mastra/pg`, `PostgresStore` (tabelle `mastra_threads`, `mastra_messages`, …, auto-migrazione, `disableInit`).
- PgVector: https://mastra.ai/reference/vectors/pg.md — indici `flat`/`hnsw`/`ivfflat`, metriche `cosine`/`euclidean`/`dotproduct`, estensione creata automaticamente.
- Memory: https://mastra.ai/reference/memory/memory-class.md — `lastMessages`, `messageHistory.maxTokens`, `semanticRecall` (`topK`, `messageRange`, `scope`), `workingMemory`, `observationalMemory`.
- Fastify: https://mastra.ai/reference/server/fastify-adapter.md — `@mastra/fastify` (`MastraServer`), `createAuthMiddleware`; non adottato per ora (ARCHITECTURE.md §2).
- Versioni npm al 10 ott 2026: `@mastra/core` 1.75.0, `@mastra/pg` 1.30.0, `@mastra/memory` 1.36.0, `@mastra/fastify` 1.5.19; Node ≥ 22.13; Zod ^3.25 || ^4.

## Apple Speech

- `SpeechTranscriber` (Speech framework): https://developer.apple.com/documentation/speech/speechtranscriber — iOS 26+; `supportedLocales`/`installedLocales`/`isAvailable`; modelli gestiti dal sistema (`AssetInventory`); `DictationTranscriber` e `SFSpeechRecognizer` come alternative.
- Panoramica indipendente: https://blog.addpipe.com/apple-speechanalyzer-api/ — on-device, lingue al lancio (incl. italiano), nessuna chiamata di rete nel percorso di trascrizione.
- Guida pratica: https://antongubarenko.substack.com/p/ios-26-speechanalyzer-guide

## Infrastruttura

- LiteLLM proxy: https://docs.litellm.ai/docs/proxy/docker_quick_start — immagine `docker.litellm.ai/berriai/litellm`, `LITELLM_MASTER_KEY`, `config.yaml` con `model_list`; DB necessario per virtual key e spend tracking.
- BullMQ connessioni: https://docs.bullmq.io/guide/connections — ioredis predefinito (da installare), `maxRetriesPerRequest: null` per i worker, backend astratto in v6.
- Firecrawl Search: https://docs.firecrawl.dev/features/search — `POST https://api.firecrawl.dev/v2/search`, SDK `firecrawl`, `scrapeOptions.formats`, 2 crediti/10 risultati. Verifica reale (11 ott 2026): risposta `{ success, data: { web: [{ url, title, description, markdown, metadata, position }] }, creditsUsed }`; `/v2/scrape` → `{ data: { markdown, metadata } }`; latenze 2,8–11,9 s per la ricerca con estrazione, 2,8 s lo scrape; una pagina YouTube ha restituito 2 MB di markdown (troncato dal tool).
- pnpm 11 impostazioni: https://pnpm.io/settings — `allowBuilds` in `pnpm-workspace.yaml`.
- Hermes Agent (riferimento funzionale): https://hermes-agent.nousresearch.com/docs

## Avatar: TalkingHead (verifica del 10 ott 2026)

- Repository: https://github.com/met4citizen/TalkingHead — licenza MIT; npm `@met4citizen/talkinghead`; import map con `three@0.180.0`; avatar GLB full-body con rig Mixamo (root "Armature"), 52 blendshape ARKit e 15 visemi Oculus (`sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, I, O, U`); `speakAudio(audio, opt)` con `words/wtimes/wdurations` o `visemes/vtimes/vdurations`; streaming `streamStart`/`streamAudio`/`streamNotifyEnd`/`streamInterrupt`/`streamStop` (AudioWorklet, PCM 16-bit LE, `lipsyncType: words|visemes|blendshapes`); moduli lingua `modules/lipsync-xx.mjs` (classe `LipsyncXx`, `preProcessText`, `wordsToVisemes`) per en, fi, lt, de, fr, pt-br — italiano assente; `setMood` (neutral, happy, angry, sad, fear, disgust, love, sleep), `playGesture` (handup, index, ok, thumbup, thumbdown, side, shrug), `lookAt`, `makeEyeContact`, `playAnimation` (FBX Mixamo); `modelFPS` 30 di default; testato su desktop e iPad, non documentato su iPhone. Fonti di avatar citate dal README: Avaturn (gratuito solo non commerciale), VRoid Studio, Avatar SDK, MPFB (Blender), Microsoft RocketBox (MIT, da ri-riggare).
- Model3DView (frzi/swiftui-model3dview): https://swiftpackageindex.com/frzi/swiftui-model3dview — viewer SwiftUI su SceneKit (glTF/OBJ, orbit controls, IBL), MIT, ultima release 0.1.1 circa quattro anni fa; nessuna API per blendshape o animazioni scheletriche: inadatto come motore dell'avatar.

## OpenRouter (verifiche dell'11 ott 2026)

- `GET https://openrouter.ai/api/v1/models`: 458 modelli; Anthropic 5.5 disponibili con prezzi (vedi ARCHITECTURE.md §11); `typesafe/jev-router` presente, `typesafe/jev-1.13` solo via Decisions API.
- Prompt caching: https://openrouter.ai/docs/features/prompt-caching — Anthropic: `cache_control` top-level automatico o breakpoint espliciti (max 4), min 512 token sui modelli 5.x, TTL 5 min (1 h con `ttl`), scrittura 1,25×, lettura 0,1×; report in `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens`, `cache_discount`; `session_id` per sticky routing (10 min).
- Provider AI SDK: https://github.com/OpenRouterTeam/ai-sdk-provider — `@openrouter/ai-sdk-provider` 3.x per `ai@^7`; `usage: { include: true }`, `extraBody`, `headers`, `providerOptions.openrouter.{cacheControl, reasoning}`; costo in `providerMetadata.openrouter.usage.cost`.
- Spike M2.1 (misure reali): `docs/research/05-spike-openrouter-passthrough.md`.
- Decisions API di Jev, chiamata reale dell'11 ott 2026: risposta `{ model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', answers, usage: { input_tokens: 898, output_tokens: 194, cost: 0.0000377 }, id }`, latenza 836 ms sulla prima chiamata, poi p50 256 ms su 60 chiamate; `choice` restituisce `choice`, `probabilities`, `confidence`; `noul` restituisce `noul`. Calibrazione in `06-calibrazione-jev.md`.

## Embeddings e memoria (11 ott 2026)

- AI SDK `embedMany` (https://ai-sdk.dev/docs/ai-sdk-core/embeddings): `embedMany({ model: openai.embedding('text-embedding-3-small'), values, maxParallelCalls })` → `embeddings`, `usage.tokens`; `cosineSimilarity` esportata da `ai`.
- Mastra `memory.recall({ threadId, resourceId, perPage: false, orderBy })` → `messages` in formato DB (`role`, `content` stringa o `{ parts: [{ type: 'text', text }] }`, `createdAt`).
- Misure proprie: `docs/research/07-valutazione-memoria.md` (recall@k), spike M2.1 per la cache: con il prefisso oltre 512 token la lettura dalla cache è confermata nei turni reali (760 token).

## Versioni verificate (npm, 10 ott 2026)

fastify 5.12.5 · zod 4.6.5 · typescript 5.9.3 (7.0.2 disponibile) · vitest 5.0.3 · pg 8.23.1 · bullmq 6.3.12 · ioredis 5.11.1 · pino 10.4.0 · @biomejs/biome 2.5.15 · @openrouter/sdk 1.4.25 · @anthropic-ai/sdk 0.133.0 · ai 7.0.137 · @ai-sdk/anthropic 4.0.78 · @ai-sdk/openai 4.0.91
