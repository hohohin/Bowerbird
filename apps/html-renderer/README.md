# @bowerbird/html-renderer — Bowerbird 受限 HTML 离线 Renderer

> 依据 [dev-doc/HTML-RENDER-PLAN.md](../../dev-doc/HTML-RENDER-PLAN.md)（H0-T1 镜像契约 + H1 独立 renderer）。
> 状态：**H0–H5 完成并通过生产 VPS/控制面 E2E；H6 test-only 观察进行中。** 当前生产 renderer `0.1.1`，指纹 `bwr1-c0ee5722787c038aa560e4a5cbb54df2`。

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
- `GET /healthz`：fingerprint、Chromium/Playwright 版本、队列/时延指标与 cgroup 内存/PID 当前值和峰值；不含任何用户内容。cgroup 统计覆盖 Chromium 子进程，本地不可用时降级为 Node RSS/heap。
- 并发 1 + 等待队列 1；超出立即 `render_capacity_busy`。
- 日志为 JSON lines，只含 requestId/时长/字节/稳定错误码，**不含 HTML/CSS 正文与图片内容**。

## 部署（VPS）

```bash
cd apps/html-renderer
cp .env.renderer.example .env.renderer   # 填 RENDER_INTERNAL_TOKEN
docker compose -f compose.renderer.yml up -d --build
```

- 容器只挂在 `bowerbird-internal`（internal: true）网络上；Agent Worker 侧（H2）加入同一网络后经 `http://html-renderer:3917` 调用。
- 镜像内烙印 `build-info.json`（基础镜像 tag、字体包版本、playwright 版本）；`rendererFingerprint = bwr1-<hash>` 绑定代码版本/Chromium/Playwright/字体/默认样式/PNG 编码参数（`src/fingerprint.ts`）。
- Chromium sandbox 保持开启，绝不默认 `--no-sandbox`（计划 H0-T5：如只能靠关 sandbox 运行则停止并重新评估）。

## H5 验收脚本（2026-08-28）

```bash
# 容器安全自检（VPS 部署后 exec 进容器运行；任一断言失败退出码 1）
docker compose -f compose.renderer.yml exec -T html-renderer node /app/scripts/verify-container.mjs

# renderer 侧 E2E（合成中文长页 → 整页+切片 → 逐像素连续性校验；输出无内容摘要）
node scripts/e2e-render-check.mjs --local        # 开发机（可用 BOWERBIRD_E2E_EXECUTABLE 指定 Chromium）
node scripts/e2e-render-check.mjs --url http://127.0.0.1:3917   # 容器内/隧道（需 RENDER_INTERNAL_TOKEN）
```

- `/healthz` 现含无内容 metrics（渲染计数、错误码分布、p50/p95/max 时延、超时预算外计数）与 resources（容器 current/peak memory、current/peak PIDs）。
- 资源图片在进入浏览器前做**尺寸声明防护**（PNG IHDR / JPEG SOF / WebP 头；单边 ≤32768、≤64MP），小文件大尺寸的解压炸弹直接 `render_resource_invalid`。

## 镜像扫描与 Chromium 安全更新流程（H5-T2）

- **扫描**（VPS 实测命令；GitHub/ghcr 在腾讯云线路不可达，漏洞库走 ECR 公共镜像）：
  ```bash
  sudo docker run --rm -e TRIVY_DB_REPOSITORY=public.ecr.aws/aquasecurity/trivy-db:2 \
    -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/out aquasec/trivy:latest \
    image --scanners vuln --severity HIGH,CRITICAL --output /out/trivy.html bowerbird/html-renderer:local
  ```
  高危 CVE 未处理不得扩大开放；扫描结果与处理记录随部署归档（首扫台账见 PROJECT.md 2026-08-28 H5 条目）。
- **Chromium 安全更新**：唯一路径是升级 `package.json` 的 `playwright` 精确钉版 → 重建镜像 → `rendererFingerprint` 随之变化（记录进 PROJECT.md/部署记录）→ `verify-container.mjs` + `e2e-render-check.mjs --url` 复跑通过后才可对外。禁止在容器内手工替换 Chromium 二进制或临时加 flag。
- **回滚**：重建前保留旧镜像 tag（`docker tag bowerbird/html-renderer:local bowerbird/html-renderer:rollback-<日期>`）；回滚 = compose 指回旧 tag 重建，fingerprint 应回到记录值。

## H6 观察报告

```bash
cd apps/cloud
node scripts/report-html-render-observations.mjs --since=2026-08-28T05:15:00Z
```

报告只读 test-only HTML Run 元数据及未过期 render manifest 的尺寸/角色，不输出用户内容。H6 正式观察起点为 renderer `0.1.1` 部署时间；H5 联调和故障注入历史不能作为发布成功率。

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
  runtime-resources.ts  无内容 cgroup/Node 运行资源快照
  *.test.ts          单测；renderer.e2e.test.ts 需本机 Chromium，未装自动 skip
scripts/
  build-fingerprint.mjs  构建期烙印 build-info.json
Dockerfile / compose.renderer.yml / .env.renderer.example
```
