# @bowerbird/html-renderer — Bowerbird 受限 HTML 离线 Renderer

> 依据 [dev-doc/HTML-RENDER-PLAN.md](../../dev-doc/HTML-RENDER-PLAN.md)（H0-T1 镜像契约 + H1 独立 renderer）。
> 状态：**H1 代码与本地测试完成；容器实机断网/沙箱/容量验证（H0-T2~T5）待 VPS 执行。**

一个**封闭、确定性的渲染工具**，不是浏览器 Agent：

- 只接受 Agent Worker 经 Docker 内部网络发来的**有界内部请求**（HTML 文本 + 显式资源字节表 + 截图参数）；
- HTML 中一切资源引用只能是 `asset:<key>` 占位，且 key 必须在本次请求的资源表内（闭集）；
- Chromium 只作为 HTML/CSS 排版引擎：禁 JavaScript、封闭 CSP、全请求拦截（除两个虚拟 origin 外全部 abort）、无 URL/导航/点击/Cookie/下载语义；
- 输出：视口 PNG / 整页 PNG / 基于同一整页像素结果裁出的纵向切片 PNG + render manifest 字段；
- 截图完成后不做任何 Vision 检查、评分或自动修订；
- 无业务 secret：不持 Supabase/方舟/Worker Token/用户凭据；仅有容器间共享的 `RENDER_INTERNAL_TOKEN`。

## 安全边界（三层）

1. **容器层**：无公网出口、无宿主端口映射、read-only rootfs、cap_drop ALL、非 root、无 secret（见 `compose.renderer.yml`）。
2. **浏览器层**：`classifyRouteRequest`（`src/route-policy.ts`）只放行文档与资源虚拟 origin；`javaScriptEnabled: false` + 封闭 CSP。
3. **输入层**：`src/sanitizer.ts` 严格白名单（标签/属性/scheme/at-rule/资源闭集/数量与深度上限）——这是质量与减面措施，不是最终边界。

## 开发

```bash
# 依赖（workspace 内）
pnpm install --filter @bowerbird/html-renderer

# 本地实跑 e2e 需要先下载钉版 Chromium（约 150MB）
npx playwright install chromium

# 全部测试（未装 Chromium 时 e2e 自动 skip）
pnpm --dir apps/html-renderer test

# 类型检查
pnpm --dir apps/html-renderer typecheck
```

运行时仅依赖 Node v24 内置能力 + `playwright@1.62.1`（精确钉版；PNG 编解码为自研纯 stdlib 实现，见 `src/png.ts`）。

## 服务运行（容器内）

```bash
RENDER_INTERNAL_TOKEN=<≥32 字符随机值> RENDER_PORT=3917 node src/main.ts
```

- `POST /render`（Bearer token）：内部请求/响应契约见 `src/contracts.ts`；错误只回稳定错误码（计划 §11）。
- `GET /healthz`：fingerprint、Chromium/Playwright 版本、队列状态；不含任何用户内容。
- 并发 1 + 等待队列 1；超出立即 `render_capacity_busy`。
- 日志为 JSON lines，只含 requestId/时长/字节/稳定错误码，**不含 HTML/CSS 正文与图片内容**。

## 部署（VPS，待 H0 验证）

```bash
cd apps/html-renderer
cp .env.renderer.example .env.renderer   # 填 RENDER_INTERNAL_TOKEN
docker compose -f compose.renderer.yml up -d --build
```

- 容器只挂在 `bowerbird-internal`（internal: true）网络上；Agent Worker 侧（H2）加入同一网络后经 `http://html-renderer:3917` 调用。
- 镜像内烙印 `build-info.json`（基础镜像 tag、字体包版本、playwright 版本）；`rendererFingerprint = bwr1-<hash>` 绑定代码版本/Chromium/Playwright/字体/默认样式/PNG 编码参数（`src/fingerprint.ts`）。
- Chromium sandbox 保持开启，绝不默认 `--no-sandbox`（计划 H0-T5：如只能靠关 sandbox 运行则停止并重新评估）。

## H0 剩余（本机无 Docker，待 VPS）

- H0-T2/T5：非 root、只读 rootfs、cap_drop ALL、无公网出口下实跑 100 次合成渲染 + sandbox 验证；
- H0-T3/T4：20 fixture 容量测量与上限冻结复核（当前 `src/limits.ts` 为计划初始值）。

## 文件结构

```
src/
  contracts.ts       内部请求/响应 v1 契约 + 闭集校验
  limits.ts          v1 冻结限额（单一来源）
  errors.ts          稳定错误码（§11）
  sanitizer.ts       HTML/CSS 严格白名单校验（字符级 tokenizer）
  route-policy.ts    浏览器请求拦截分类（纯函数）
  renderer.ts        Playwright 渲染会话（禁 JS/拦截/CSP/稳定等待/唯一 rasterization）
  png.ts             自研 PNG 解码/裁切/编码（切片与像素复原的地基）
  slice.ts           确定性纵向切片计划（整数规则、最后一片规则、上限）
  render-service.ts  一次请求的编排（资源复核/临时目录/超时/输出复核）
  server.ts          内部 HTTP（鉴权/并发1/健康检查/无内容日志）
  main.ts            入口（orphan cleanup/优雅退出）
  *.test.ts          单测；renderer.e2e.test.ts 需本机 Chromium，未装自动 skip
scripts/
  build-fingerprint.mjs  构建期烙印 build-info.json
Dockerfile / compose.renderer.yml / .env.renderer.example
```
