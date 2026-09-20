#!/bin/bash
# Package an already-built app without rebuilding or modifying it.
set -euo pipefail
app=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
output=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
assets=$(cd "$(dirname "$0")" && pwd)
test -d "$app/Contents"
test ! -e "$output"
work=$(mktemp -d /private/tmp/bowerbird-dmg.XXXXXX)
mountpoint="/Volumes/Bowerbird 安装"
test ! -e "$mountpoint"
mounted=0
cleanup() {
  if [ "$mounted" = 1 ]; then hdiutil detach "$mountpoint" >/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/source/.background"
ditto "$app" "$work/source/Bowerbird.app"
ln -s /Applications "$work/source/Applications"
cp "$assets/background.png" "$work/source/.background/background.png"
hdiutil create -fs HFS+ -volname 'Bowerbird 安装' -srcfolder "$work/source" -format UDRW "$work/layout.dmg"
hdiutil attach -readwrite -nobrowse -mountpoint "$mountpoint" "$work/layout.dmg"
mounted=1
osascript - "$mountpoint" <<'APPLESCRIPT'
on run argv
  set targetFolder to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    open targetFolder
    delay 1
    set targetWindow to front Finder window
    set targetDisk to target of targetWindow
    if (targetDisk as alias) is not targetFolder then error "Unexpected Finder target"
    tell targetWindow
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set bounds to {150, 150, 810, 550}
      set opts to icon view options of targetWindow
      set arrangement of opts to not arranged
      set icon size of opts to 96
      set text size of opts to 14
      set background picture of opts to file ".background:background.png" of targetDisk
    end tell
    set position of item "Bowerbird.app" of targetDisk to {180, 190}
    set position of item "Applications" of targetDisk to {480, 190}
    update targetDisk without registering applications
    delay 2
    close targetWindow
    delay 3
  end tell
end run
APPLESCRIPT
test -s "$mountpoint/.DS_Store"
diff -qr "$app" "$mountpoint/Bowerbird.app"
test "$(readlink "$mountpoint/Applications")" = /Applications
sync
hdiutil detach "$mountpoint"
mounted=0
hdiutil convert "$work/layout.dmg" -format UDZO -o "$output"
hdiutil verify "$output"
shasum -a 256 "$output" > "$output.sha256"
