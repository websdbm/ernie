# Deploy su staging3

Ernie gira su **staging3** (Ubuntu 24.04, 8 CPU, 24 GB; nodo Tailscale `staging3`, IP pubblico dietro Caddy) con la stessa
convenzione degli altri progetti del server: **Docker rootless** dell'utente `staging3` (il demone Docker di root è
mascherato di proposito), progetto in `/srv/staging3/projects/ernie`, porte solo su `127.0.0.1`, Caddy davanti con
certificato automatico.

- URL pubblico: `https://ernie.staging3.eklettica.it` (API REST e WebSocket `/v1/ws`); è l'indirizzo da inserire nell'app.
- Porte locali: API `127.0.0.1:18120`, Postgres `127.0.0.1:18121`, Redis `127.0.0.1:18122` (variabili `API_PORT`, `POSTGRES_PORT`, `REDIS_PORT` nel `.env` del server).
- Segreti: `/srv/staging3/projects/ernie/.env` (chiavi dei provider, password del database generate al deploy); mai nel repository.
- Firewall (ufw): aperti solo 80/443 pubblici e SSH via Tailscale; i container non pubblicano porte all'esterno.

## Comandi (come root sul server)

```bash
R="sudo -u staging3 env DOCKER_HOST=unix:///run/user/1002/docker.sock XDG_RUNTIME_DIR=/run/user/1002 HOME=/srv/staging3"
cd /srv/staging3/projects/ernie
git pull
$R docker compose build
$R docker compose up -d --force-recreate --wait migrate api worker
$R docker compose ps
curl -s https://ernie.staging3.eklettica.it/health
```

Log: `$R docker compose logs --since 10m api worker`.

## Prima installazione (fatta il 12 ott 2026)

1. `git clone https://github.com/websdbm/ernie.git /srv/staging3/projects/ernie` e `chown -R staging3:staging3`.
2. `.env` con `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `API_PORT=127.0.0.1:18120`, `POSTGRES_PORT=127.0.0.1:18121`, `REDIS_PORT=127.0.0.1:18122`.
3. Sito in `/etc/caddy/Caddyfile` (`ernie.staging3.eklettica.it` → `reverse_proxy 127.0.0.1:18120`, header noindex), `caddy validate`, `systemctl reload caddy`.
4. Dati dal Mac: `docker exec -i ernie-postgres-1 pg_dump -U ernie -Fc ernie > ernie-db.dump`, copia sul server, poi con Postgres avviato:
   `createrole ernie_app` (NOLOGIN) → `pg_restore -U ernie -d ernie --no-owner` → `migrate` (allinea il ruolo applicativo e la password).
5. Avvio di `api` e `worker`; sul Mac `docker compose stop api worker` (un solo worker deve eseguire promemoria e automazioni).

## Aggiornare l'app

Nell'app iOS l'indirizzo del server si inserisce al primo avvio (Impostazioni → Esci per cambiarlo). Le chiavi API degli
utenti sono le stesse (il database è stato spostato con i suoi hash).
