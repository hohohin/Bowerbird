# Bowerbird Cloud

Bowerbird Cloud 承载账号、积分和官方 API 托管算力。素材库、提示词库、`library.db`、原图与缩略图不做云同步，也不会形成云端资产库。

用户只有在明确选择 **Bowerbird Cloud** 生成或理解时，所选参考图与提示词才会发送给官方模型 API。理解请求仍仅在单次 Edge 请求内处理；图片生成会把本次请求加密传输后暂存在私有 `generation-temp` Storage（默认 24 小时 TTL），供受限 VPS Worker 领取，数据库只存对象 key、哈希与状态，不存提示词或图片字节。日志不得记录内容，桌面确认下载后记录接收状态并由清理任务删除临时对象。

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
- service-role 与支付密钥只存在于 Edge Functions secrets；VPS 只持专用 Worker Token 与方舟生图 Key，绝不持 service-role。
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

当前开发机器可通过 `npx` 使用 Supabase CLI，但没有 Docker/Podman，因此上述事务型 `billing.sql` 仍不能本地执行；Rust、桌面、官网和扩展基线已通过。具备 Docker/Postgres 后必须补跑 `supabase db reset`，不能用 SQL 静态检查替代真实迁移结果。

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
| `understand-proxy` | POST | JWT → Free 日限额 → hold → 幂等认领/限流/成本熔断 → 理解 → confirm/rollback |
| `entitlement` | GET | 返回 tier、三类余额与 FeaturePolicy |

统一错误：401 未登录 / 402 积分不足 / 413 体积超限 / 429 限流 / 502 上游失败 / 503 熔断或未配置 / 504 超时。`BOWERBIRD_CLOUD_MOCK=true` 时只用于开发；生产必须关闭，且未配置真实 adapter 时应返回 503，不能静默输出 Mock 结果。

当前开发机器可通过 `npx` 使用 Supabase CLI 与 Deno，但没有 Docker/Podman，因此不能本地执行 `supabase db reset`。`0001~0010`、5 个 Functions 与东京真实 Cloud E2E 已在线验证；5 个 Functions 通过 Deno type-check，远端数据库 error 级 lint 0 项。真实 E2E 还覆盖了 `0010` 的成本预留、幂等重放、单用户分钟限流、全站每日成本熔断与测试 hold 回滚。事务型 `billing.sql` 全量脚本仍需在具备本地 Docker/Postgres 的环境补跑，不能把 REST/RPC 覆盖等同于整份脚本已执行。
