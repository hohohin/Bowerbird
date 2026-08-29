# Bowerbird html-renderer —— 断网、非 root、确定性 Chromium 渲染容器
# 依据 dev-doc/HTML-RENDER-PLAN.md §3.2/§3.3（H0-T1；容器实机断网/沙箱验证 = H0-T2/T5，待 VPS）
#
# 版本钉定：
#   - 基础镜像 node:24-bookworm-slim（生产构建建议改钉 digest 并同步 build-info）
#   - playwright 1.62.1（package.json 精确版本，含其对应 Chromium revision）
#   - 中文字体 fonts-noto-cjk / fonts-noto-core / fonts-dejavu-core（Debian 仓库冻结）
# 说明：构建上下文只有本目录，隔离容器内用 npm（精确钉版 + --omit=dev）；仓库 workspace
# 本身仍统一 pnpm（该「禁止 npm」约定只针对 workspace 内，见 PROJECT.md 约定 22）。
FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright \
    HOME=/tmp

WORKDIR /app

# 生产 VPS 在腾讯云；官方 Debian CDN 在该线路只有约 25 KiB/s，使用同云镜像避免
# Chromium 镜像构建长期停在 apt 索引下载。包签名校验保持不变。
RUN sed -i 's|https\?://deb.debian.org/debian-security|http://mirrors.cloud.tencent.com/debian-security|g; s|https\?://security.debian.org/debian-security|http://mirrors.cloud.tencent.com/debian-security|g; s|https\?://deb.debian.org/debian|http://mirrors.cloud.tencent.com/debian|g' /etc/apt/sources.list.d/debian.sources

RUN apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
  && apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 -o Acquire::http::Timeout=30 upgrade -y --no-install-recommends \
  && apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates \
     fonts-noto-cjk fonts-noto-core fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# 基础镜像 npm 内嵌 tar 7.5.16 有 gzip-bomb CVE（仅构建期使用、运行期断网无攻击面，
# 仍按 H5-T2 流程升级到 7.5.22 清零 HIGH/CRITICAL）。VPS 访问 npmjs 不稳定，统一 npmmirror。
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
# 不在 npm 自身工作区内执行 `npm install`：npm 12 发布后，该命令会解析 npm 的
# workspace/dev 依赖并请求并不存在于 registry 的 @npmcli/docs。这里只下载钉版 tarball，
# 原位替换 npm 的 bundled tar，再断言版本；不改变 npm 其余依赖树。
RUN mkdir -p /tmp/npm-tar-patch \
  && cd /tmp/npm-tar-patch \
  && npm pack tar@7.5.22 --ignore-scripts --no-audit --no-fund \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/tar \
  && mkdir -p /usr/local/lib/node_modules/npm/node_modules/tar \
  && tar -xzf tar-7.5.22.tgz -C /usr/local/lib/node_modules/npm/node_modules/tar --strip-components=1 \
  && node -e "if(require('/usr/local/lib/node_modules/npm/node_modules/tar/package.json').version!=='7.5.22')process.exit(1)" \
  && rm -rf /tmp/npm-tar-patch
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

# 固定 revision 的 Chromium（playwright@1.62.1）+ 运行库。该层先于业务源码，
# 后续 renderer 代码变更不会重复下载约 300 MiB 浏览器二进制。
RUN npx playwright install --with-deps chromium \
  && chmod -R a+rX /opt/browsers

COPY src ./src
COPY scripts ./scripts
RUN node scripts/build-fingerprint.mjs > build-info.json \
  && chmod 444 build-info.json

ENV RENDER_TMP_DIR=/tmp/render
# 非 root 运行；Chromium sandbox 保持开启（绝不加 --no-sandbox，见 H0-T5）
USER node
CMD ["node", "src/main.ts"]
