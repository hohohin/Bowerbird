#!/usr/bin/env bash
# Mac 更新包一键流程：版本护栏 → 签名构建 → 产物归档/校验 → 生成 R2 直下清单 → 上传 R2 → 公网核对。
# 用法：bash macOS/release.sh [release-notes.txt]
#   R2_SKIP_BUILD=1   复用 target 里已有产物，只做归档/清单/上传
#   R2_SKIP_UPLOAD=1  不上传（也不需要 r2.env），仅本地产出
# 凭据：macOS/.signing/r2.env（模板见 macOS/r2.env.example）；签名私钥固定用 macOS/.signing/updater.key。
# 上传后清单仍需发布侧核验并原子替换 bowerbird.cn 的 downloads/updates/darwin-<arch>.json（见 dev-doc/DESKTOP-UPDATES.md）。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
NOTES=${1:-}
DIST="macOS/dist"
SIGNING="macOS/.signing"
ENV_FILE="$SIGNING/r2.env"

# R2 公开基地址（r2.dev 只读分发），缺省用仓库文档记录的现役地址；如换桶请在 r2.env 覆盖。
DEFAULT_PUBLIC_BASE="https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-$DEFAULT_PUBLIC_BASE}"

if [ "${R2_SKIP_UPLOAD:-0}" != "1" ]; then
  [ -f "$ENV_FILE" ] || { echo "缺少 $ENV_FILE（模板：macOS/r2.env.example）"; exit 1; }
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID 未配置}" "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID 未配置}" \
    "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY 未配置}" "${R2_BUCKET:?R2_BUCKET 未配置}"
fi

VERSION=$(python3 -c "import json;print(json.load(open('apps/desktop/src-tauri/tauri.conf.json'))['version'])")
ARCH=$(rustc -vV | awk '/^host/{print ($2=="x86_64-apple-darwin")?"x86_64":"aarch64"}')
TAR="Bowerbird_${VERSION}_${ARCH}.app.tar.gz"
DMG="Bowerbird_${VERSION}_${ARCH}-updater-installer.dmg"
URL="$R2_PUBLIC_BASE/mac_package/$TAR"
echo "==> 版本 $VERSION · darwin-$ARCH · 包 $TAR"

# 1) 版本必须高于该通道线上已发布版本（同日重发布用日期+序号，如 26.9.1802）。
LIVE=$(curl -fsSL --max-time 30 "https://bowerbird.cn/api/desktop-update/darwin-$ARCH" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")
if [ -n "$LIVE" ]; then
  python3 - "$LIVE" "$VERSION" <<'EOF'
import sys
key = lambda s: [int(x) for x in s.split(".")]
live, new = key(sys.argv[1]), key(sys.argv[2])
if new <= live:
    raise SystemExit(f"版本 {sys.argv[2]} 未高于线上已发布 {sys.argv[1]}，先按规范升版本")
EOF
  echo "==> 线上 ${LIVE} < 新包 ${VERSION}，护栏通过"
else
  echo "==> 线上清单不可读（未发布？），跳过版本对比"
fi

# 2) 签名构建（createUpdaterArtifacts 开启时必须提供私钥）。
if [ "${R2_SKIP_BUILD:-0}" != "1" ]; then
  echo "==> 签名构建 app,dmg"
  (cd apps/desktop && \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/$SIGNING/updater.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    pnpm tauri build --bundles app,dmg)
fi
B="apps/desktop/src-tauri/target/release/bundle"
[ -f "$B/macos/$TAR" ] || [ -f "$B/macos/Bowerbird.app.tar.gz" ] || { echo "找不到构建产物，先去掉 R2_SKIP_BUILD"; exit 1; }

# 3) 版本与架构核对后归档到 dist（旧版本原样保留）。
BUILT=$(plutil -extract CFBundleShortVersionString raw "$B/macos/Bowerbird.app/Contents/Info.plist")
[ "$BUILT" = "$VERSION" ] || { echo "构建产物版本 $BUILT ≠ 配置 $VERSION"; exit 1; }
MACHO=$( [ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x86_64" )
file "$B/macos/Bowerbird.app/Contents/MacOS/bowerbird-desktop" | grep -q "$MACHO" || { echo "构建架构不符"; exit 1; }
mkdir -p "$DIST"
cp "$B/macos/Bowerbird.app.tar.gz" "$DIST/$TAR"
cp "$B/macos/Bowerbird.app.tar.gz.sig" "$DIST/$TAR.sig"
cp "$B/dmg/Bowerbird_${VERSION}_${ARCH}.dmg" "$DIST/$DMG"
(cd "$DIST" && shasum -a 256 "$TAR" > "$TAR.sha256" && shasum -a 256 "$DMG" > "$DMG.sha256")
hdiutil verify "$DIST/$DMG" >/dev/null && echo "==> DMG 完整性通过"
SHA=$(awk '{print $1}' "$DIST/$TAR.sha256")
echo "==> $TAR SHA-256 $SHA"

# 4) 生成指向 R2 直下地址的版本清单。
NOTES_ARG=(); [ -n "$NOTES" ] && NOTES_ARG=("$NOTES")
node macOS/update-manifest.mjs "$DIST/$TAR" "$ARCH" "$URL" "$DIST/darwin-$ARCH.json" ${NOTES_ARG:+"${NOTES_ARG[@]}"}

# 5) 上传 R2（rclone 用环境变量内联配置，不留配置文件）。
if [ "${R2_SKIP_UPLOAD:-0}" != "1" ]; then
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  for f in "$TAR" "$TAR.sig" "$TAR.sha256" "$DMG" "$DMG.sha256" "darwin-$ARCH.json"; do
    rclone copyto "$DIST/$f" "r2:$R2_BUCKET/mac_package/$f" --s3-no-check-bucket
    echo "==> 已上传 mac_package/$f"
  done
  # 6) 公网核对：大小一致（rclone 上传本身带校验；完整哈希复核由发布侧执行并记录）。
  sleep 3
  REMOTE_SIZE=$(curl -sI --max-time 30 "$URL" | awk 'tolower($1)=="content-length:"{gsub("\r","");print $2}')
  LOCAL_SIZE=$(stat -f%z "$DIST/$TAR")
  [ "$REMOTE_SIZE" = "$LOCAL_SIZE" ] || { echo "公网 Content-Length $REMOTE_SIZE ≠ 本地 $LOCAL_SIZE，复核后重试"; exit 1; }
  echo "==> 公网 $URL 可访问，大小一致（$LOCAL_SIZE bytes）"
fi

echo
echo "==== 交接摘要（发布侧核验后原子替换官网清单）===="
echo "版本: $VERSION   通道: darwin-$ARCH"
echo "更新包: $URL"
echo "SHA-256: $SHA"
echo "清单: $DIST/darwin-$ARCH.json"
echo "手动安装 DMG: $DIST/$DMG"
