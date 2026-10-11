# Spike M2.1 — Passthrough OpenRouter e payload di Mastra

Eseguito l'11 ottobre 2026 con `tests/spikes/openrouter-passthrough.ts` (`pnpm --filter @ernie/tests spike:openrouter`). Modello `anthropic/claude-haiku-5.5`, prefisso di sistema di 13.688 caratteri (5.781 token nativi: l'italiano con il tokenizer Claude pesa ~2,4 caratteri per token), `max_tokens` 200. Costo totale dello spike ≈ 0,0035 $. Output grezzo in `tests/out/` (non versionato).

## Domande e risposte

| # | Domanda | Risposta | Evidenza |
|---|---|---|---|
| 1 | La stringa `openrouter/...` di Mastra ottiene cache hit? | **No.** Il corpo contiene solo `model`, `max_tokens`, `messages`; nessun `cache_control`. Due chiamate identiche: 0 token letti e 0 scritti in cache, costo 0,000580 $ ciascuna. Internamente Mastra usa `@openrouter/ai-sdk-provider` 2.10 (spec AI SDK v6), non un adapter generico. | A1, A2 |
| 2 | Con l'istanza `@openrouter/ai-sdk-provider` 3.1 passata a Mastra, `usage.include`, `cache_control` automatico e `session_id` arrivano? Il costo torna? | **Sì a tutto.** B1: `cache_write_tokens` 5.777, costo 0,000725 $ (1,25×). B2: `cached_tokens` 5.777, costo 0,000060 $ (**−92%**). Costo in `providerMetadata.openrouter.usage.cost` e in `usage.raw.raw.cost`. | B1, B2 |
| 3 | Ordine del payload e stabilità del prefisso con i tool | Mastra serializza `instructions` come primo messaggio `role: system` (contenuto array `[{type:'text'}]`), poi i turni; il provider aggiunge `usage`, `cache_control`, `session_id`, `tools`, `tool_choice`. Hash di (model, system, tools) **identico** tra C1 e C2. C2: 6.188 token letti dalla cache con i tool presenti. OpenRouter traduce verso l'API Anthropic, dove i tool precedono il system: l'ordine delle chiavi JSON lato OpenAI-compatibile non conta. | C1, C2 |
| 4 | `reasoning.effort` passa via `providerOptions.openrouter`? | **Passa** (`reasoning: { effort: 'low' }` nel corpo), ma la richiesta **non colpisce la cache** scritta da B (0 letti, 5.788 scritti): cambiare la configurazione di ragionamento cambia la chiave di cache. | D1 |
| 5 | `GET /api/v1/generation` riconcilia? | **Sì.** `total_cost` 0,00006017 $ = costo riportato in B2; `native_tokens_cached` 5.777; `cache_discount` 0,00052 $; provider "Claude Platform on AWS"; snapshot `claude-haiku-5.5-20261007`. Usare i campi `native_tokens_*` (i `tokens_*` sono normalizzati con un altro tokenizer: 3.449 vs 5.781). | E |

## Altre osservazioni

- **`max_tokens` va sempre impostato.** Senza, OpenRouter assume il massimo del modello (65.536) e verifica il saldo su quel valore: con saldo basso risponde 402 anche per una richiesta da pochi token. I reasoning token contano dentro `max_tokens` (C2 ha terminato con `finish = length` a 200 token, 174 dei quali di ragionamento).
- **Il ragionamento è attivo di default** sui modelli 5.x anche senza parametri: in C2 Haiku 5.5 ha speso 174 token di ragionamento per rispondere all'ora.
- **Mastra aggrega `usage` su tutti gli step** di una `generate` (C1: `inputTokens` 12.439 su due chiamate HTTP da ~6.220). Per `llm_calls` serve registrare per step (`steps[].usage` o `onStepFinish`), non il totale, altrimenti si contano due volte i prefissi.
- **Campi `usage` di Mastra**: `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens`, `cacheCreationInputTokens`, `raw.inputTokens.{total,noCache,cacheRead,cacheWrite}`, `raw.outputTokens.{total,text,reasoning}`, `raw.raw` (usage OpenRouter con `cost` e `cost_details`).
- **Schema dei tool**: Mastra converte Zod in JSON Schema **draft-07** (`$schema` esplicito, `additionalProperties: false`), non 2020-12.
- **Saldo del conto**: `/api/v1/credits` → `total_credits` 48, `total_usage` 48,09: il credito OpenRouter è esaurito. Da ricaricare prima di proseguire con test online.

## Decisioni derivate (ARCHITECTURE.md v0.4)

1. Il Model Gateway costruisce i modelli con **`@openrouter/ai-sdk-provider`** (`createOpenRouter` + `chat(id, { usage: { include: true }, extraBody: { cache_control, session_id } })`), non con la stringa `openrouter/...`.
2. **`maxOutputTokens` esplicito** per classe, comprensivo del budget di ragionamento.
3. **Configurazione di ragionamento fissa per sessione** (come la classe di modello): non si alterna `reasoning` per richiesta.
4. **`llm_calls` per step HTTP**, con `cost` del provider e riconciliazione su `/api/v1/generation` (campi nativi).
5. L'assemblaggio del prompt può restare a Mastra: il prefisso è stabile se `instructions`, `tools` e `model` non variano per richiesta (disciplina già prevista in A.3–A.6).
