#!/usr/bin/env bash
# Build ad hoc per iPhone registrati nel portale (es. l'iPhone di un familiare che non può usare TestFlight).
# Produce ~/Library/Caches/ernie-adhoc/export/Ernie.ipa e, se DEVICE_ID è dato, la installa con devicectl.
#   ASC_KEY_ID=APWGU2N593 ASC_ISSUER_ID=<uuid> [CURRENT_PROJECT_VERSION=25] [DEVICE_ID=<udid>] apps/ios/scripts/adhoc.sh
# Il dispositivo va prima registrato: node apps/ios/scripts/asc.mjs device "<nome>" <udid>.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
BUILD=${CURRENT_PROJECT_VERSION:-$(date -u +%Y%m%d%H%M)}
WORK=${ADHOC_WORK:-$HOME/Library/Caches/ernie-adhoc}
mkdir -p "$WORK"
rm -rf "$WORK/Ernie.xcarchive" "$WORK/export"
AUTH=()
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  KEY_PATH=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}
  AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
echo "== archivio ad hoc (build $BUILD)"
xcodebuild archive -project Ernie.xcodeproj -scheme Ernie -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$WORK/Ernie.xcarchive" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration "${AUTH[@]}" \
  CURRENT_PROJECT_VERSION="$BUILD" | grep -E "error:|warning: .*(provision|sign)|ARCHIVE" || true
test -d "$WORK/Ernie.xcarchive"
echo "== esportazione ad hoc"
xcodebuild -exportArchive -archivePath "$WORK/Ernie.xcarchive" -exportOptionsPlist ExportOptions-adhoc.plist \
  -exportPath "$WORK/export" -allowProvisioningUpdates "${AUTH[@]}" | grep -E "error:|EXPORT" || true
IPA=$(ls "$WORK"/export/*.ipa | head -1)
echo "ipa: $IPA"
if [[ -n "${DEVICE_ID:-}" ]]; then
  echo "== installazione su $DEVICE_ID"
  xcrun devicectl device install app --device "$DEVICE_ID" "$IPA"
fi
