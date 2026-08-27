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
    HOME=/tmp

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
     fonts-noto-cjk fonts-noto-core fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

# 固定 revision 的 Chromium（playwright@1.62.1）+ 运行库；随后烙印 build fingerprint
RUN npx playwright install --with-deps chromium \
  && chmod -R a+rX /opt/browsers \
  && node scripts/build-fingerprint.mjs > build-info.json \
  && chmod 444 build-info.json

ENV RENDER_TMP_DIR=/tmp/render
# 非 root 运行；Chromium sandbox 保持开启（绝不加 --no-sandbox，见 H0-T5）
USER node
CMD ["node", "src/main.ts"]
