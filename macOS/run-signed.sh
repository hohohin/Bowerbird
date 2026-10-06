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
fi

exec "$BINARY" "$@"
