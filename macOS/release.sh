#!/usr/bin/env bash
# Mac 更新包一键流程：版本护栏 → 签名构建 → 产物归档/校验 → 生成 COS 直下清单 → 上传 COS → 公网核对。
# 用法：bash macOS/release.sh [release-notes.txt]
#   COS_SKIP_BUILD=1   复用 target 里已有产物，只做归档/清单/上传
#   COS_SKIP_UPLOAD=1  不上传（也不需要 cos.env），仅本地产出
# 凭据：macOS/.signing/cos.env（模板见 macOS/cos.env.example）；签名私钥固定用 macOS/.signing/updater.key。
# 分发走腾讯 COS + CDN（cdn.bowerbird.cn）；2026-09-20 起取代 R2 r2.dev（Cloudflare 明确其仅供开发且有速率限制）。
# 上传后清单仍需发布侧核验并原子替换 bowerbird.cn 的 downloads/updates/darwin-<arch>.json（见 dev-doc/DESKTOP-UPDATES.md）。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
NOTES=${1:-}
DIST="macOS/dist"
SIGNING="macOS/.signing"
ENV_FILE="$SIGNING/cos.env"

# COS 公开基地址（CDN 加速域名），缺省用仓库文档记录的现役地址；如换域名/桶请在 cos.env 覆盖。
DEFAULT_PUBLIC_BASE="https://cdn.bowerbird.cn"
COS_PUBLIC_BASE="${COS_PUBLIC_BASE:-$DEFAULT_PUBLIC_BASE}"

if [ "${COS_SKIP_UPLOAD:-0}" != "1" ]; then
  [ -f "$ENV_FILE" ] || { echo "缺少 $ENV_FILE（模板：macOS/cos.env.example）"; exit 1; }
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  : "${TENCENT_SECRET_ID:?TENCENT_SECRET_ID 未配置}" "${TENCENT_SECRET_KEY:?TENCENT_SECRET_KEY 未配置}" \
    "${COS_BUCKET:?COS_BUCKET 未配置}" "${COS_REGION:?COS_REGION 未配置}"
fi

VERSION=$(python3 -c "import json;print(json.load(open('apps/desktop/src-tauri/tauri.conf.json'))['version'])")
ARCH=$(rustc -vV | awk '/^host/{print ($2=="x86_64-apple-darwin")?"x86_64":"aarch64"}')
TAR="Bowerbird_${VERSION}_${ARCH}.app.tar.gz"
DMG="Bowerbird_${VERSION}_${ARCH}-updater-installer.dmg"
URL="$COS_PUBLIC_BASE/mac_package/$TAR"
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
#    稳定本地签名身份：钥匙串“始终允许”按签名身份生效，ad-hoc 签名每次构建指纹都变会导致
#    用户端反复弹钥匙串授权框；身份缺失时回退 ad-hoc 并提示（一次性生成：setup-codesign-cert.sh）。
IDENTITY="Bowerbird Local Code Signing"
if [ "${COS_SKIP_BUILD:-0}" != "1" ]; then
  if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
    echo "==> 使用稳定签名身份：$IDENTITY"
  else
    echo "==> 提示：钥匙串无 $IDENTITY，本次为 ad-hoc 签名，用户端钥匙串授权弹窗会复现"
    echo "    （一次性修复：bash macOS/setup-codesign-cert.sh）"
  fi
  echo "==> 签名构建 app,dmg"
  (cd apps/desktop && \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/$SIGNING/updater.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    pnpm tauri build --bundles app,dmg)
fi
B="apps/desktop/src-tauri/target/release/bundle"
[ -f "$B/macos/$TAR" ] || [ -f "$B/macos/Bowerbird.app.tar.gz" ] || { echo "找不到构建产物，先去掉 COS_SKIP_BUILD"; exit 1; }

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

# 4) 生成指向 COS 直下地址的版本清单。
NOTES_ARG=(); [ -n "$NOTES" ] && NOTES_ARG=("$NOTES")
node macOS/update-manifest.mjs "$DIST/$TAR" "$ARCH" "$URL" "$DIST/darwin-$ARCH.json" ${NOTES_ARG:+"${NOTES_ARG[@]}"}

# 5) 上传 COS（rclone 用环境变量内联配置，不留配置文件）。
if [ "${COS_SKIP_UPLOAD:-0}" != "1" ]; then
  export RCLONE_CONFIG_COS_TYPE=s3 RCLONE_CONFIG_COS_PROVIDER=TencentCOS
  export RCLONE_CONFIG_COS_ENDPOINT="https://cos.$COS_REGION.myqcloud.com"
  export RCLONE_CONFIG_COS_ACCESS_KEY_ID="$TENCENT_SECRET_ID"
  export RCLONE_CONFIG_COS_SECRET_ACCESS_KEY="$TENCENT_SECRET_KEY"
  for f in "$TAR" "$TAR.sig" "$TAR.sha256" "$DMG" "$DMG.sha256" "darwin-$ARCH.json"; do
    rclone copyto "$DIST/$f" "cos:$COS_BUCKET/mac_package/$f" --s3-no-check-bucket
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
