#!/usr/bin/env sh
# Smoke test end-to-end contro uno stack avviato (docker compose up -d --wait api).
# Uso: tests/smoke.sh [BASE_URL]   (default http://localhost:3000)
set -eu
BASE_URL="${1:-http://localhost:3000}"
ATTEMPTS="${SMOKE_ATTEMPTS:-30}"

echo "smoke: attendo ${BASE_URL}/health"
i=0
until curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge "$ATTEMPTS" ]; then
    echo "smoke: /health non raggiungibile dopo ${ATTEMPTS} tentativi" >&2
    exit 1
  fi
  sleep 2
done

HEALTH="$(curl -fsS "${BASE_URL}/health")"
echo "smoke: /health -> ${HEALTH}"
echo "${HEALTH}" | grep -q '"status":"ok"' || { echo "smoke: /health inatteso" >&2; exit 1; }

READY_CODE="$(curl -sS -o /tmp/ernie-ready.json -w '%{http_code}' "${BASE_URL}/ready")"
echo "smoke: /ready (${READY_CODE}) -> $(cat /tmp/ernie-ready.json)"
[ "${READY_CODE}" = "200" ] || { echo "smoke: /ready non è 200" >&2; exit 1; }
grep -q '"status":"ready"' /tmp/ernie-ready.json || { echo "smoke: /ready inatteso" >&2; exit 1; }

echo "smoke: OK"
