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

for VERSION in one two; do
  cat > "$WORK/src/main.rs" <<EOF
fn main() {
    assert_eq!(std::env::args().nth(1).as_deref(), Some("argument with spaces"));
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
done

cmp "$WORK/one.requirement" "$WORK/two.requirement"
cmp "$WORK/one.helper-hash" "$WORK/two.helper-hash"
grep -q 'identifier "com.bowerbird.desktop" and certificate root' "$WORK/two.requirement"
if cmp -s "$WORK/one.hash" "$WORK/two.hash"; then
  echo 'Expected different binary hashes after rebuilding' >&2
  exit 1
fi
cargo test --offline --quiet --manifest-path "$WORK/Cargo.toml"
echo 'PASS: rebuilt binaries differ but retain the same certificate requirement; arguments and tests pass.'
