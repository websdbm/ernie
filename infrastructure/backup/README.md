# Backup di Ernie

Copia notturna del server staging3 sul disco «SSD 2TB» del Mac Studio. È la soluzione provvisoria: in seguito un servizio online.

- `ernie-backup.sh`: la copia. Scarica database, second brain, Redis, `.env` e commit; cifra con age; verifica; ruota (14 giornaliere più 8 settimanali).
- `install-mac.sh`: crea le chiavi age se mancano, installa lo script in `~/.local/bin` e il LaunchAgent `com.alessandro.ernie-backup` (ogni notte alle 04:15).
- `LEGGIMI.txt`: copiato nella cartella dei backup.

Chiavi in `~/Backups/Ernie-staging3/` (fuori dal disco esterno): `age-identity.txt` è la privata, `age-recipient.txt` la pubblica. Della privata serve una seconda copia in un posto sicuro, per esempio il gestore di password.

## Prove

```bash
launchctl kickstart gui/$(id -u)/com.alessandro.ernie-backup
tail -f ~/Library/Logs/ernie-backup/backup.log
```

## Ripristino

Si apre l'archivio in una cartella privata:

```bash
mkdir -m 700 ~/ripristino && cd ~/ripristino
age -d -i ~/Backups/Ernie-staging3/age-identity.txt "/Volumes/SSD 2TB/Backups/Ernie-staging3/<data>.tar.gz.age" | tar -xzf -
shasum -a 256 -c SHA256SUMS
```

Sul server (o su un server nuovo con il repository al commit di `commit.txt`):

1. Il `.env`: `env` diventa `/srv/staging3/projects/ernie/.env` (permessi 600, proprietario staging3).
2. I servizi senza l'app: `docker compose up -d postgres redis`.
3. Il database. Il dump non contiene i ruoli, ma i permessi e le policy RLS nominano `ernie_app`: prima le migrazioni, che creano il ruolo e gli danno la password `APP_DB_PASSWORD`, poi il dump sopra.
   ```bash
   docker compose run --rm migrate
   docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < ernie.dump
   ```
4. Il second brain nel volume: `docker compose run --rm -T api sh -c 'rm -rf /data/brain/* && tar -C /data -xzf -' < brain.tar.gz`
5. Redis, facoltativo: le automazioni e i promemoria stanno nel database e il worker riprogramma i lavori all'avvio. Per riportare anche le code: fermare redis, copiare `redis.rdb` come `dump.rdb` nel volume `redisdata` e togliere `appendonly.aof*`, poi riavviare.
6. Tutto su: `docker compose up -d`, poi `curl -fsS http://127.0.0.1:3000/health`.

Una prova di lettura senza toccare il server: `pg_restore --list ernie.dump | head`.
