# Configurazione

Tutte le variabili sono validate all'avvio da `@ernie/config` (`packages/config/src/env.ts`). Una variabile con valore vuoto equivale a "non impostata". Valori non validi fermano l'avvio con un messaggio che elenca i problemi.

| Variabile | Obbligatoria | Default | Descrizione |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` abilita i log leggibili; `production` nei container. |
| `SERVICE_NAME` | no | `ernie` | Nome nei log e in `/health`. |
| `APP_VERSION` | no | `0.0.0-dev` | Versione esposta da `/health`; in Docker impostata dall'argomento di build. |
| `HOST` / `PORT` | no | `0.0.0.0` / `3000` | Bind dell'API. |
| `LOG_LEVEL` | no | `info` | `fatal` … `trace`, `silent`. |
| `DATABASE_URL` | **sì** | — | Connessione delle app con il **ruolo applicativo** `ernie_app` (RLS attiva). In locale con Docker: `postgres://ernie_app:ernie_app@localhost:5433/ernie`. |
| `MIGRATIONS_DATABASE_URL` | no | = `DATABASE_URL` | Connessione del **proprietario**, usata da migrazioni, `bootstrap:storage` e `admin:create-user`. |
| `APP_DB_PASSWORD` | consigliata | — | Password che la CLI di migrazione assegna al ruolo `ernie_app` (LOGIN). Senza, il ruolo resta senza accesso. |
| `DATABASE_POOL_MAX` | no | `10` | Connessioni massime del pool. |
| `REDIS_URL` | **sì** | — | `redis://host:port`. In locale con Docker: `redis://localhost:6380`. |
| `OPENROUTER_API_KEY` | dalla M2 | — | Modelli di chat via OpenRouter e Decisions API di Jev. |
| `OPENAI_API_KEY` | dalla M4 | — | Embeddings (`text-embedding-3-small`). |
| `ANTHROPIC_API_KEY` | opzionale | — | Se presente, i modelli Anthropic possono essere chiamati direttamente. |
| `FIRECRAWL_API_KEY` | dalla M5 | — | Ricerca ed estrazione web. |
| `WS_ALLOWED_ORIGINS` | no | vuoto | Origin ammessi sull'upgrade WebSocket (CSV). I client nativi non inviano Origin e passano sempre. |
| `LLM_DAILY_BUDGET_USD` | no | `2` | Tetto di spesa giornaliero per utente (UTC) se `users.settings.dailyBudgetUsd` non è impostato. `0` disabilita il controllo. |
| `MODEL_LIGHT` / `MODEL_STANDARD` / `MODEL_HEAVY` | no | `anthropic/claude-haiku-5.5` / `-sonnet-5.5` / `-opus-5.5` | ID OpenRouter per classe di modello. |
| `JEV_MODEL` | no | `typesafe/jev-1.13` | Modello decisionale (Decisions API di OpenRouter). Pinnare la versione per soglie stabili. |
| `JEV_TIMEOUT_MS` | no | `1500` | Oltre questo tempo il router usa il fallback deterministico. Latenza misurata: p50 256 ms, p95 336 ms. |
| `ROUTER_CACHE_TTL_S` | no | `600` | TTL della cache esatta delle decisioni (Redis). `0` disabilita di fatto la cache. |
| `ROUTER_THRESHOLDS_FILE` | no | `infrastructure/router/thresholds.json` | Soglie per domanda, prodotte da `pnpm --filter @ernie/tests calibrate:jev --write`. |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | Modello OpenAI per gli embeddings (1536 dimensioni, come la colonna `memories.embedding`). Senza `OPENAI_API_KEY` la memoria usa un embedder finto: solo full-text. |
| `MEMORY_SNAPSHOT_MAX_CHARS` | no | `2000` | Lunghezza massima dello snapshot di memoria nel prefisso di sessione. |
| `MEMORY_RETRIEVAL_LIMIT` | no | `4` | Memorie recuperate per turno quando il router indica `needs_memory`; `0` disabilita. |
| `MEMORY_CONSOLIDATION_DELAY_S` | no | `20` | Ritardo del job di consolidamento dopo un turno (un job per thread al minuto). |
| `MEMORY_RETENTION_DAYS` | no | `30` | Dopo quanti giorni i ricordi cancellati vengono eliminati fisicamente (purge notturno del worker). |

## Variabili solo per Docker Compose

| Variabile | Default | Uso |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `ernie` / `ernie` / `ernie` | Credenziali del container Postgres; compongono `DATABASE_URL` interno. |
| `POSTGRES_PORT` | `5433` | Porta esposta su `127.0.0.1` (evita conflitti con un Postgres locale su 5432). |
| `REDIS_PORT` | `6380` | Porta esposta su `127.0.0.1`. |
| `API_PORT` | `3000` | Porta pubblica dell'API. |
| `LITELLM_MASTER_KEY`, `LITELLM_PORT` | — / `4000` | Solo con `--profile litellm`. |

## Comandi di amministrazione

```bash
pnpm migrate up            # migrazioni SQL + LOGIN/password del ruolo ernie_app (richiede APP_DB_PASSWORD)
pnpm bootstrap:storage     # tabelle mastra_* create dal proprietario
pnpm admin:create-user -- --name "Alessandro" --companion Ernie --role owner
pnpm --filter @ernie/tests calibrate:jev --write   # ricalibra le soglie del router (≈ 0,002 USD)
pnpm --filter @ernie/tests eval:memory --write     # misura recall@k del recupero (OpenAI, < 0,001 USD)
```

`admin:create-user` stampa una sola volta `API_KEY=ernie_…`: va conservata dal client (Keychain su iOS). Ogni utente ottiene una copia personale dei Soul globali, modificabile in seguito.

## Dove vivono i segreti

- In locale: file `.env` nella radice (ignorato da git). `pnpm dev:*` e `pnpm migrate` lo caricano con `--env-file-if-exists`.
- In Docker Compose: `env_file: .env` (facoltativo) per le chiavi dei provider; `DATABASE_URL` e `REDIS_URL` sono sovrascritte con gli host interni dei servizi.
- In CI: variabili d'ambiente del job; nessuna chiave di provider è necessaria per la M1.
- Mai nel codice, mai nei log: `redactConfig()` e la redazione di pino coprono chiavi, password e header di autorizzazione.
