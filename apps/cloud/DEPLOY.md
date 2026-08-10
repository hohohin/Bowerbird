# Bowerbird Cloud · 部署指引（凭据已备好）

> 目标：把 `apps/cloud/` 的 Supabase 迁移 + Edge Functions 推上云端，完成 Auth/积分/算力的真实联调。
> 前提：你已在 Supabase 控制台拿到 Project URL / publishable key / secret key，并已在 `apps/cloud/.env` 填好方舟 key 与 endpoint id。

## 需要手工做的事（按顺序）

### 1. 安装 Supabase CLI

任选其一：

- **npm**（推荐，与 pnpm 共存）：
  ```bash
  npm install -g supabase
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
supabase --version
```

### 2. 登录并链接项目

```bash
supabase login
# 会打开浏览器授权，授权后回终端
supabase link --project-ref <你的-project-ref>
```

`<project-ref>` 在 Supabase 项目 Settings → General → Reference ID。

### 3. 推送数据库迁移

```bash
cd apps/cloud
supabase db push
```

会依次执行 `supabase/migrations/0001_*.sql` 到 `0007_deploy_helper.sql`。  
`0007_deploy_helper.sql` 是幂等的，可在已有库上重复执行做 schema 修补。

### 4. 部署 Edge Functions 并注入 Secrets

```bash
# 部署函数
supabase functions deploy generate-proxy
supabase functions deploy understand-proxy
supabase functions deploy entitlement
supabase functions deploy create-checkout
supabase functions deploy payment-webhook

# 注入 secrets（从 .env 读取；只上传一次，函数运行环境持有）
supabase secrets set SUPABASE_URL=$SUPABASE_URL
supabase secrets set SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY
supabase secrets set SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
supabase secrets set ARK_API_KEY=$ARK_API_KEY
supabase secrets set ARK_BASE_URL=$ARK_BASE_URL
supabase secrets set ARK_IMAGE_MODEL=$ARK_IMAGE_MODEL
supabase secrets set ARK_VIDEO_MODEL=$ARK_VIDEO_MODEL
supabase secrets set ARK_VISION_MODEL=$ARK_VISION_MODEL
supabase secrets set ALLOWED_ORIGINS="https://<你的官网域名>"
supabase secrets set DAILY_COST_LIMIT_CNY=500
supabase secrets set UPSTREAM_TIMEOUT_MS=120000
supabase secrets set RATE_LIMIT_PER_USER_PER_MIN=10
supabase secrets set BOWERBIRD_CLOUD_MOCK=false
supabase secrets set BOWERBIRD_PAYMENT_MOCK=true
```

> ⚠️ 目前 `.env` 里 `BOWERBIRD_CLOUD_MOCK=false` 已开启真实方舟；`BOWERBIRD_PAYMENT_MOCK=true` 保持 Mock 支付，**不要**提前改 false。

### 5. 部署 Auth 钩子（注册即发 30 分）

```bash
supabase functions deploy wechat-login    # 后续微信登录时部署，H5 凭据备好再发
```

## 6. 验证

```bash
# 1. RLS/积分测试（需要本地 Node + Supabase CLI）
cd apps/cloud
supabase db reset
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/billing.sql
node scripts/test-billing.mjs
node scripts/test-payment.mjs

# 2. Edge Functions 冒烟（需要本地 Deno + Supabase CLI）
supabase functions serve --env-file .env
# 另一个终端：
curl -H "Authorization: Bearer <测试用户 access token>" \
  "$SUPABASE_URL/functions/v1/entitlement"
```

## 7. 桌面端/官网真机验收

- 桌面端：设置 → Bowerbird Cloud 连接 → 启用云端 + Mock 算力 → 保存连接配置 → 重启 app → 邮箱 Magic Link 登录 → 创作板选「Bowerbird Cloud」出图 → 查看积分扣减与流水。
- 官网：把 `SUPABASE_URL` 与 `SUPABASE_PUBLISHABLE_KEY` 填到 `website/.env.local` 与 Render 环境变量，重启后登录验证共享积分。

## 支付（Mock）

`create-checkout` / `payment-webhook` 目前只提供 **Mock 契约**（验签、幂等、状态机）。**不要**接入真实支付渠道；等 superun/Paddle 凭据到位后再换真实 adapter。

## 注意事项

- 所有 secrets 只在 Edge Functions 运行环境持有；桌面端只持 publishable key。
- `BOWERBIRD_CLOUD_MOCK` 与 `BOWERBIRD_PAYMENT_MOCK` 是两个独立开关：前者控制算力，后者控制支付。
- 部署完成后请告诉我「已部署」，我会继续真机验收（登录 → 积分 → 生成 → 流水 → 扣费/回滚）。
