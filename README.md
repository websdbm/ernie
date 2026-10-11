# Ernie

Agente AI personale persistente: backend TypeScript (Fastify + Mastra + PostgreSQL/pgvector + Redis/BullMQ) con routing decisionale **Jev** e client **iOS** nativo a interazione vocale.

- Architettura e decisioni: [ARCHITECTURE.md](ARCHITECTURE.md)
- Piano per milestone e stato: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Casi d'uso guida: [docs/USE_CASES.md](docs/USE_CASES.md)
- Variabili d'ambiente: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- Fonti e ricerca bibliografica: [docs/research/](docs/research/)

## Requisiti

Node ≥ 24, pnpm 11 (`packageManager` nel `package.json`), Docker con Compose v2.

## Avvio rapido (sviluppo)

```bash
cp .env.example .env            # inserisci OPENROUTER_API_KEY per parlare con Ernie
pnpm install
docker compose up -d --wait postgres redis
pnpm migrate up                 # migrazioni + ruolo applicativo ernie_app
pnpm bootstrap:storage          # tabelle Mastra (come proprietario)
pnpm admin:create-user -- --name "Alessandro" --companion Ernie --role owner   # stampa API_KEY una volta
pnpm dev:api                    # http://localhost:3000/health · /ready · ws://localhost:3000/v1/ws
pnpm dev:worker                 # in un altro terminale
```

Comandi deterministici in chat (nessuna chiamata a modelli): `/aiuto`, `/stato`, `/classe heavy`, `/contesto cucina`.

Prova da terminale (protocollo WebSocket v1):

```bash
ERNIE_API_KEY=ernie_... pnpm --filter @ernie/tests demo:chat "Ciao, presentati in una frase"
```

In locale Postgres è su `localhost:5433` e Redis su `localhost:6380` (vedi `.env.example`).

## Stack completo in Docker

```bash
docker compose up -d --build --wait api worker
tests/smoke.sh http://localhost:3000
```

Il servizio `migrate` applica le migrazioni prima di `api`; `--profile litellm` aggiunge il gateway LiteLLM opzionale.

## Verifica

```bash
pnpm lint && pnpm build && pnpm test
```

I test di integrazione (Postgres/Redis reali) girano quando `DATABASE_URL` e `REDIS_URL` sono impostati; altrimenti vengono saltati. La CI (`.github/workflows/ci.yml`) esegue lint, build, migrazioni, test, build dell'immagine, avvio dello stack e smoke test.

## Struttura

```
apps/api         API HTTP/WebSocket (Fastify)
apps/worker      job BullMQ (memoria, automazioni)
apps/ios         client SwiftUI (M7)
packages/*       config · db · observability · protocol · (M2+) agent-core, jev-router, soul, memory, tools, skills, automations, model-gateway
infrastructure/  Dockerfile, config LiteLLM, migrazioni SQL
tests/           smoke test e (M9) benchmark
docs/            configurazione, ricerca
```
