#!/bin/bash
# Copia notturna di Ernie (staging3) sul disco «SSD 2TB» del Mac Studio (richiesta dell'utente, 16 ott 2026).
#
# Dal server prende: il database (pg_dump -Fc), il second brain (volume brain), Redis (code di BullMQ), il .env
# e il commit in produzione. Sul Mac li chiude in un unico archivio cifrato con age: la chiave pubblica sta accanto a
# quella privata in ~/Backups/Ernie-staging3, la privata non va mai sul disco esterno né sul server. Poi decifra
# l'archivio, controlla le impronte, legge il dump con pg_restore e scrive la ricevuta .verified.json; solo allora
# l'archivio prende il nome definitivo. Conserva le ultime KEEP_DAILY copie e una per settimana per KEEP_WEEKLY
# settimane. Si ferma se il disco manca o non è quello giusto, senza ripiegare sul disco interno.
#
# Installazione e ripristino: infrastructure/backup/README.md.
set -euo pipefail
umask 077
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/bin:/bin:/usr/sbin:/sbin

SERVER="${ERNIE_BACKUP_SERVER:-root@100.91.204.102}"
VOLUME="/Volumes/SSD 2TB"
VOLUME_UUID="D2A070AC-4D03-41ED-9C8E-84ABCFB875F6"
DEST="$VOLUME/Backups/Ernie-staging3"
KEYDIR="$HOME/Backups/Ernie-staging3"
IDENTITY="$KEYDIR/age-identity.txt"
RECIPIENT="$KEYDIR/age-recipient.txt"
LOCK="$KEYDIR/.backup.lock"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  log "ERRORE: $*"
  osascript -e "display notification \"$*\" with title \"Backup di Ernie non riuscito\"" >/dev/null 2>&1 || true
  exit 1
}

[ -r "$IDENTITY" ] && [ -r "$RECIPIENT" ] || fail "chiavi age assenti in $KEYDIR (lanciare install-mac.sh)"
[ -d "$VOLUME" ] || fail "il disco $VOLUME non è montato"
uuid=$(diskutil info "$VOLUME" 2>/dev/null | awk -F': *' '/Volume UUID/ {print $2}')
[ "$uuid" = "$VOLUME_UUID" ] || fail "$VOLUME non è il disco atteso (UUID $uuid)"

# Una copia alla volta; un blocco più vecchio di tre ore è di una copia interrotta.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
    rm -rf "$LOCK" && mkdir "$LOCK"
  else
    log "copia già in corso, esco"
    exit 0
  fi
fi
WORK=""
PART=""
trap 'rm -rf "$LOCK"; [ -n "$WORK" ] && rm -rf "$WORK"; [ -n "$PART" ] && rm -f "$PART"' EXIT

mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/$STAMP.tar.gz.age"
PART="$OUT.part"
log "copia $STAMP da $SERVER"

# Sul server: i pezzi in una cartella temporanea di root, poi un tar sullo standard output. Ogni «docker compose
# exec» legge da /dev/null, altrimenti si mangerebbe il resto dello script passato a bash -s.
ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 "$SERVER" 'bash -s' <<'REMOTE' | age -R "$RECIPIENT" -o "$PART" || fail "scaricamento dal server non riuscito"
set -euo pipefail
umask 077
R="sudo -u staging3 env DOCKER_HOST=unix:///run/user/1002/docker.sock XDG_RUNTIME_DIR=/run/user/1002 HOME=/srv/staging3"
cd /srv/staging3/projects/ernie
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
$R docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' </dev/null >"$W/ernie.dump"
$R docker compose exec -T api tar -C /data -czf - brain </dev/null >"$W/brain.tar.gz"
$R docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --rdb /tmp/backup.rdb >/dev/null 2>&1 && cat /tmp/backup.rdb && rm -f /tmp/backup.rdb' </dev/null >"$W/redis.rdb"
cp .env "$W/env"
git -c safe.directory=/srv/staging3/projects/ernie rev-parse HEAD >"$W/commit.txt"
printf 'server: staging3 (%s)\ncreato: %s\nprogetto: /srv/staging3/projects/ernie\n' "$(hostname)" "$(date -u +%FT%TZ)" >"$W/MANIFEST.txt"
(cd "$W" && sha256sum ernie.dump brain.tar.gz redis.rdb env commit.txt MANIFEST.txt >SHA256SUMS)
tar -C "$W" -czf - .
REMOTE

# Verifica: decifratura autenticata e lettura completa dell'archivio (il .env resta cifrato: non viene estratto),
# impronte dei file, dump leggibile da pg_restore, archivio del brain leggibile, Redis con l'intestazione RDB.
WORK=$(mktemp -d "$KEYDIR/verifica.XXXXXX")
age -d -i "$IDENTITY" "$PART" | tar -xzf - -C "$WORK" --exclude './env' || fail "l'archivio non si decifra o non si legge"
(cd "$WORK" && grep -v '  env$' SHA256SUMS | shasum -a 256 -c - >/dev/null) || fail "impronte dei file non corrispondenti"
tables=$(pg_restore --list "$WORK/ernie.dump" | grep -c ' TABLE DATA ') || fail "pg_restore non legge il dump"
[ "$tables" -gt 10 ] || fail "il dump contiene solo $tables tabelle"
brain_files=$(tar -tzf "$WORK/brain.tar.gz" | grep -c '\.md$') || brain_files=0
[ "$(head -c 5 "$WORK/redis.rdb")" = "REDIS" ] || fail "la copia di Redis non è un file RDB"
commit=$(cat "$WORK/commit.txt")
rm -rf "$WORK"
WORK=""

mv "$PART" "$OUT"
PART=""
bytes=$(stat -f %z "$OUT")
sha=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
cat >"$OUT.verified.json" <<JSON
{
  "file": "$STAMP.tar.gz.age",
  "sha256": "$sha",
  "bytes": $bytes,
  "commit": "$commit",
  "authenticated_decryption": "PASS",
  "checksums": "PASS",
  "pg_restore_list": "PASS",
  "tables_with_data": $tables,
  "brain_notes": $brain_files,
  "redis_rdb": "PASS",
  "verified_at": "$(date -u +%FT%TZ)"
}
JSON
log "fatto: $OUT ($bytes byte, $tables tabelle, $brain_files note)"

# Rotazione: le ultime KEEP_DAILY copie, poi la più recente di ogni settimana per KEEP_WEEKLY settimane.
idx=0
seen=" "
weeks=0
for f in $(cd "$DEST" && ls -1 *.tar.gz.age 2>/dev/null | sort -r); do
  idx=$((idx + 1))
  [ "$idx" -le "$KEEP_DAILY" ] && continue
  week=$(date -j -u -f '%Y%m%dT%H%M%SZ' "${f%%.tar.gz.age}" '+%G-%V' 2>/dev/null || echo "?")
  case "$seen" in
    *" $week "*) ;;
    *)
      if [ "$weeks" -lt "$KEEP_WEEKLY" ]; then
        seen="$seen$week "
        weeks=$((weeks + 1))
        continue
      fi
      ;;
  esac
  log "rotazione: tolgo $f"
  rm -f "$DEST/$f" "$DEST/$f.verified.json"
done
# Pezzi di copie interrotte più vecchi di un giorno.
find "$DEST" -maxdepth 1 -name '*.part' -mtime +1 -delete
