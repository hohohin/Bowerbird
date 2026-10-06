#!/usr/bin/env bash
# Uses the actual Rust backend and native helper with a unique dummy item.
# UI is disabled; any authorization prompt that would appear fails this test.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
IDENTITY='Bowerbird Local Code Signing'
SERVICE="com.bowerbird.keychain-regression.$(/usr/bin/uuidgen)"
mkdir -p "$WORK/src"
cat > "$WORK/Cargo.toml" <<'EOF'
[package]
name = "bowerbird-keychain-probe"
version = "0.0.0"
edition = "2021"
[dependencies]
keyring = "=3.6.3"
[workspace]
EOF
cat > "$WORK/src/main.rs" <<EOF
#[path = "$ROOT/apps/desktop/src-tauri/src/cloud/dev_keychain.rs"]
mod dev_keychain;
use keyring::credential::CredentialApi;
fn main() {
    let entry = dev_keychain::DevKeychain;
    let operation = std::env::args().nth(1).unwrap();
    match operation.as_str() {
        "set-one" => entry.set_password("dummy-one").unwrap(),
        "set-two" => entry.set_password("dummy-two").unwrap(),
        "get-one" => assert_eq!(entry.get_password().unwrap(), "dummy-one"),
        "get-two" => assert_eq!(entry.get_password().unwrap(), "dummy-two"),
        "delete" => entry.delete_credential().unwrap(),
        "missing" => {
            let result = entry.get_password();
            if !matches!(result, Err(keyring::Error::NoEntry)) {
                let diagnostic = std::process::Command::new(std::env::current_exe().unwrap().with_file_name("bowerbird-dev-keychain"))
                    .args(["get", "--no-ui"]).output().unwrap();
                eprintln!("native status={} stderr={}", diagnostic.status, String::from_utf8_lossy(&diagnostic.stderr));
                panic!("expected NoEntry, got {result:?}");
            }
        },
        "reject" => assert!(matches!(entry.get_password(), Err(keyring::Error::PlatformFailure(_)))),
        _ => panic!("unknown operation"),
    }
    println!("PASS {} build={}", operation, env!("PROBE_VERSION"));
}
EOF
export CARGO_TARGET_DIR="$WORK/target"
APP="$WORK/target/debug/bowerbird-keychain-probe"
HELPER="$WORK/target/debug/bowerbird-dev-keychain"
CREATED=0
cleanup() {
  if [ -f "$WORK/helper.backup" ]; then cp "$WORK/helper.backup" "$HELPER"; fi
  if [ "$CREATED" = 1 ]; then "$APP" delete; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
cd "$ROOT"
PROBE_VERSION=one cargo build --offline --quiet --manifest-path "$WORK/Cargo.toml"
/usr/bin/codesign --force --sign "$IDENTITY" --identifier com.bowerbird.desktop --timestamp=none "$APP"
/usr/bin/clang -O2 -Wno-deprecated-declarations -DKEYCHAIN_TEST_NO_UI \
  "-DKEYCHAIN_SERVICE=\"$SERVICE\"" "$ROOT/macOS/dev-keychain.c" \
  -framework Security -framework CoreFoundation -o "$HELPER"
/usr/bin/codesign --force --sign "$IDENTITY" --options runtime \
  --identifier com.bowerbird.desktop.dev-keychain --timestamp=none "$HELPER"
/usr/bin/shasum -a 256 "$HELPER" > "$WORK/helper.hash"
/usr/bin/codesign -dvvv "$APP" 2> "$WORK/one.signature"
"$APP" missing
"$APP" set-one
CREATED=1
"$APP" get-one
PROBE_VERSION=two cargo build --offline --quiet --manifest-path "$WORK/Cargo.toml"
/usr/bin/codesign --force --sign "$IDENTITY" --identifier com.bowerbird.desktop --timestamp=none "$APP"
/usr/bin/codesign -dvvv "$APP" 2> "$WORK/two.signature"
if [ "$(grep '^CDHash=' "$WORK/one.signature")" = "$(grep '^CDHash=' "$WORK/two.signature")" ]; then
  echo 'Expected a different application CDHash' >&2; exit 1
fi
/usr/bin/shasum -a 256 -c "$WORK/helper.hash"
"$APP" get-one
"$APP" set-two
"$APP" get-two
# An ordinary shell cannot read the item through the helper.
REJECT_STATUS=0
"$HELPER" get --no-ui > "$WORK/rejected.stdout" 2>/dev/null || REJECT_STATUS=$?
[ "$REJECT_STATUS" = 4 ]
[ ! -s "$WORK/rejected.stdout" ]
# The Rust backend must reject a substituted helper, before requesting secrets.
cp "$HELPER" "$WORK/helper.backup"
/usr/bin/codesign --force --sign - "$HELPER"
"$APP" reject
cp "$WORK/helper.backup" "$HELPER"
"$APP" delete
CREATED=0
"$APP" missing
echo 'PASS: real Keychain read/rotation/delete across app rebuilds, with UI disabled; unauthorized callers/helpers rejected.'
