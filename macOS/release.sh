#!/usr/bin/env bash
# Mac 更新包一键流程：版本护栏 → 签名构建 → 产物归档/校验 → 生成 CDN 清单 → 上传 TOS → 公网核对。
# 用法：bash macOS/release.sh [release-notes.txt]
#   COS_SKIP_BUILD=1   复用 target 里已有产物，只做归档/清单/上传
#   COS_SKIP_UPLOAD=1  沿用已有开关，仅本地产出
# 凭据：项目根 .env.tos 或签名机的 TOS_* 环境变量；签名私钥固定用 macOS/.signing/updater.key。
# 2026-10-23 起正式分发走火山 TOS + CDN（cdn.bowerbird.cn）。
# 上传后清单仍需发布侧核验并原子替换 bowerbird.cn 的 downloads/updates/darwin-<arch>.json（见 dev-doc/DESKTOP-UPDATES.md）。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
NOTES=${1:-}
DIST="macOS/dist"
SIGNING="macOS/.signing"
CHANNEL=${BOWERBIRD_MAC_CHANNEL:-release}
case "$CHANNEL" in
  release) ;;
  local)
    [ "${COS_SKIP_UPLOAD:-0}" = "1" ] || { echo "本地测试包不能上传"; exit 1; }
    DIST="$DIST/local"
    ;;
  *) echo "未知 Mac 渠道"; exit 1 ;;
esac

PUBLIC_BASE="${TOS_CDN_BASE:-https://cdn.bowerbird.cn}"

if [ "$CHANNEL" = release ]; then
  case "${APPLE_SIGNING_IDENTITY:-}" in
    "Developer ID Application: "*) ;;
    *) echo "正式发布需要 APPLE_SIGNING_IDENTITY 指定 Developer ID Application"; exit 1 ;;
  esac
  : "${BOWERBIRD_NOTARY_PROFILE:?需要 DMG 公证的 notarytool 钥匙串配置名}"
fi

VERSION=$(python3 -c "import json;print(json.load(open('apps/desktop/src-tauri/tauri.conf.json'))['version'])")
HOST=$(rustc -vV | awk '/^host/{print $2}')
case "$HOST" in
  x86_64-apple-darwin) ARCH=x86_64; DMG_ARCH=x64; MACHO=x86_64 ;;
  aarch64-apple-darwin) ARCH=aarch64; DMG_ARCH=aarch64; MACHO=arm64 ;;
  *) echo "不支持的 Mac 构建 host: $HOST"; exit 1 ;;
esac
TAR="Bowerbird_${VERSION}_${ARCH}.app.tar.gz"
DMG="Bowerbird_${VERSION}_${ARCH}-updater-installer.dmg"
URL="$PUBLIC_BASE/mac_package/$TAR"
echo "==> 版本 $VERSION · darwin-$ARCH · 包 $TAR"

# 1) 版本必须高于该通道线上已发布版本（同日重发布用日期+序号，如 26.9.1802）。
if [ "$CHANNEL" = release ]; then
  python3 macOS/upload_immutable.py check-live "$ARCH" "$VERSION"
fi

mkdir -p "$DIST"
# Both local and release builds share Tauri's target/release/bundle directory.
BUILD_LOCK="$ROOT/macOS/dist/.release-build.lock"
mkdir "$BUILD_LOCK" || { echo "另一个发布构建仍占用 $BUILD_LOCK"; exit 1; }
trap 'rmdir "$BUILD_LOCK"' EXIT
if [ "$CHANNEL" = release ]; then
  DIST=$(mktemp -d "$DIST/release-$VERSION-$ARCH.XXXXXX")
  echo "==> 候选归档 $DIST"
fi

# 2) 签名构建（createUpdaterArtifacts 开启时必须提供私钥）。
if [ "${COS_SKIP_BUILD:-0}" != "1" ]; then
  if [ "$CHANNEL" = local ] && security find-certificate -c "Bowerbird Local Code Signing" >/dev/null 2>&1; then
    export APPLE_SIGNING_IDENTITY="Bowerbird Local Code Signing"
  fi
  [ -s "$SIGNING/updater.key" ] || { echo "缺少原 Mac updater 私钥；请在原签名机完成签名，不要生成替代密钥。"; exit 1; }
  echo "==> 签名构建 app,dmg"
  (cd apps/desktop && \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/$SIGNING/updater.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    pnpm tauri build --bundles app,dmg)
fi
B="apps/desktop/src-tauri/target/release/bundle"
[ -s "$B/macos/Bowerbird.app.tar.gz" ] && [ -s "$B/macos/Bowerbird.app.tar.gz.sig" ] || { echo "找不到签名构建产物，先去掉 COS_SKIP_BUILD"; exit 1; }

