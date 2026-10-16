#!/bin/bash
# Installa sul Mac Studio la copia notturna di Ernie: chiavi age (se mancano), script in ~/.local/bin,
# LaunchAgent alle 04:15 e LEGGIMI.txt nella cartella dei backup. Si può rilanciare: non rigenera le chiavi.
set -euo pipefail
umask 077
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
HERE="$(cd "$(dirname "$0")" && pwd)"
KEYDIR="$HOME/Backups/Ernie-staging3"
DEST="/Volumes/SSD 2TB/Backups/Ernie-staging3"
LABEL="com.alessandro.ernie-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HOME/.local/bin/ernie-staging3-backup.sh"
LOGDIR="$HOME/Library/Logs/ernie-backup"
APP="$HOME/Applications/Ernie Backup.app"

mkdir -p "$KEYDIR" "$LOGDIR" "$HOME/.local/bin"
chmod 700 "$KEYDIR"
if [ ! -f "$KEYDIR/age-identity.txt" ]; then
  age-keygen -o "$KEYDIR/age-identity.txt" 2>/dev/null
  echo "chiave age creata in $KEYDIR/age-identity.txt"
fi
chmod 600 "$KEYDIR/age-identity.txt"
age-keygen -y "$KEYDIR/age-identity.txt" >"$KEYDIR/age-recipient.txt"
chmod 600 "$KEYDIR/age-recipient.txt"

install -m 700 "$HERE/ernie-backup.sh" "$BIN"

# macOS dà l'accesso al disco esterno programma per programma: lanciato da launchd, `age` lo chiede per sé e
# `mv`/`rm` restano senza. Una piccola app che lancia lo script prende il permesso una volta sola (la prima volta
# compare «Ernie Backup vorrebbe accedere ai file su un volume rimovibile») e lo passa a tutto ciò che avvia.
# Non si ricrea se c'è già: con una firma nuova macOS chiederebbe di nuovo il permesso.
if [ ! -d "$APP" ]; then
  mkdir -p "$(dirname "$APP")"
  osacompile -o "$APP" -e 'try' -e "do shell script \"/bin/bash '$BIN' >> '$LOGDIR/backup.log' 2>&1\"" -e 'end try'
  /usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$APP/Contents/Info.plist" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c 'Set :LSUIElement true' "$APP/Contents/Info.plist"
  codesign --force --deep -s - "$APP" 2>/dev/null
  echo "app creata: $APP"
fi

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/Contents/MacOS/applet</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOGDIR/backup.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/backup.log</string>
</dict>
</plist>
PLIST
chmod 644 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

if [ -d "/Volumes/SSD 2TB" ]; then
  mkdir -p "$DEST"
  chmod 700 "$DEST"
  install -m 644 "$HERE/LEGGIMI.txt" "$DEST/LEGGIMI.txt"
fi
echo "installato: $LABEL (ogni notte alle 04:15), log in $LOGDIR/backup.log"
echo "prova subito: launchctl kickstart gui/$(id -u)/$LABEL"
