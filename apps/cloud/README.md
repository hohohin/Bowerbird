# Bowerbird Cloud

Bowerbird Cloud 承载账号、积分和官方 API 托管算力。素材库、提示词库、`library.db`、原图与缩略图不做云同步，也不会形成云端资产库。

用户明确提交 Cloud 任务时，所选输入才按服务契约传输；批量托管分类也按用户选定的范围发送必要图片。图片生成与理解（`UNDERSTAND_ASYNC=true` 后）都会把本次请求加密传输后暂存在私有 `generation-temp` Storage（默认 24 小时 TTL），供受限 VPS Worker 领取并在 Edge 墙钟之外等待方舟，数据库只存对象 key、哈希、状态与理解结果文本（内容过期后清空），不存提示词或图片字节。日志不得记录内容，桌面确认下载后记录接收状态并由清理任务删除临时对象。`UNDERSTAND_ASYNC=false` 时理解仍走旧的单次 Edge 同步请求（110s 上游截断），作为异步链路上线前的回退。

## 当前服务

- 生成、理解、分层和视频的线上范围查 [部署手册](DEPLOY.md) 和 [PROJECT.md](../../PROJECT.md#目前进展)。生产算力使用真实 adapter。
- 微信支付 Native v3 已开放公开购买。商户配置、回调、退款和日账见 [微信支付](WECHATPAY.md)。Mock 适配仅供隔离开发，生产购买状态由服务端配置管理。
- [DSH · Cloud v2](CHAT.md) 是桌面对话及 Agent 卡片的云端通路。异步 Agent Run 使用 [统一 Harness](../../dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md)，保持 test-only。
- 本机环境变量见 [.env.example](.env.example)，将实际凭据保存在 Git 忽略的配置中。

桌面端 URL/publishable key 由 `apps/desktop/src-tauri/build.rs` 在构建时从构建环境或 gitignored `apps/cloud/.env(.local)` 读取并内置。用户设置不暴露或覆盖这些基础设施参数；Mock/真实 adapter 仍只由 Edge Function Secret 决定。

## 目录

```text
apps/cloud/
├── .env.example
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   ├── functions/
│   │   └── _shared/
│   └── tests/
└── README.md
```

## 本地开发

前置：安装并登录 Supabase CLI，且 Docker 可用。

```bash
cd apps/cloud
supabase start
supabase db reset
supabase functions serve --env-file .env.local
```

直连云端开发项目时，先执行 `supabase link --project-ref <ref>`，再使用 `supabase db push`。不要把 service-role key、方舟 key 或支付密钥传给桌面端/官网浏览器。

## 安全边界

- 客户端仅持有构建期内置的 Supabase URL 与 publishable/anon key，用户不能编辑。
- service-role 与支付密钥只存在于 Edge Functions secrets；VPS 只持专用 Worker Token 与方舟 Key（生图/理解共用），绝不持 service-role。
- 客户端不能直接写余额、流水、订阅或订单；写入只经服务端事务/RPC。
- Edge Functions 必须从已验证 JWT 推导 `user_id`，不相信请求体中的用户标识。
- 所有请求须限制体积、参考图数量、超时和频率；日志不得记录 token、提示词、图片字节或上游密钥。

## 验证

本地账务回归：

```bash
cd apps/cloud
supabase db reset
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/billing.sql
node scripts/test-billing.mjs
```

`billing.sql` 覆盖旧赠币账本兼容、FIFO、hold/confirm/rollback、余额不足、append-only 流水和客户端权限；Node 脚本让 20 个并发请求竞争同一幂等键，必须只产生一个 hold。

事务型 SQL 在隔离 PostgreSQL 中验证。PGlite 账务回归及 Edge 入口见 [验证命令速查](../../AGENTS.md#常用验证命令速查)。

P2 Edge Functions（Supabase CLI/Deno 可用后）：

```bash
cd apps/cloud
supabase functions serve --env-file .env.local
# 用真实测试用户 access token，不要用 service-role token 模拟用户
curl -H "Authorization: Bearer $TEST_ACCESS_TOKEN" \
  "$SUPABASE_URL/functions/v1/entitlement"
```

生产支付契约的定向验证见 [微信支付验证记录](WECHATPAY.md#验证记录)。

已定义的契约：

| Function | Method | 用途 |
|---|---|---|
| `generate-proxy` | POST | JWT → hold → 私有输入暂存 → `202 + job_id`；提供 get/cancel/artifact_received 短请求 |
| `generation-worker` | POST | Worker Token → claim/heartbeat/submitted/upload/finish/fail/outcome_unknown；VPS 不直连数据库 |
| `understand-proxy` | POST | JWT → 服务端价格/余额校验 → hold → 同步理解（`UNDERSTAND_ASYNC=false`）或 create/get 异步任务（`true`）→ confirm/rollback |
| `understand-worker` | POST | Worker Token → claim/heartbeat/submitted/finish/fail/outcome_unknown；VPS 不直连数据库 |
| `entitlement` | GET | 返回 tier、三类余额与 FeaturePolicy |

统一错误：401 未登录 / 402 积分不足 / 413 体积超限 / 429 限流 / 502 上游失败 / 503 熔断或未配置 / 504 超时。`BOWERBIRD_CLOUD_MOCK=true` 时只用于开发；生产必须关闭，且未配置真实 adapter 时应返回 503，不能静默输出 Mock 结果。

当前新建 Agent 仅接受 `bowerbird-unified-agent` + `dsh`；旧 controlled/legacy 任务保留读取与恢复。远端控制面冒烟使用 `scripts/test-agent-runtime-selection-remote.mjs`（默认 unified，也接受 `--skill=unified`），仍需参数与 env 双闸、队列为空并先停止常驻 Worker，验证完恢复。它只做 create/get/claim/cancel，不运行 processor/provider。真实 HTML E2E 使用 `scripts/test-unified-agent-e2e.mjs`，保留费用双闸及显式输入要求。这两种当前脚本会为自身新建的临时测试账号准备 30 Bcoin、1 小时有效的独立测试额度（不是支付，不依赖注册赠分）；执行后沿原有清理流程删除临时账号。

旧 `test-controlled-agent-e2e.mjs` 与 `test-agent-control-plane.mjs` 已退役，直接运行会在读取凭据前退出；历史 recovery evidence 与 paired 报告仍保留，不能用已停用的新建接口重跑。`test-unified-agent-approval-local.mjs` 是隔离本地控制面的历史兼容夹具，不作为当前生产新建入口。部署闸门与回滚见 [统一 Harness Runbook](../agent-worker/UNIFIED-HARNESS-RUNBOOK.md)。