# 3) 版本与架构核对后归档到 dist（旧版本原样保留）。
BUILT=$(plutil -extract CFBundleShortVersionString raw "$B/macos/Bowerbird.app/Contents/Info.plist")
[ "$BUILT" = "$VERSION" ] || { echo "构建产物版本 $BUILT ≠ 配置 $VERSION"; exit 1; }
file "$B/macos/Bowerbird.app/Contents/MacOS/bowerbird-desktop" | grep -q "$MACHO" || { echo "构建架构不符"; exit 1; }
mkdir -p "$DIST"
cp "$B/macos/Bowerbird.app.tar.gz" "$DIST/$TAR"
cp "$B/macos/Bowerbird.app.tar.gz.sig" "$DIST/$TAR.sig"
cp "$B/dmg/Bowerbird_${VERSION}_${DMG_ARCH}.dmg" "$DIST/$DMG"
if [ "$CHANNEL" = release ]; then
  # Inspect the actual archived and mounted applications, including reused builds.
  VERIFY_DIR=$(mktemp -d)
  MOUNT="$VERIFY_DIR/dmg"
  mounted=0
  cleanup_verify() {
    if [ "$mounted" = 1 ]; then hdiutil detach "$MOUNT" || return 1; fi
    rm -rf -- "$VERIFY_DIR"
  }
  trap 'cleanup_verify; rmdir "$BUILD_LOCK"' EXIT
  mkdir "$MOUNT"
  node --input-type=module - "$DIST/$TAR" <<'JS'
import { readFileSync } from "node:fs";
import { verifyUpdate } from "./macOS/verify-update.mjs";
const tar = process.argv[2];
const config = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.macos.conf.json"));
verifyUpdate(readFileSync(tar), readFileSync(tar + ".sig", "utf8"), config.plugins.updater.pubkey);
JS
  tar -xzf "$DIST/$TAR" -C "$VERIFY_DIR"
  hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DIST/$DMG"
  mounted=1
  archived_hash=""
  for app in "$VERIFY_DIR/Bowerbird.app" "$MOUNT/Bowerbird.app"; do
    codesign --verify --deep --strict "$app"
    details=$(codesign -dv --verbose=4 "$app" 2>&1)
    grep -Fx "Authority=$APPLE_SIGNING_IDENTITY" <<<"$details" >/dev/null
    grep -E 'flags=.*[(,]runtime[,)]' <<<"$details" >/dev/null
    app_hash=$(sed -n 's/^CDHash=//p' <<<"$details")
    [ -n "$app_hash" ] && { [ -z "$archived_hash" ] || [ "$app_hash" = "$archived_hash" ]; } || exit 1
    archived_hash="$app_hash"
    [ "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$VERSION" ]
    [ "$(plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist")" = "$(plutil -extract identifier raw apps/desktop/src-tauri/tauri.conf.json)" ]
    lipo "$app/Contents/MacOS/bowerbird-desktop" -verify_arch "$MACHO"
    codesign -d --entitlements :- "$app" > "$VERIFY_DIR/entitlements.plist"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.automation.apple-events' "$VERIFY_DIR/entitlements.plist")" = true ]
    plutil -extract NSAppleEventsUsageDescription raw "$app/Contents/Info.plist" >/dev/null
    xcrun stapler validate "$app"
    spctl --assess --type execute "$app"
  done
  hdiutil detach "$MOUNT"
  mounted=0
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DIST/$DMG"
  xcrun notarytool submit "$DIST/$DMG" --keychain-profile "$BOWERBIRD_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DIST/$DMG"
  xcrun stapler validate "$DIST/$DMG"
  spctl --assess --type open --context context:primary-signature "$DIST/$DMG"
fi
(cd "$DIST" && shasum -a 256 "$TAR" > "$TAR.sha256" && shasum -a 256 "$DMG" > "$DMG.sha256")
hdiutil verify "$DIST/$DMG" >/dev/null
echo "==> DMG 完整性通过"
SHA=$(awk '{print $1}' "$DIST/$TAR.sha256")
echo "==> $TAR SHA-256 $SHA"

# 4) 生成指向 CDN 下载地址的版本清单。
NOTES_ARG=(); [ -n "$NOTES" ] && NOTES_ARG=("$NOTES")
node macOS/update-manifest.mjs "$DIST/$TAR" "$ARCH" "$URL" "$DIST/darwin-$ARCH.json" ${NOTES_ARG:+"${NOTES_ARG[@]}"}

# Freeze the actual notarized bytes, including the manifest timestamp, for a retriable upload.
if [ "$CHANNEL" = release ]; then
  (cd "$DIST" && shasum -a 256 "$TAR" "$TAR.sig" "$TAR.sha256" "$DMG" "$DMG.sha256" "darwin-$ARCH.json" > SHA256SUMS)
fi
if [ "${COS_SKIP_UPLOAD:-0}" != "1" ]; then
  python3 macOS/upload_immutable.py upload "$ARCH" "$VERSION" "$DIST"
fi

echo
echo "==== 交接摘要（发布侧核验后原子替换官网清单）===="
echo "版本: $VERSION   通道: darwin-$ARCH"
echo "更新包: $URL"
echo "SHA-256: $SHA"
echo "清单: $DIST/darwin-$ARCH.json"
echo "手动安装 DMG: $DIST/$DMG"
