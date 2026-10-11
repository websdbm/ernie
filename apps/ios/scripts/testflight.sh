#!/usr/bin/env bash
# Archivia la build Release per iPhone e la carica su App Store Connect (TestFlight).
# Autenticazione: chiave API di App Store Connect (consigliata, non interattiva) oppure l'account Apple in Xcode.
#   ASC_KEY_ID=APWGU2N593 ASC_ISSUER_ID=<uuid> [ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_APWGU2N593.p8] apps/ios/scripts/testflight.sh
# Prerequisiti: team impostato in project.yml (DEVELOPMENT_TEAM), scheda dell'app creata su App Store Connect
# con bundle id com.websdbm.ernie, chiave API con ruolo App Manager (o Admin).
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=${CURRENT_PROJECT_VERSION:-$(date -u +%Y%m%d%H%M)}
AUTH=()
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  KEY_PATH=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}
  AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
echo "== archivio (build $BUILD)"
xcodebuild archive -project Ernie.xcodeproj -scheme Ernie -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Ernie.xcarchive \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration "${AUTH[@]}" \
  CURRENT_PROJECT_VERSION="$BUILD" | grep -E "error:|warning: .*(provision|sign)|ARCHIVE" || true
test -d build/Ernie.xcarchive
echo "== esportazione e caricamento su App Store Connect"
xcodebuild -exportArchive -archivePath build/Ernie.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates "${AUTH[@]}" | grep -E "error:|Upload|EXPORT" || true
echo "fatto: la build compare in TestFlight dopo l'elaborazione (5–15 minuti)."
