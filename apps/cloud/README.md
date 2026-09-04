# Bowerbird Cloud

Bowerbird Cloud 承载账号、积分和官方 API 托管算力。素材库、提示词库、`library.db`、原图与缩略图不做云同步，也不会形成云端资产库。

用户只有在明确选择 **Bowerbird Cloud** 生成或理解时，所选参考图与提示词才会发送给官方模型 API。图片生成与理解（`UNDERSTAND_ASYNC=true` 后）都会把本次请求加密传输后暂存在私有 `generation-temp` Storage（默认 24 小时 TTL），供受限 VPS Worker 领取并在 Edge 墙钟之外等待方舟，数据库只存对象 key、哈希、状态与理解结果文本（内容过期后清空），不存提示词或图片字节。日志不得记录内容，桌面确认下载后记录接收状态并由清理任务删除临时对象。`UNDERSTAND_ASYNC=false` 时理解仍走旧的单次 Edge 同步请求（110s 上游截断），作为异步链路上线前的回退。

## 当前阶段

Supabase、火山方舟与桌面/官网真实 Cloud 闭环已上线并验收；算力 `BOWERBIRD_CLOUD_MOCK=false`。支付因备案/商户资质暂停，保持 `BOWERBIRD_PAYMENT_MOCK=true`。`.env.local` 永不提交；变量全集见 [.env.example](.env.example)。

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

P1 数据层：

```bash
cd apps/cloud
supabase db reset
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/billing.sql
node scripts/test-billing.mjs
```

`billing.sql` 覆盖注册首日 30 分、daily grant 幂等、FIFO、hold/confirm/rollback、余额不足、append-only 流水和客户端权限；Node 脚本让 20 个并发请求竞争同一幂等键，必须只产生一个 hold。

当前开发机器已可使用 Docker Desktop/WSL2 与 Supabase CLI。2026-09-01 已从空库执行 migration `0001`–`0050`，并以容器内 `psql -v ON_ERROR_STOP=1` 跑通 `supabase/tests/agent_runtime.sql` 39/39；事务型 SQL 仍必须真实执行，不能用静态检查替代。

P2 Edge Functions（Supabase CLI/Deno 可用后）：

```bash
cd apps/cloud
supabase functions serve --env-file .env.local
# 用真实测试用户 access token，不要用 service-role token 模拟用户
curl -H "Authorization: Bearer $TEST_ACCESS_TOKEN" \
  "$SUPABASE_URL/functions/v1/entitlement"
```

支付 Mock 契约（P7）：

```bash
node scripts/test-payment.mjs
```

覆盖：错误签名拒绝、paid 重放幂等、paid→refunded 确定状态。真实 superun/Paddle 联调必须在商户凭据与官方 webhook 文档到位后单独进行。

已定义的契约：

| Function | Method | 用途 |
|---|---|---|
| `generate-proxy` | POST | JWT → hold → 私有输入暂存 → `202 + job_id`；提供 get/cancel/artifact_received 短请求 |
| `generation-worker` | POST | Worker Token → claim/heartbeat/submitted/upload/finish/fail/outcome_unknown；VPS 不直连数据库 |
| `understand-proxy` | POST | JWT → Free 日限额 → hold → 同步理解（`UNDERSTAND_ASYNC=false`）或 create/get 异步任务（`true`）→ confirm/rollback |
| `understand-worker` | POST | Worker Token → claim/heartbeat/submitted/finish/fail/outcome_unknown；VPS 不直连数据库 |
| `entitlement` | GET | 返回 tier、三类余额与 FeaturePolicy |

统一错误：401 未登录 / 402 积分不足 / 413 体积超限 / 429 限流 / 502 上游失败 / 503 熔断或未配置 / 504 超时。`BOWERBIRD_CLOUD_MOCK=true` 时只用于开发；生产必须关闭，且未配置真实 adapter 时应返回 503，不能静默输出 Mock 结果。

本机 Docker/Supabase/Deno 验证现已可用。通用 Agent Harness 本地专用脚本 `scripts/test-unified-agent-approval-local.mjs` 会拒绝非 localhost URL，并覆盖真实 Edge create/upload/enqueue、claim/checkpoint、图片 artifact 服务端尺寸提取、计划停车、无租约重放、漂移拒绝、用户批准与 fresh claim 尺寸回传；U4 另覆盖 test-only `dsh` create/get/claim、同幂等键 runtime 漂移拒绝和历史默认 legacy。运行时只使用本地测试账号、本地 Worker Token 与 Mock Seedream，不调用模型或真实 provider。远端 test-only 部署后，`scripts/test-agent-runtime-selection-remote.mjs` 以参数 + env 双闸运行；必须先确认队列为空并停止常驻 Worker，再验证普通账号 403、测试账号 DSH create/get/claim、幂等漂移 409 和直接 cancel，保证 processor/provider 调用数为 0，最后恢复 Worker。2026-09-01 远端 `0047`–`0050`、agent-run v42、agent-worker v46 与 VPS controlled DSH processor 已按该流程上线并通过。真实图片继续走 `test-controlled-agent-e2e.mjs` 的参数 + env 费用双闸；`--expect-reclaim` 只采集批准后的执行 lease，并要求外部编排真实 kill/restart。legacy/DSH 同 case 已各自通过两个执行 lease、唯一 Ark side effect/final artifact 和实际积分对账；raw recovery JSON 与 paired Markdown 保存在 gitignored `apps/cloud/artifacts/`。
