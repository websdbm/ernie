# Configurazione

Tutte le variabili sono validate all'avvio da `@ernie/config` (`packages/config/src/env.ts`). Una variabile con valore vuoto equivale a "non impostata". Valori non validi fermano l'avvio con un messaggio che elenca i problemi.

| Variabile | Obbligatoria | Default | Descrizione |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` abilita i log leggibili; `production` nei container. |
| `SERVICE_NAME` | no | `ernie` | Nome nei log e in `/health`. |
| `APP_VERSION` | no | `0.0.0-dev` | Versione esposta da `/health`; in Docker impostata dall'argomento di build. |
| `HOST` / `PORT` | no | `0.0.0.0` / `3000` | Bind dell'API. |
| `LOG_LEVEL` | no | `info` | `fatal` … `trace`, `silent`. |
| `DATABASE_URL` | **sì** | — | `postgres://user:pass@host:port/db`. In locale con Docker: `postgres://ernie:ernie@localhost:5433/ernie`. |
| `DATABASE_POOL_MAX` | no | `10` | Connessioni massime del pool. |
| `REDIS_URL` | **sì** | — | `redis://host:port`. In locale con Docker: `redis://localhost:6380`. |
| `OPENROUTER_API_KEY` | dalla M2 | — | Modelli di chat via OpenRouter e Decisions API di Jev. |
| `OPENAI_API_KEY` | dalla M4 | — | Embeddings (`text-embedding-3-small`). |
| `ANTHROPIC_API_KEY` | opzionale | — | Se presente, i modelli Anthropic possono essere chiamati direttamente. |
| `FIRECRAWL_API_KEY` | dalla M5 | — | Ricerca ed estrazione web. |

## Variabili solo per Docker Compose

| Variabile | Default | Uso |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `ernie` / `ernie` / `ernie` | Credenziali del container Postgres; compongono `DATABASE_URL` interno. |
| `POSTGRES_PORT` | `5433` | Porta esposta su `127.0.0.1` (evita conflitti con un Postgres locale su 5432). |
| `REDIS_PORT` | `6380` | Porta esposta su `127.0.0.1`. |
| `API_PORT` | `3000` | Porta pubblica dell'API. |
| `LITELLM_MASTER_KEY`, `LITELLM_PORT` | — / `4000` | Solo con `--profile litellm`. |

## Dove vivono i segreti

- In locale: file `.env` nella radice (ignorato da git). `pnpm dev:*` e `pnpm migrate` lo caricano con `--env-file-if-exists`.
- In Docker Compose: `env_file: .env` (facoltativo) per le chiavi dei provider; `DATABASE_URL` e `REDIS_URL` sono sovrascritte con gli host interni dei servizi.
- In CI: variabili d'ambiente del job; nessuna chiave di provider è necessaria per la M1.
- Mai nel codice, mai nei log: `redactConfig()` e la redazione di pino coprono chiavi, password e header di autorizzazione.
