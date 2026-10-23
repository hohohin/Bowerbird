# Bowerbird Cloud · 部署指引（凭据已备好）

> 目标：把 `apps/cloud/` 的 Supabase 迁移 + Edge Functions 推上云端，完成 Auth/积分/算力的真实联调。
> 前提：你已在 Supabase 控制台拿到 Project URL / publishable key / secret key，并已在 `apps/cloud/.env` 填好方舟 key 与 endpoint id。

## 2026-10-22 后台用户管理已发布

仅定向应用 **0069**（0068 保持未应用），`code-admin` **v4** 已上线、JWT 开启，其他 Edge 保持。官网 `/admin/` 新增用户列表／搜索／测试账号筛选及资格授予／取消，复用服务端管理员标记并原子留审计。现役官网目录 `/opt/bowerbird/website-releases/20261022-user-admin`，基于并保留 `20261022-windows-26.10.2203`；仅更新 admin 三文件，账号网关、下载配置和更新通道未改。

真实临时账号 API、浏览器操作、权益刷新、幂等审计、越权／撤权、会员积分不变通过；临时账号已清理，审计保留。证据 `.tmp/user-admin-20261022/`；上线与回滚细节见 [用户管理](PRO-REDEMPTION.md#用户管理2026-10-22已上线)。旧 Edge 位于证据目录 `rollback/`；官网回滚切回 2203 并重启服务。未变官网文件使用硬链接克隆，后续修改须替换 inode，禁止原地写共享文件。未部署 Worker、桌面或 GPT 模型。

## 2026-10-22 分类 v6 与 Windows 26.10.2202 已发布

jev-proxy v6 已上线并下载核对全部依赖源码；matching_version=8 为 42%，无字段的旧客户端保留 30%，未知版本调用前拒绝。Windows 26.10.2202 包含 SQLite 0043/0044 与新版请求字段。13 项 Deno（含真实 handler 的新旧分流）、Rust 最终 652/0/21 和 14 组界面通过；线上未登录请求返回 401，未调用真实模型。原 0067 及五图计费保持，没有迁移或 Worker 部署，0068/GPT 保持未开放。旧 v5 源码备份及发布报告在 .tmp/release-windows-26.10.2202/cloud/；v5 不支持新门槛，新桌面仍在线时不直接回退。

## 42% 分类协议发布准备（2026-10-22，历史准备记录）

发布兼容补充：新版 judge 请求带 `matching_version=8`，云端采用 42%；已发布旧客户端未带字段仍用 30%，未知版本在推理前拒绝。版本字段参与现有请求哈希，重放不能换规则。部署先兼容云端、后新版桌面，无须强制所有客户端同时升级。13 项 Deno 包含真实 handler 的 35% 新旧分流及结算参数，Rust 检查请求字段。

仅部署 jev-proxy；不应用 0068 或其他待迁移项。现役 v5 已下载备份，候选依赖仅 index.ts/protocol.ts 与线上不同；token 账本与五图计费保持。证据及回滚源码 `.tmp/release-windows-26.10.2202/cloud/`。

## Cloud 补标签 token 计量（2026-10-22 已部署）

当前 `jev-proxy` 为 **v5**，数据库新增 **0067**。补标签先建立持久账本，再调用方舟；响应 usage 在标签校验前写入，独立保留，不随 24 小时响应清理删除。缺失或超时标记待核对，不能按零成本统计。部署顺序为定向应用 `0067_classification_usage.sql` → 部署 `jev-proxy`；无新 Secret、VPS 或桌面变更。重部署勿全量 push 其他待迁移项。

12 项 Deno 测试、隔离数据库回归及一次真实方舟补标签通过；生产核验输入 2103 / 缓存 0 / 输出 126 / 总计 2229 token，重复调用无新增账本，用户积分规则保持。证据及旧代理位于 `.tmp/classification-usage-20261022/`。回滚仅恢复其中 `rollback/` 的旧代理，保留 0067 和已保存数据；旧代理不再采集新用量。字段、缺失状态、核算与查询见 [分类专项](../../dev-doc/LOCAL-CLASSIFICATION.md#2026-10-22-cloud-补标签真实-token-账本已上线)。

## Jev 同步托管分类（2026-10-20 初次部署）

0065/0066 已定向应用；`jev-proxy` v4 / `understand-worker` v21 已上线，Jev Secret 已配置。用户确认 `JEV_CLASSIFICATION_COST_MICROS=100000`（0.10 元/张保守成本预算，不是用户售价）。临时测试账号的 4 次真实 Jev + 1 次 Cloud 补标签验证了五张扣一积分及重复请求幂等；证据 `.tmp/classification-deploy-20261020/`。后续重部署仍遵守以下顺序。

1. 审核并应用 `0065_classification_proxy.sql`、`0066_classification_no_rate_limit.sql`；不要直接对有其他待迁移内容的工作区执行未筛选的全量 push。
2. 在 Supabase Secrets 配置 `JEV_API_KEY` 和 `JEV_CLASSIFICATION_COST_MICROS`。后者为一次 Jev 判断加最坏一次 Cloud 补标签的保守人民币微元预算，必须根据实际供应商费用填写；不从客户端读取密钥，也不能以用户售价代替供应商成本。沿用 `DAILY_COST_LIMIT_CNY`、`FREE_CAPTION_DAILY_LIMIT`；分类不再读取 `RATE_LIMIT_PER_USER_PER_MIN`。继续使用方舟 Vision 配置，生产设置 `BOWERBIRD_CLOUD_MOCK=false`。
3. 部署 `jev-proxy`（用户 JWT + 内部 `requireUser`），再部署 `understand-worker --no-verify-jwt`。已有 worker 的 `cleanup_expired` 负责清理分类挂起请求和过期响应，不承担分类推理。每次新分类也会尝试清理。
4. 构建并重启新桌面后端后再启用客户端入口；旧后端仍要求本地 Jev Key。上线以同一测试账号验证第 1–4 张实际扣 0、第 5 张扣 1、跨批次累计、Jev/Cloud 混合、无法判断/失败/重复请求及 24 小时响应清理。

新接口在单次请求中同步完成 Jev 或补标签调用，不上传对象存储、不创建 worker 排队任务、不轮询。数据库只保留计费/幂等记录及 24 小时响应；图片只在请求内存中。一次图像流程先暂时预留 1 积分（并发请求各自预留），完成后实际扣 0 或 1 并释放余款。取消等待不撤回已经完成的云端结果，云端产生有效标签即算成功；不以客户端声明作为计费依据。挂起超过 10 分钟按未完成退还预留款；供应商成本预算不退回，避免失败重试绕过熔断。免费账号沿用云理解额度，失败/无法判断退还次数，补标签不重复扣次数。

线上与隔离验收详情见 `dev-doc/LOCAL-CLASSIFICATION.md`。当前成本参数为保守预算，需按后续实际供应商账单校准；分类每用户分钟限流已取消，当前代理传入 NULL 跳过分钟门控及计数。五图计费、免费每日额度和全站成本预算保留。0066 必须先于 v4 代理部署；旧代理和数据库函数备份位于 `.tmp/classification-no-rate-20261020/rollback/`，回退先恢复旧代理，再恢复旧数据库函数。

## GPT Image 2.5（2026-10-22 源码接入，未部署／未启价）

普通 Cloud 生图新增两个独立服务：`image_gpt25_sunburst` → `gpt-image-2.5-sunburst`，`image_gpt25_flare` → `gpt-image-2.5-flare`。使用现有 generation 队列、租约、产物上传与积分结算；本轮不改 Agent 的 `generate_image` 工具或本机 Codex 路线。模型与 `quality=high` 固定在 Worker，单任务生成一张 PNG。文本调用 `/v1/images/generations`，参考图调用 `/v1/images/edits` 的 JSON `images[].image_url`，支持七档比例和透明背景。自动比例在桌面无法推断时使用 1024×1024，明确比例按原比例输出、最长边不超过 1536。

**API key 填写位置：**

- 本地准备：现有 gitignored `apps/cloud/.env` 已预留 `OPENAI_API_KEY=`，在等号后填写；也可使用 `.env.local`，模板见 [.env.example](.env.example)。本地在 `apps/agent-worker` 目录启动时显式使用 `node --env-file=../cloud/.env src/cloud-generation/main.ts`（选择 `.env.local` 时相应改路径），该文件还须包含原有 Worker 配置。
- **线上实际生效位置：VPS `/opt/bowerbird/agent-worker/.env.generation`**，加入同名 `OPENAI_API_KEY`。两个模型共用一个有对应模型权限的 OpenAI API key；文件权限保持 `0600`。本地填写不会自动同步到 VPS。
- Compose 的 `env_file` 已加载该文件；更新 Worker 镜像后需重建容器使新环境生效。此 key 不用设置为 Supabase Secret，也不进入桌面、网页或 DSH 子进程。未配置时仅 GPT 两档在提交前失败，方舟保持可用。

上线顺序：

1. 同步新 Worker 源码并构建候选镜像，完成离线检查，填写 VPS key；部署时保留现役镜像与环境备份。
2. 应用 `0068_gpt_image_25.sql`。迁移创建两条 `active=false / unit_cost=0 / pricing_ready=false` 的档位；只迁移不会把未定价模型开放给用户。
3. 分别确认 Sunburst / Flare 的每张积分价格，再在同一更新中设置各自 `unit_cost`（正整数）、`parameters.pricing_ready=true`、`active=true`，增加 `pricing_version` 并更新 `updated_at`。数据库约束拒绝零价或未确认价格直接启用。测试中的 17/18 分仅为隔离夹具，不是产品价格。
4. 刷新账号权益后，桌面现有动态 provider 列表会显示两项，key 分别为 `bowerbird-cloud-image_gpt25_sunburst` / `bowerbird-cloud-image_gpt25_flare`；无需为此修改桌面选项。完成真实生成、参考图编辑与单次扣费验收后记录部署证据。

OpenAI 明确拒绝参数／权限／配额时沿失败回滚处理；网络中断、408/5xx、无效成功响应或产物上传失败保留 `outcome_unknown`，不自动重发或退款。回滚时先停用两档、等待在途 GPT 任务结算，再恢复旧 Worker，避免旧 Worker 将新 service 当方舟默认档处理；保留迁移与账本。

离线验证（仓库根目录；不加载真实 key、不访问模型）：

```powershell
node --test apps/agent-worker/src/cloud-generation/*.test.ts
node --test --test-name-pattern="passes only the loopback model proxy" apps/agent-worker/src/harness/node-dsh-acp-port.test.ts
node apps/cloud/scripts/gpt-image-db.test.mjs <本地PGlite目录>/dist/index.js
```

协议依据：[OpenAI Images generation](https://developers.openai.com/api/reference/resources/images/methods/generate)、[Images edits](https://developers.openai.com/api/reference/resources/images/methods/edit)。

本轮验证：35 项 cloud-generation 测试、DSH 环境白名单单测、Worker 完整 TypeScript、桌面动态档位映射及 PGlite 计费回归通过。完整 DSH port 套件中的两项生命周期测试受当前 Windows `symlink EPERM` 阻挡；密钥隔离使用不创建链接的 `buildDshChildEnvironment` 测试验证，未改动该运行时。

2026-10-22 11:49（北京时间）本地真实访问：直连超时，经系统代理后 `GET /v1/models/gpt-image-2.5-sunburst` 与 Flare 对应查询均为 200。使用新增 provider 的实际请求／解析代码分别提交一次 high / 1024×1024 生图，两次均为 `429 / credit_balance_exhausted / insufficient_quota`，未返回图片或 usage，无自动重试。Sunburst 请求 ID `req_5d0c811b4a0d44889760e4ff03c53063`，Flare `req_c1285a5d68c6471abebac135e1d7dd82`。证据及不含密钥的测试脚本位于 `.tmp/gpt-image-real-20261022/{access.json,generation.json,probe.mjs,generate.mjs}`。本次直接测试 OpenAI API，未走 Bowerbird 积分或生产任务队列；不能推断供应商费用为零。待补足 OpenAI API 额度后继续真实出图验收，线上仍未部署／启价。

## 需要手工做的事（按顺序）

### 1. 安装 Supabase CLI

任选其一：

- **npx**（无需全局安装）：
  ```bash
  npx --yes supabase@latest --version
  ```
- **Scoop**（Windows）：
  ```powershell
  scoop install supabase
  ```
- **Homebrew**：
  ```bash
  brew install supabase
  ```

验证：
```bash
npx --yes supabase@latest --version
```

下文的 `supabase ...` 命令在未全局安装时可统一替换为 `npx --yes supabase@latest --agent no ...`。

### 2. 登录并链接项目

```bash
npx --yes supabase@latest --agent no --output-format text login
# 会打开浏览器授权，授权后回终端
npx --yes supabase@latest --agent no link --project-ref <你的-project-ref>
```

`<project-ref>` 在 Supabase 项目 Settings → General → Reference ID。

### 2.1 配置 Auth 回调 URL（托管项目必须手工同步）

打开 Supabase Dashboard → Authentication → URL Configuration：

1. 在 **Redirect URLs** 添加 `bowerbird://auth/callback**`（桌面 PKCE 回调会附带动态 `state` 查询参数，不能只填无查询串的精确地址）。
2. 本地官网开发再添加 `http://127.0.0.1:5173/**` 与 `http://localhost:5173/**`。
3. 官网上线后，把正式 HTTPS origin 设为 **Site URL**，并把同一 origin 加入 Redirect URLs。
4. Magic Link 邮件模板的按钮应使用 `{{ .ConfirmationURL }}`；若自定义模板直接使用 `{{ .SiteURL }}`，代码传入的 redirect URL 不会生效。

未命中 Redirect URLs 时，Supabase 会回退到 Site URL；控制台默认值通常是 `http://localhost:3000`，表现为邮件链接验证后跳到无法访问的本机地址。
Windows 用 `tauri dev` 验收时，桌面端会在 debug 环境运行时注册 `bowerbird://`；安装包则由系统安装过程注册。

> Supabase 内置 SMTP 仅供试用，整个项目最多发送 2 封 Auth 邮件/小时；这与 OTP 接口的 60 秒单邮箱冷却、30 次/小时额度是不同层级。需要持续联调或对外发布前，应在 Authentication → Emails → SMTP Settings 配置自定义 SMTP。

### 3. 推送数据库迁移

```bash
cd apps/cloud
npx --yes supabase@latest --agent no db push
```

会按文件名顺序执行全部本地迁移；当前 Agent Runtime 要求至少到 `0039_agent_clarification_answer.sql`。`0010` 必须先于新版 `generate-proxy` / `understand-proxy`；`0011` 必须先于新版 `entitlement` / `generate-proxy` / `understand-proxy`；`0015` 必须先于异步版 `generate-proxy`、`generation-worker` 与 VPS consumer；`0019` 必须先于异步版 `understand-proxy`、`understand-worker` 与 VPS understand consumer；`0028`–`0030` 必须先于支持 Codex/即梦本机生图停车交接的链路；`0031`/`0032` 必须先于文本 usage 可信计量和定时 TTL 清理版 `agent-worker`；`0033`/`0034` 必须先于 Agent 账单 marker 与原子容量闸版 `entitlement` / `agent-run`；`0035` 负责过期未租约 parked Run 的原子取消，`0036` 负责生产/测试监控样本隔离，`0037`/`0038` 修复已部署早期迁移遗留的 Codex Run、本机任务与 usage provider 数据库约束，`0039` 原子应用有限澄清答案并使旧计划审批失效。统一 Agent 进入多图片最终结果版本前，必须先应用 `0053_unified_agent_multi_final_results.sql`，使数据库终态结算与 Edge 的多 `final_result` 策略一致；legacy Skill 仍要求唯一最终结果。

### 4. 部署 Edge Functions 并注入 Secrets

```bash
# 部署函数
supabase functions deploy generate-proxy
supabase functions deploy generation-worker --no-verify-jwt
supabase functions deploy understand-proxy
supabase functions deploy understand-worker --no-verify-jwt
supabase functions deploy entitlement
supabase functions deploy create-checkout
supabase functions deploy payment-webhook
supabase functions deploy agent-run
supabase functions deploy agent-worker --no-verify-jwt
supabase functions deploy wechat-login --no-verify-jwt

# 注入 secrets（从 .env 读取；只上传一次，函数运行环境持有）
supabase secrets set SUPABASE_URL=$SUPABASE_URL
supabase secrets set SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY
supabase secrets set SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
supabase secrets set ARK_API_KEY=$ARK_API_KEY
supabase secrets set ARK_BASE_URL=$ARK_BASE_URL
supabase secrets set ARK_IMAGE_MODEL=$ARK_IMAGE_MODEL
supabase secrets set ARK_VIDEO_MODEL=$ARK_VIDEO_MODEL
supabase secrets set ARK_VISION_MODEL=$ARK_VISION_MODEL
supabase secrets set ALLOWED_ORIGINS="https://bowerbird.cn,http://127.0.0.1:5173,http://localhost:5173"
supabase secrets set DAILY_COST_LIMIT_CNY=500
supabase secrets set COST_CNY_PER_CREDIT=0.047
supabase secrets set ARK_IMAGE_TIMEOUT_MS=135000
supabase secrets set PROXY_TIMEOUT_MS=140000
supabase secrets set RATE_LIMIT_PER_USER_PER_MIN=10
supabase secrets set AGENT_GLOBAL_ACTIVE_LIMIT=100
supabase secrets set BOWERBIRD_CLOUD_MOCK=false
supabase secrets set GENERATION_WORKER_TOKEN=$GENERATION_WORKER_TOKEN
supabase secrets set UNDERSTAND_WORKER_TOKEN=$UNDERSTAND_WORKER_TOKEN
supabase secrets set AGENT_WORKER_TOKEN=$AGENT_WORKER_TOKEN
supabase secrets set BOWERBIRD_PAYMENT_MOCK=true
supabase secrets set SUPERUN_WEBHOOK_SECRET=$SUPERUN_WEBHOOK_SECRET
supabase secrets set WECHAT_APP_ID=$WECHAT_APP_ID
supabase secrets set WECHAT_APP_SECRET=$WECHAT_APP_SECRET
supabase secrets set WECHAT_REDIRECT_URI=$WECHAT_REDIRECT_URI
```

> ⚠️ 目前 `.env` 里 `BOWERBIRD_CLOUD_MOCK=false` 已开启真实方舟；`BOWERBIRD_PAYMENT_MOCK=true` 保持 Mock 支付，**不要**提前改 false。

### 4.0 Entitlement 非对称签名（P9：7 天离线 Pro 宽限）

```bash
# 1) 生成密钥对（脚本会输出 secrets set 命令与桌面构建公钥）
node apps/cloud/scripts/gen-entitlement-keypair.mjs

# 2) 私钥进 Edge Secret（值即脚本输出的 ENTITLEMENT_SIGNING_KEY=...）
supabase secrets set ENTITLEMENT_SIGNING_KEY=<base64 PKCS#8 DER>

# 3) 公钥进桌面构建：追加到 apps/cloud/.env(.local)（本地构建 build.rs 自动读取）
#    BOWERBIRD_ENTITLEMENT_PUBKEY=<base64 原始 32 字节>，官方构建则注入构建环境同名变量

# 4) 重新部署 entitlement（此后响应 signature_version=1 + Ed25519 签名）
supabase functions deploy entitlement
```

验收：桌面登录后 `entitlement.json` 缓存含非空 `signature`；断网重启 app，权益面板仍显示 Pro/Studio（Fresh/Grace），7 天后降级 free。未配置 Secret 时函数自动回落 `signature_version=0`（在线可信、无离线宽限），不会报错。轮换 = 换密钥对 + 同步换桌面内置公钥发版；旧签名验签失败自动降级，用户在线重同步即可。

`generation-worker` / `understand-worker` / `agent-worker` 必须使用 `--no-verify-jwt` 部署，因为 VPS 使用专用 Worker Token 而不是用户 JWT；Function 内部会常量时间校验各自的 `GENERATION_WORKER_TOKEN` / `UNDERSTAND_WORKER_TOKEN` / `AGENT_WORKER_TOKEN`。VPS 只持这些 Token、DeepSeek 与方舟 Key，绝不能持 Supabase secret/service-role。

`understand-proxy` 由 `UNDERSTAND_ASYNC` 开关控制双模式（默认 `false` 保持旧的同步单次请求行为）。上线顺序：先部署函数（开关关）→ 更新 VPS 容器 → 发布新版桌面端（create/轮询兼容两种响应）→ 最后 `supabase secrets set UNDERSTAND_ASYNC=true` 切到异步任务模式，摆脱 Edge 墙钟上限。观察稳定后旧同步路径随生图 135/140s 回退一并移除。

### 4.1 部署 VPS Worker（生图 + 理解消费循环，同一容器）

把 `apps/agent-worker/{Dockerfile.unified-harness-candidate,compose.generation.yml,src,scripts}` 部署到 `/opt/bowerbird/agent-worker`，把 `spikes/unified-agent-harness-u1/profiles/bowerbird-u1` 部署到 `/opt/bowerbird/dsh-profile`，并创建权限 `0600` 的 `.env.generation`。仓库内 Compose 默认使用相对 Profile 路径；VPS 扁平目录必须通过同一 env 文件显式覆盖 build context：

```dotenv
GENERATION_CONTROL_URL=https://<project-ref>.supabase.co/functions/v1/generation-worker
GENERATION_WORKER_TOKEN=<与 Supabase Secret 完全一致的高熵随机值>
GENERATION_WORKER_ID=lighthouse-guangzhou-1
ARK_API_KEY=<方舟 Key>
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_IMAGE_MODEL=<Seedream Pro endpoint id（image_hd 与 image_fast 档共用 + 未知档兜底）>
ARK_IMAGE_MODEL_LITE=<Seedream Lite model id（image_lite 与遗留 image_sd 档；官方 Lite 即标准版 doubao-seedream-5-0-260128）>
ARK_IMAGE_SIZE=2K
BOWERBIRD_CLOUD_MOCK=false
GENERATION_POLL_INTERVAL_MS=2000
GENERATION_HEARTBEAT_INTERVAL_MS=30000
UNDERSTAND_CONTROL_URL=https://<project-ref>.supabase.co/functions/v1/understand-worker
UNDERSTAND_WORKER_TOKEN=<与 Supabase Secret 完全一致的高熵随机值>
UNDERSTAND_WORKER_ID=lighthouse-guangzhou-1
ARK_VISION_MODEL=<豆包 Vision endpoint id>
ARK_REPLICATION_VIDEO_MODEL=doubao-seed-2-0-mini-260428
ARK_REPLICATION_TEXT_MODEL=doubao-seed-2-0-mini-260428
RENDERER_URL=http://html-renderer:3917
RENDER_INTERNAL_TOKEN=<与 html-renderer .env.renderer 完全一致的高熵随机值>
BOWERBIRD_DSH_BUILD_CONTEXT=/opt/bowerbird/dsh-profile
BOWERBIRD_CLOUD_SHARED_BUILD_CONTEXT=/opt/bowerbird/cloud-shared
BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED=false
BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED=false
BOWERBIRD_DSH_MODEL=deepseek-flash
```

```bash
cd /opt/bowerbird/html-renderer
cp .env.renderer.example .env.renderer
chmod 600 .env.renderer
# 生成至少 32 字节随机 token，填入 .env.renderer；同一值也填入 agent-worker/.env.generation
sudo docker compose -f compose.renderer.yml up -d --build

cd /opt/bowerbird/agent-worker
sudo docker compose --env-file .env.generation -f compose.generation.yml up -d --build
sudo docker compose --env-file .env.generation -f compose.generation.yml ps
sudo docker compose --env-file .env.generation -f compose.generation.yml logs --tail 50
```

`html-renderer` 只连接 `internal: true` 的 `bowerbird-internal` 网络，无宿主端口和公网出口；Worker 同时连接默认出站网络与该内部网络，通过固定 `RENDERER_URL` 调用。先启动 renderer 创建内部网络，再启动 Worker。两个 env 文件中的 `RENDER_INTERNAL_TOKEN` 必须一致且权限为 `0600`，不得写入仓库或日志。

Worker 容器不映射入站端口、只读根文件系统、非 root、丢弃全部 capabilities，并限制 1536 MiB 内存、1.75 CPU、256 PID、256 MiB workspace tmpfs 与 10 MiB × 3 JSON 日志。容器入口为 `src/main.ts` 组合入口：按 `GENERATION_CONTROL_URL` / `UNDERSTAND_CONTROL_URL` / `AGENT_CONTROL_URL` 是否配置分别启动生图、理解与 Agent 三个消费循环，互不阻塞。方舟同步请求（生图与理解）不设置 120/135 秒主动终止；等待期间每 30 秒向 Bowerbird 控制面续租。Agent 循环每 10 分钟运行 TTL/orphan 清理并输出不含用户内容的控制面与磁盘健康指标；可在运维端运行 `node apps/cloud/scripts/check-agent-runtime-health.mjs` 做阈值探测。

视频 Worker 镜像安装 `ca-certificates` 与 `ffmpeg`（包含 `ffprobe`），并从 `cloud-shared` 构建上下文复制 `video-contract.ts` 与 `task-authorization.ts` 到 `/cloud/supabase/functions/_shared/`，保持源码跨包导入路径。VPS 上将仓库 `apps/cloud/supabase/functions/_shared/` 中这两个文件同步到 `/opt/bowerbird/cloud-shared/`；不得把包含 `.env` 的整个 Cloud 目录当作构建上下文。直接调用 `docker build` 时也要传 `--build-context cloud-shared=<上述目录>`。生产 `/tmp` 为有界 640 MiB，覆盖单个 500 MiB 视频探测文件；其他 CPU/内存/PID 限制不变。候选镜像需在无网络、只读根目录和可写 `/tmp` 下运行 `node /app/scripts/video-readonly-probe.mjs`，核验生产入口导入及真实合成 MP4 探测；加 `--max-size` 用合法 MP4 free box 检查 500 MiB 上限（采用 640 MiB /tmp 和原 1536 MiB 内存限制），不调用模型或替代真实下载/并发验收。视频上线同时需要 `0058` 迁移和 `generate-proxy` / `generation-worker`；迁移默认不启价，价格须另行确认。

### 5. 微信扫码登录（H5，备案域名 bowerbird.cn）

登录链路：桌面/官网 → 系统浏览器打开 `open.weixin.qq.com/connect/qrconnect`（appid/回调域由 `wechat-login` GET 按 Secrets 组装）→ 微信回调到备案域名静态中转页 [website/wechat-callback.html](../../website/wechat-callback.html)（VPS 直接伺服该静态文件）→ 按 `state` 前缀分流：`dt_` 跳 `bowerbird://wechat/callback` deep link 由桌面 Rust 校验后 POST 换会话；`web_` 中转页同源校验 sessionStorage 后自行 POST 换会话。`wechat-login` Function 用 service role `generateLink(magiclink)` 取得 `hashed_token` 与 GoTrue 返回的 `verification_type`，再调用 `/auth/v1/verify` 铸真实 GoTrue 会话（unionid→确定性合成邮箱建号，注册触发器照常发 30 分）。

```bash
supabase functions deploy wechat-login --no-verify-jwt   # §4 的 secrets（H5 段）备好后执行
```

微信侧与 VPS 侧手工步骤：

1. 微信开放平台 → 网站应用 → 授权回调域填 `bowerbird.cn`（不带协议、不带路径）。
2. `wechat-callback.html` 随官网 `dist/` 一起部署（`WECHAT_REDIRECT_URI=https://bowerbird.cn/wechat-callback.html`）；与官网同源，nginx/官网 server.mjs 无需任何改动。
3. `ALLOWED_ORIGINS` 必须包含 `https://bowerbird.cn`（官网浏览器直调该函数走 CORS）。
4. Supabase Dashboard 无需改动：微信链路不经过 GoTrue redirect/邮件模板，会话由 service role 经 `generateLink`+`verify` 直接签发。

### 5.5 桌面账号官网网关（2026-10-22）

桌面账号传输入口为 `https://bowerbird.cn/api/account`。实现位于 `website/account-proxy.mjs`，由 `website/server.mjs` 挂载；桌面 `CloudConfig.account_api_url` 在官方构建中固定配置，测试配置为空时才使用测试 Supabase 地址。微信 GET/POST、邮件 OTP、PKCE/refresh token 交换、签名权益和兑换走此入口；生成、理解、分类及 Storage 仍使用各自现有 Cloud 路径。本次不改 Edge Function、SQL、计费或密钥。

- 严格开放上述方法和路径；邮箱验证仅 GET `/auth/v1/verify`，token grant 仅 `pkce` / `refresh_token`。上游从服务器公开配置读取，函数区域固定 `ap-northeast-1`，不接受客户端目标地址。官网仍只配置 publishable/anon key，不放 service role；权益和兑换原样转发用户 Bearer，由 Supabase 校验。
- 输入 64 KiB、输出 1 MiB，上游 20 秒超时；不跟随上游重定向、不自动重发授权码或刷新令牌、不转发 cookie。邮件验证只允许桌面 `bowerbird://auth/callback`、官网同源，以及原有开发 Site URL `http://localhost:3000`。返回的 state/code 保持完整，登录客户端继续执行 pending state / PKCE 校验。
- Nginx `/api/account/` 禁止 access/error 请求日志、缓存和 Referer 泄漏，限制上传及等待时间；Node 不记录请求正文、查询参数、用户令牌。网关错误只输出固定文案与错误码，桌面仍使用 `accountErrorMessage`。有效业务 JSON 字节保持，客户端继续使用原公钥验签权益。
- 按 IP 限制账号 120 次/分钟、邮件 5 次/10 分钟，最多 10,000 个内存桶；仅在 loopback 且显式信任代理时使用 Nginx 覆写的 `X-Real-IP`。Supabase 自身限流仍生效；不使用需要 secret key 的 `Sb-Forwarded-For`，故 Auth 上游也可能按 VPS 出口聚合限流。扩容时应单独评估，不能靠放宽鉴权解决。
- Supabase 的 magic link / confirmation 两个模板，仅将原 `ConfirmationURL` 链接改成官网 verify 路径，保留 `TokenHash`，type 分别 `magiclink` / `signup`，`RedirectTo` 经 Go 模板 `urlquery` 编码。原 Site URL、回调白名单保持；已发送的旧邮件仍是旧入口。管理 API 同时将 `mailer_templates_custom_contents` 中对应的自定义模板状态置 true；应核对内容和此派生状态，而不是忽略所有额外字段变化。

首轮网关发布目录 `/opt/bowerbird/website-releases/20261022-account-gateway`，此前目录 `20261022-windows-26.10.2202` 保留。`account-proxy.mjs` SHA-256 `1e0bcd8680bcc19d5d45e6efe7de02af248503772228496e01e078641e1cf49a`。服务器 `/tmp/bowerbird-account-gateway-20261022/` 保存部署/回滚脚本及 Nginx 原配置；本机 `.tmp/account-gateway-20261022/` 保存原邮箱模板、只读回查与链路报告。回滚模板须先逐字核对现值仍为本次内容，再只恢复这两个模板；最后回滚网关，避免已发新邮件失效。后续桌面发布会继承网关，不能只回退目录而遗忘仍在使用新路径的客户端。

验证：Node 网关 10 项和官网更新入口回归、Rust Cloud 44 项、TypeScript；候选/现役/公网二维码 HTTP 200、无效刷新 400、匿名权益 401、邮件验证 303；实际 Rust CloudClient 四项网关对照通过。独立临时账号经真实邮件验证（admin generateLink，不发邮件）、刷新和权益查询通过，Ed25519 验签成功，无效兑换被拒绝，账号已删除。真实 PKCE 邮件投递及另一台电脑的微信扫码完整回跳尚待实机确认，不能用这些测试声称原机已登录成功。

部署时曾因完整复制下载目录耗尽磁盘；已对本轮目录与上一版相同的 38 个不可变包逐字节核对，再原子共享硬链接，释放 1,149,724,089 bytes，所有下载路径保留。后续发布只对不可变安装包共享链接，配置、首页、更新 JSON 必须独立复制，避免修改现役或回滚清单。

### 5.6 ComfyUI TOS 安装授权（2026-10-23）

新增 `comfy-download` v1：平台 `verify_jwt=true`，函数再通过 `requireUser` 验证身份，实时读取订阅并允许有效 Pro／Studio 或 `app_metadata.bowerbird_test=true`。仅为 `_shared/comfy-download-manifest.json` 的六个固定资源签发 1 小时 GET URL，不接收自定义桶/主机/路径、不扣积分、不转发大文件。签名与原生清单交叉检查及官方 SDK 向量验证见 [本机 H3](../../dev-doc/COMFYUI-LOCAL-VIDEO.md#tos-安装下载接入2026-10-23服务已上线客户端待发布)。

Secrets 仅新增 `COMFY_TOS_ACCESS_KEY_ID`、`COMFY_TOS_SECRET_ACCESS_KEY`，从用户填写的根 `.env.tos` 安全导入，临时 env 文件已删除；不放进网页或桌面。Supabase Secrets 更新使既有 15 个函数版本号各加 1，原代码包 SHA/JWT 配置逐一相同，无其他函数源码、数据库迁移、价格或 Worker 部署。

官网 `/api/account/functions/v1/comfy-download` 仅 POST，经现有无日志、no-store、限流网关；10:16:15（北京时间）现役 `/opt/bowerbird/website-releases/20261023-comfy-tos`，前版 `/opt/bowerbird/website-releases/20261023-tos-distribution` 保留。唯一文件差异 `account-proxy.mjs`，SHA-256 `363bdde73b028bcaf90cb31dfb0af756abeab7955c61cf0b87f3eb2bd875a53e`；回滚时原子恢复前版 symlink 并重启 `bowerbird-website.service`，必要时另移除本次新函数及其专用 Secrets。不要还原其他函数或改桶 ACL。

代码、候选/现役/公网拒绝未授权、三平台更新保持、账号网关及 6 个对象真实签名 Range/匿名/过期拒绝已验证。自动审批阻止了临时生产账号写入验收，因此没有声称线上真实 Pro 登录至下载的完整链路通过；全新安装/GPU 和新客户端发布仍待完成。证据本机 `.tmp/tos-migration/comfy-*` 及 VPS `/tmp/bowerbird-comfy-tos/`。当前公开桌面包仍使用旧安装器，须发布包含新原生代码的版本。

## 6. 验证

```bash
# 1. RLS/积分测试（需要本地 Node + Supabase CLI）
cd apps/cloud
supabase db reset
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/billing.sql
node scripts/test-billing.mjs
node scripts/test-payment.mjs
node --env-file=.env scripts/test-payment-webhook-smoke.mjs  # 本地有回调密钥时同时验证正确签名分支

# 2. Edge Functions 冒烟（需要本地 Deno + Supabase CLI）
supabase functions serve --env-file .env
# 另一个终端：
curl -H "Authorization: Bearer <测试用户 access token>" \
  "$SUPABASE_URL/functions/v1/entitlement?forceFunctionRegion=ap-northeast-1"

# 3. 真实注册 → 预授权 → 方舟出图 → 确认扣分 → 清理临时账号
# 会产生一次真实方舟费用；脚本从 .env 读取凭据，不输出 key。
$env:CLOUD_E2E_FUNCTION_REGION='ap-northeast-1'
node --env-file=.env scripts/test-cloud-e2e.mjs
Remove-Item Env:CLOUD_E2E_FUNCTION_REGION

# 4. VPS 异步链路（生图/理解，需 VPS Worker 已上线；UNDERSTAND_ASYNC 翻 true 后）
node scripts/test-generation-e2e.mjs basic     # 多参考图真实出图 + 失败回滚
node scripts/test-understand-e2e.mjs basic     # 真实 Vision 反推 + 失败回滚与免费额度回补
node scripts/test-understand-e2e.mjs guard     # 幂等重放 + 越权 404
node scripts/test-understand-e2e.mjs crash-create   # 配合 VPS 上 kill -9 Worker：输出 CRASH_JOB_ID
node scripts/test-understand-e2e.mjs crash-check <CRASH_JOB_ID>  # Worker 重启后验证 outcome_unknown 冻结

# 5. Agent 控制面（不调用模型、Vision 或生图；并发脚本只在 claimable Agent 队列为空时运行）
node --env-file=.env scripts/test-agent-clarification.mjs
node --env-file=.env scripts/test-agent-concurrent-claim.mjs
node --env-file=.env scripts/check-agent-runtime-health.mjs
```

## 7. 桌面端/官网真机验收

- 桌面端：构建前通过构建环境或 gitignored `apps/cloud/.env(.local)` 提供 `SUPABASE_URL` + publishable key；官方构建会将二者内置，用户设置不能修改。启动 app → 确认设置中 Bowerbird Cloud 显示“官方服务已配置” → 邮箱 Magic Link 登录 → 创作板选「Bowerbird Cloud」出图 → 查看积分扣减与流水。正式调用默认路由到东京 `ap-northeast-1`。
- 官网：把 `SUPABASE_URL` 与 `SUPABASE_PUBLISHABLE_KEY` 填到 `website/.env.local` 与 Render 环境变量，重启后登录验证共享积分。

## 支付（Mock）

`create-checkout` / `payment-webhook` 目前只提供 **Mock 契约**（验签、幂等、状态机）。**不要**接入真实支付渠道；等 superun/Paddle 凭据到位后再换真实 adapter。

## 注意事项

- Supabase secret/service-role 与支付 secrets 只在 Edge Functions；方舟生图 Key 还会存在于受限 VPS Worker。桌面端只持构建期内置的 URL/publishable key，用户不能编辑。
- `DAILY_COST_LIMIT_CNY` 是上海自然日的全站预估成本上限；单次预估成本 = 预扣积分 × `COST_CNY_PER_CREDIT`（默认 ¥0.047）。`RATE_LIMIT_PER_USER_PER_MIN` 是同账号每分钟首次上游请求数；同一幂等键重放不重复占用额度，也不会重复提交上游。
- `BOWERBIRD_CLOUD_MOCK` 与 `BOWERBIRD_PAYMENT_MOCK` 是两个独立开关：前者控制算力，后者控制支付。
- 部署完成后请告诉我「已部署」，我会继续真机验收（登录 → 积分 → 生成 → 流水 → 扣费/回滚）。
