# Test

| Livello | Dove | Come gira |
|---|---|---|
| Unitari | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | `pnpm test` (sempre) |
| Integrazione | stessi file, blocchi `describe.skipIf(!DATABASE_URL)` | `pnpm test` con `DATABASE_URL` e `REDIS_URL` impostati (CI: servizi Postgres/Redis) |
| Smoke end-to-end | `tests/smoke.sh` | contro lo stack Docker (`docker compose up -d --wait api && tests/smoke.sh`) |

Dalla M3 in avanti qui vivranno anche i benchmark comparativi (routing intelligente vs modello fisso), come richiesto dal piano.
