#!/usr/bin/env bash
# Variante temporanea SENZA widget e senza App Group: finché il gruppo `group.com.websdbm.ernie` non è registrato
# a mano nel portale sviluppatori (l'API di App Store Connect non lo sa fare), il profilo di firma non lo include e
# l'archivio con il widget fallisce. Genera un project.yml ridotto, archivia e carica con testflight.sh, poi ripristina.
#   CURRENT_PROJECT_VERSION=23 ASC_KEY_ID=… ASC_ISSUER_ID=… apps/ios/scripts/testflight-nowidget.sh
set -euo pipefail
cd "$(dirname "$0")/.."
cp project.yml project.yml.full
restore() { mv -f project.yml.full project.yml; xcodegen generate >/dev/null; }
trap restore EXIT
python3 - <<'PY'
import re
s = open('project.yml').read()
# dipendenza dal widget e app group dell'app
s = s.replace("    dependencies:\n      - target: ErnieWidgets\n        embed: true\n", "")
s = re.sub(r"        # Gruppo app condiviso con il widget dei promemoria \(istantanea JSON\)\.\n        com\.apple\.security\.application-groups: \[group\.com\.websdbm\.ernie\]\n", "", s)
# target del widget
s = re.sub(r"  ErnieWidgets:\n    type: app-extension\n(?:    .*\n|\n)*?(?=  ErnieTests:)", "", s)
s = s.replace("        ErnieWidgets: all\n", "")
assert 'ErnieWidgets' not in s, 'residui del widget nello spec'
open('project.yml', 'w').write(s)
PY
xcodegen generate >/dev/null
echo "== progetto senza widget generato; archivio e caricamento"
scripts/testflight.sh
