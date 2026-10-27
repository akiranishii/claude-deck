#!/bin/sh
# Regenerates PNG icons from the SVG sources (macOS: uses sips).
set -e
cd "$(dirname "$0")/.."
sips -s format png build/icon.svg --out build/icon.png >/dev/null
cp build/icon.png resources/icon.png
sips -s format png resources/tray/tray.svg --out resources/tray/trayTemplate@2x.png >/dev/null
sips -s format png resources/tray/tray.svg --out resources/tray/trayTemplate.png >/dev/null
sips -z 16 16 resources/tray/trayTemplate.png >/dev/null
echo "icons written"
# Chrome extension icons (rendered large, then downscaled)
TMP=$(mktemp -d)
sed 's#viewBox="0 0 64 64">#width="512" height="512" viewBox="0 0 64 64">#' src/renderer/src/assets/logo.svg > "$TMP/logo.svg"
sips -s format png "$TMP/logo.svg" --out "$TMP/logo.png" >/dev/null
for s in 16 48 128; do sips -z $s $s "$TMP/logo.png" --out "extension/icons/icon$s.png" >/dev/null; done
rm -rf "$TMP"
