#!/usr/bin/env bash
# Cargo runner: keep the desktop's Keychain identity stable across dev rebuilds.
set -euo pipefail

BINARY="${1:?Cargo must provide the executable path}"
shift

# Cargo also uses runners for tests/examples; only sign the desktop application.
if [ "$(basename "$BINARY")" = "bowerbird-desktop" ]; then
  IDENTITY="Bowerbird Local Code Signing"
  if ! /usr/bin/security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
    echo "缺少开发版稳定签名证书：${IDENTITY}。请先运行 bash macOS/setup-codesign-cert.sh。" >&2
    exit 1
  fi
  # Explicit identifier avoids the linker's build-dependent default identifier.
  # Do not fall back to ad-hoc signing: it would reintroduce Keychain prompts.
  /usr/bin/codesign --force --sign "$IDENTITY" \
    --identifier com.bowerbird.desktop --timestamp=none "$BINARY"
  /usr/bin/codesign --verify --strict "$BINARY"

  # Self-signed app rebuilds still change the Keychain partition (CDHash).
  # Keep a small authenticated bridge stable across ordinary app rebuilds.
  SOURCE="$(cd "$(dirname "$0")" && pwd)/dev-keychain.c"
  HELPER="$(dirname "$BINARY")/bowerbird-dev-keychain"
  CERT_HASH=$(/usr/bin/security find-certificate -c "$IDENTITY" -Z | awk '/SHA-1 hash:/{print $3; exit}')
  STAMP="$(/usr/bin/shasum -a 256 "$SOURCE" | awk '{print $1}'):${CERT_HASH}:$(uname -m):v1"
  REQUIREMENT="=identifier \"com.bowerbird.desktop.dev-keychain\" and certificate leaf = H\"${CERT_HASH}\""
  if [ "$(cat "$HELPER.stamp" 2>/dev/null || true)" != "$STAMP" ] || \
      ! /usr/bin/codesign --verify --strict --test-requirement "$REQUIREMENT" "$HELPER" 2>/dev/null; then
    TEMP_HELPER="$HELPER.build.$$"
    trap 'rm -f "$TEMP_HELPER"' EXIT
    /usr/bin/clang -O2 -Wno-deprecated-declarations "$SOURCE" \
      -framework Security -framework CoreFoundation -o "$TEMP_HELPER"
    /usr/bin/codesign --force --sign "$IDENTITY" --options runtime \
      --identifier com.bowerbird.desktop.dev-keychain --timestamp=none "$TEMP_HELPER"
    /usr/bin/codesign --verify --strict --test-requirement "$REQUIREMENT" "$TEMP_HELPER"
    mv -f "$TEMP_HELPER" "$HELPER"
    printf '%s' "$STAMP" > "$HELPER.stamp"
    trap - EXIT
  fi

  # A bare `target/debug/bowerbird-desktop` cannot receive browser URL opens.
  # Launch Services otherwise starts /Applications/Bowerbird.app; that process
  # exits through single-instance before macOS delivers its Opened event.
  # Keep Cargo's exec/PID/arguments, but execute a real bundle with the same ID.
  BUILD_DIR="$(cd "$(dirname "$BINARY")" && pwd)"
  MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
  BUNDLE="$BUILD_DIR/Bowerbird Dev.app"
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
  cp -p "$BINARY" "$BUNDLE/Contents/MacOS/bowerbird-desktop"
  cp -p "$HELPER" "$BUNDLE/Contents/MacOS/bowerbird-dev-keychain"
  cp "$MAC_DIR/dev-Info.plist" "$BUNDLE/Contents/Info.plist"
  VERSION=$(/usr/bin/plutil -extract version raw "$MAC_DIR/../apps/desktop/src-tauri/tauri.conf.json")
  /usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$BUNDLE/Contents/Info.plist"
  /usr/bin/plutil -replace CFBundleVersion -string "$VERSION" "$BUNDLE/Contents/Info.plist"
  # Preserve the resource_dir contract of the bare Cargo executable.
  for RESOURCE in extension samples onboarding-v0917; do
    if [ -d "$BUILD_DIR/$RESOURCE" ]; then
      cp -R "$BUILD_DIR/$RESOURCE" "$BUNDLE/Contents/Resources/$RESOURCE"
    fi
  done
  cp "$MAC_DIR/../apps/desktop/src-tauri/icons/icon.icns" "$BUNDLE/Contents/Resources/icon.icns"
  /usr/bin/codesign --force --sign "$IDENTITY" \
    --identifier com.bowerbird.desktop --timestamp=none "$BUNDLE"
  /usr/bin/codesign --verify --strict "$BUNDLE"
  # Native fixture tests disable registration so they cannot hijack real login.
  if [ "${BOWERBIRD_DEV_REGISTER_URLS:-1}" != 0 ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$BUNDLE"
  fi
  BINARY="$BUNDLE/Contents/MacOS/bowerbird-desktop"
fi

exec "$BINARY" "$@"
