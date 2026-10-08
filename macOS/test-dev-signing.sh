#!/usr/bin/env bash
# Native regression: requires the existing local signing certificate.
# Uses a disposable Cargo app; never accesses Bowerbird's token or database.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
cat > "$WORK/Cargo.toml" <<'EOF'
[package]
name = "bowerbird-desktop"
version = "0.0.0"
edition = "2021"
[workspace]
EOF
export CARGO_TARGET_DIR="$WORK/target"
# Do not replace the user's real URL handler with this disposable test app.
export BOWERBIRD_DEV_REGISTER_URLS=0

for VERSION in one two; do
  for RESOURCE in extension samples onboarding-v0917; do
    mkdir -p "$WORK/target/debug/$RESOURCE"
    printf '%s' "$VERSION" > "$WORK/target/debug/$RESOURCE/fixture.txt"
  done
  cat > "$WORK/src/main.rs" <<EOF
// Tauri dev embeds a partial Info.plist. The on-disk bundle must still supply
// its identifier, otherwise macOS cannot associate this process with URL opens.
#[used]
#[link_section = "__TEXT,__info_plist"]
static INFO: [u8; 112] = *b"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleName</key><string>Bowerbird</string></dict></plist>";
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFBundleGetMainBundle() -> *const std::ffi::c_void;
    fn CFBundleGetIdentifier(bundle: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CFStringGetCString(value: *const std::ffi::c_void, buffer: *mut u8, size: isize, encoding: u32) -> bool;
}
fn main() {
    assert_eq!(std::env::args().nth(1).as_deref(), Some("argument with spaces"));
    let exe = std::env::current_exe().unwrap();
    assert!(exe.ends_with("Bowerbird Dev.app/Contents/MacOS/bowerbird-desktop"), "dev must run inside its URL-handler bundle: {exe:?}");
    assert!(exe.with_file_name("bowerbird-dev-keychain").is_file());
    unsafe {
        let id = CFBundleGetIdentifier(CFBundleGetMainBundle());
        assert!(!id.is_null(), "running app needs a bundle identifier");
        let mut bytes = [0u8; 128];
        assert!(CFStringGetCString(id, bytes.as_mut_ptr(), 128, 0x08000100));
        assert_eq!(std::ffi::CStr::from_ptr(bytes.as_ptr().cast()).to_str().unwrap(), "com.bowerbird.desktop");
    }
    for resource in ["extension", "samples", "onboarding-v0917"] {
        let path = exe.parent().unwrap().join("../Resources").join(resource).join("fixture.txt");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "$VERSION");
    }
    println!("$VERSION");
}
#[test]
fn ordinary_test_still_runs() { assert_eq!(2 + 2, 4); }
EOF
  # Exercise both documented invocation locations and automatic config lookup.
  if [ "$VERSION" = one ]; then cd "$ROOT"; else cd "$ROOT/apps/desktop/src-tauri"; fi
  RESULT=$(cargo run --offline --quiet --manifest-path "$WORK/Cargo.toml" -- 'argument with spaces')
  [ "$RESULT" = "$VERSION" ]
  BINARY="$WORK/target/debug/bowerbird-desktop"
  /usr/bin/codesign --verify --strict "$BINARY"
  /usr/bin/codesign -d -r- "$BINARY" > "$WORK/$VERSION.requirement" 2>/dev/null
  /usr/bin/codesign -dvvv "$BINARY" 2> "$WORK/$VERSION.signature"
  grep '^CDHash=' "$WORK/$VERSION.signature" > "$WORK/$VERSION.hash"
  /usr/bin/shasum -a 256 "$WORK/target/debug/bowerbird-dev-keychain" > "$WORK/$VERSION.helper-hash"
  BUNDLE="$WORK/target/debug/Bowerbird Dev.app"
  /usr/bin/codesign --verify --strict "$BUNDLE"
  cmp "$WORK/target/debug/bowerbird-dev-keychain" "$BUNDLE/Contents/MacOS/bowerbird-dev-keychain"
  [ "$(/usr/bin/plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes.0 raw "$BUNDLE/Contents/Info.plist")" = bowerbird ]
done

cmp "$WORK/one.requirement" "$WORK/two.requirement"
cmp "$WORK/one.helper-hash" "$WORK/two.helper-hash"
grep -q 'identifier "com.bowerbird.desktop" and certificate root' "$WORK/two.requirement"
if cmp -s "$WORK/one.hash" "$WORK/two.hash"; then
  echo 'Expected different binary hashes after rebuilding' >&2
  exit 1
fi
cargo test --offline --quiet --manifest-path "$WORK/Cargo.toml"
echo 'PASS: dev bundle identity, URL scheme, resources, signatures, stable helper, arguments and Cargo tests.'
