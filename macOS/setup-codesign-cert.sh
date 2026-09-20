#!/usr/bin/env bash
# 一次性生成并导入 Bowerbird Mac 本地代码签名证书（自签名，非 Developer ID，无需 Apple 账号）。
#
# 背景：应用把登录 refresh token 存在 macOS 钥匙串（服务名 com.bowerbird.desktop）。钥匙串条目
# 的“始终允许”按**签名身份**记录信任；此前构建是 ad-hoc 签名，二进制每次发版指纹（CDHash）都变，
# 信任随即失效，用户端反复弹“想要使用钥匙串中 com.bowerbird.desktop 的机密信息”授权框。
# 用固定自签名证书签名后，身份跨版本稳定，用户点一次“始终允许”即可长期生效。
#
# 产物：证书与私钥保存在 macOS/.signing/codesign.crt、codesign.key（不入 Git，请像 updater.key
# 一样保管），并导入当前用户 login 钥匙串。注意：
# - 不走 pkcs12 —— macOS 自带 LibreSSL 生成的 p12 会被 `security import` 以 MAC 校验失败拒绝，
#   直接导入 PEM 私钥/证书最稳。
# - 自签名证书不受系统信任，`security find-identity -v` 不会列出它（正常）；codesign 照常可用，
#   本脚本结尾用试签验证。
#
# 用法：
#   bash macOS/setup-codesign-cert.sh             # 生成 + 导入 login 钥匙串（已配置则直接跳过）
#   bash macOS/setup-codesign-cert.sh --dry-run   # 只验证证书生成，不读写钥匙串（CI/沙箱自检用）
set -euo pipefail

IDENTITY="Bowerbird Local Code Signing"
SIGNING_DIR=$(cd "$(dirname "$0")/.signing" && pwd)
CRT="$SIGNING_DIR/codesign.crt"
KEY="$SIGNING_DIR/codesign.key"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# shellcheck disable=SC2312
identity_in_keychain() { security find-certificate -c "$IDENTITY" >/dev/null 2>&1; }

if [ "${1:-}" != "--dry-run" ] && [ -f "$KEY" ] && [ -f "$CRT" ] && identity_in_keychain; then
  echo "==> 已配置：${CRT} 存在且钥匙串含“${IDENTITY}”，跳过生成，仅做试签验证"
else
  # 自签名证书需带 codeSigning EKU 才能被 codesign 接受；配置文件写法兼容 LibreSSL/macOS 自带 openssl。
  cat > "$WORK/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_codesign
prompt = no
[dn]
CN = Bowerbird Local Code Signing
O = Bowerbird
[v3_codesign]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$KEY" -out "$CRT" \
    -config "$WORK/openssl.cnf"
  openssl x509 -in "$CRT" -noout -subject
  openssl x509 -in "$CRT" -noout -text | grep -A1 "Extended Key Usage"

  if [ "${1:-}" = "--dry-run" ]; then
    echo "==> dry-run：证书生成验证通过（${CRT}），未导入钥匙串"
    exit 0
  fi

  # -T 允许 codesign 免口令使用该私钥；login 钥匙串需处于解锁状态（登录会话内默认解锁）。
  KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
  security import "$KEY" -k "$KEYCHAIN" -T /usr/bin/codesign
  security import "$CRT" -k "$KEYCHAIN"
  identity_in_keychain || {
    echo "错误：导入后钥匙串仍找不到 ${IDENTITY}；请检查上方 security 输出" >&2
    exit 1
  }
fi

# 试签一个临时二进制，确认 codesign 真能用该身份（不依赖 find-identity 的可信链列表）。
# 首次签名系统可能弹“codesign 想要使用私钥”授权框：请选“始终允许”；无人值守时会一直等待。
PROBE="$WORK/probe"
cp /bin/echo "$PROBE"
codesign --force --sign "$IDENTITY" "$PROBE" >/dev/null 2>&1 || {
  echo "警告：试签失败。若是授权框被拒绝，请重跑本脚本并允许 codesign 访问私钥" >&2
  exit 1
}
codesign --verify --strict "$PROBE" && echo "==> 试签验证通过"

echo "==> 完成。release.sh 检测到该身份后会自动以它签名构建（APPLE_SIGNING_IDENTITY）。"
