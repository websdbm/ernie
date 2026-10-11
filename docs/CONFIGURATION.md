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
| `FIRECRAWL_API_KEY` | per i tool web | — | Ricerca ed estrazione web (Firecrawl v2). Senza chiave i tool `web_*` non vengono registrati. Misurato: ricerca con estrazione 3–12 s, scrape ~3 s. |
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
| `TOOL_CATEGORIES` | no | `utility,memory,shopping_list,web,presentation,recipes,documents` | Categorie di tool abilitate nelle sessioni (set stabile per sessione; `memory_search`, `get_time` e `present_recipes` sono sempre presenti). |
| `TOOL_APPROVAL_TTL_S` | no | `120` | Validità di una richiesta di conferma di un tool; scaduta, l'azione è negata. |
| `POLICY_RISK_ASK_THRESHOLD` | no | `0.75` | Con segnale di rischio del router oltre questa soglia, i tool con effetti esterni richiedono conferma. |
| `WEB_ALLOWED_DOMAINS` / `WEB_BLOCKED_DOMAINS` | no | vuoto | Allow/deny list di domini (CSV) per `web_search` e `web_fetch`. |
| `AUTOMATION_MAX_RUN_BUDGET_USD` | no | `0.5` | Tetto al `budgetUsd` per run che un utente può assegnare a un'automazione; oltre il budget la run guidata viene interrotta (`budget_exceeded`). |
| `AUTOMATION_APPROVAL_TTL_S` | no | `604800` (7 giorni) | Validità delle approvazioni differite create dalle run headless (`awaiting_approval`). |
| `AUTOMATION_CATCHUP_TOLERANCE_S` | no | `900` | Con `catchUp = none`, una run cron in ritardo oltre questa soglia (più il jitter) viene saltata. |
| `AUTOMATION_SYNC_EVERY_S` | no | `60` | Ogni quanto il worker allinea i job scheduler BullMQ alle automazioni abilitate. |
| `AUTOMATION_CONCURRENCY` | no | `2` | Run di automazione eseguite in parallelo da ciascun worker. |
| `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_PRIVATE_KEY` | per le push | — | Autenticazione APNs a token (chiave `.p8` in PEM; le sequenze `\n` letterali sono accettate). Senza le tre variabili il worker non invia push: le notifiche restano in-app (`/v1/notifications`). |
| `APNS_BUNDLE_ID` | no | `com.websdbm.ernie` | `apns-topic` delle push; deve coincidere con il bundle id dell'app iOS. L'ambiente (sandbox o produzione) è per dispositivo, dichiarato dall'app alla registrazione (`POST /v1/devices`). |

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
pnpm admin:skills -- detect --user <uuid>          # procedure ripetute; poi propose/test/approve/activate/reject --id <uuid>
pnpm admin:automations -- create --user <uuid> --preset weekly-recipes|daily-list   # oppure --file def.json
pnpm admin:automations -- list|runs|run-now|enable|disable|remove|notifications --user <uuid> [--id <uuid>]
```

Le stesse operazioni sono esposte via REST con la chiave API dell'utente: `GET/POST /v1/automations`, `GET/PATCH/DELETE /v1/automations/:id`, `GET /v1/automations/:id/runs`, `POST /v1/automations/:id/run`, `GET /v1/runs`, `GET /v1/notifications?unread=true`, `POST /v1/notifications/read`, `POST /v1/approvals/:id` (`approve` | `deny`), `POST /v1/events`. I webhook (`POST /v1/webhooks/:id`) non usano la chiave API: firma HMAC-SHA256 del corpo grezzo nell'header `x-ernie-signature` (`sha256=<hex>`) con il segreto mostrato alla creazione, idempotenza con `x-idempotency-key`.

`admin:create-user` stampa una sola volta `API_KEY=ernie_…`: va conservata dal client (Keychain su iOS). Ogni utente ottiene una copia personale dei Soul globali, modificabile in seguito.

## Dove vivono i segreti

- In locale: file `.env` nella radice (ignorato da git). `pnpm dev:*` e `pnpm migrate` lo caricano con `--env-file-if-exists`.
- In Docker Compose: `env_file: .env` (facoltativo) per le chiavi dei provider; `DATABASE_URL` e `REDIS_URL` sono sovrascritte con gli host interni dei servizi.
- In CI: variabili d'ambiente del job; nessuna chiave di provider è necessaria per la M1.
- Mai nel codice, mai nei log: `redactConfig()` e la redazione di pino coprono chiavi, password e header di autorizzazione.
