#!/usr/bin/env bash
# Archivia la build Release per iPhone e la carica su App Store Connect (TestFlight).
# Autenticazione: chiave API di App Store Connect (consigliata, non interattiva) oppure l'account Apple in Xcode.
#   ASC_KEY_ID=APWGU2N593 ASC_ISSUER_ID=<uuid> [ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_APWGU2N593.p8] apps/ios/scripts/testflight.sh
# Prerequisiti: team impostato in project.yml (DEVELOPMENT_TEAM), scheda dell'app su App Store Connect con bundle id
# com.websdbm.ernie, chiave API con ruolo App Manager o Admin.
set -euo pipefail
cd "$(dirname "$0")/.."
# Il passo di creazione dell'IPA chiama /usr/bin/rsync (openrsync), che avvia un server «rsync» cercandolo nel PATH:
# con l'rsync di Homebrew davanti fallisce con «Copy failed». PATH di sistema per tutta l'esportazione.
# node serve dopo, per «Cosa testare»: il suo percorso si prende prima di restringere il PATH.
NODE_BIN=$(command -v node || true)
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
BUILD=${CURRENT_PROJECT_VERSION:-$(date -u +%Y%m%d%H%M)}
# Novità della versione (richiesta dell'utente, 14 ott 2026): senza la voce in Changelog.json non si carica, così la
# schermata «Novità» dell'app e «Cosa testare» di TestFlight dicono sempre cosa provare.
if ! /usr/bin/python3 -c "import json,sys; sys.exit(0 if any(e['build']==int('$BUILD') for e in json.load(open('Ernie/Resources/Changelog.json'))) else 1)" 2>/dev/null; then
  echo "manca la voce della build $BUILD in Ernie/Resources/Changelog.json: aggiungila prima di caricare" >&2
  exit 65
fi
# Archivio ed esportazione fuori dal repository, in un percorso senza spazi.
WORK=${TESTFLIGHT_WORK:-$HOME/Library/Caches/ernie-testflight}
mkdir -p "$WORK"
rm -rf "$WORK/Ernie.xcarchive" "$WORK/export"
AUTH=()
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  KEY_PATH=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}
  AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
echo "== archivio (build $BUILD)"
xcodebuild archive -project Ernie.xcodeproj -scheme Ernie -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$WORK/Ernie.xcarchive" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration ${AUTH[@]+"${AUTH[@]}"} \
  CURRENT_PROJECT_VERSION="$BUILD" | grep -E "error:|warning: .*(provision|sign)|ARCHIVE" || true
test -d "$WORK/Ernie.xcarchive"
echo "== esportazione e caricamento su App Store Connect"
xcodebuild -exportArchive -archivePath "$WORK/Ernie.xcarchive" -exportOptionsPlist ExportOptions.plist \
  -exportPath "$WORK/export" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} | grep -E "error:|Upload|EXPORT" || true
echo "== «Cosa testare» su TestFlight dalle novità della build $BUILD"
"${NODE_BIN:-node}" scripts/asc.mjs whats-new "$BUILD" --wait | grep -E "cosaTestare|Error" || echo "attenzione: «Cosa testare» non scritto (riprova: node apps/ios/scripts/asc.mjs whats-new $BUILD)"
echo "fatto: la build compare in TestFlight dopo l'elaborazione (5–15 minuti)."
