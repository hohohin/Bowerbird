# Bowerbird Cloud · 部署指引（凭据已备好）

> 目标：把 `apps/cloud/` 的 Supabase 迁移 + Edge Functions 推上云端，完成 Auth/积分/算力的真实联调。
> 前提：你已在 Supabase 控制台拿到 Project URL / publishable key / secret key，并已在 `apps/cloud/.env` 填好方舟 key 与 endpoint id。

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

会依次执行 `supabase/migrations/0001_*.sql` 到 `0011_ensure_daily_credits.sql`。`0010` 必须先于新版 `generate-proxy` / `understand-proxy` 部署，否则 Function 找不到用量守卫 RPC；`0011` 必须先于新版 `entitlement` / `generate-proxy` / `understand-proxy` 部署，否则 Function 找不到当日积分补发 RPC。

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
supabase secrets set COST_CNY_PER_CREDIT=0.047
supabase secrets set UPSTREAM_TIMEOUT_MS=140000
supabase secrets set RATE_LIMIT_PER_USER_PER_MIN=10
supabase secrets set BOWERBIRD_CLOUD_MOCK=false
supabase secrets set BOWERBIRD_PAYMENT_MOCK=true
supabase secrets set SUPERUN_WEBHOOK_SECRET=$SUPERUN_WEBHOOK_SECRET
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
```

## 7. 桌面端/官网真机验收

- 桌面端：构建前通过构建环境或 gitignored `apps/cloud/.env(.local)` 提供 `SUPABASE_URL` + publishable key；官方构建会将二者内置，用户设置不能修改。启动 app → 确认设置中 Bowerbird Cloud 显示“官方服务已配置” → 邮箱 Magic Link 登录 → 创作板选「Bowerbird Cloud」出图 → 查看积分扣减与流水。正式调用默认路由到东京 `ap-northeast-1`。
- 官网：把 `SUPABASE_URL` 与 `SUPABASE_PUBLISHABLE_KEY` 填到 `website/.env.local` 与 Render 环境变量，重启后登录验证共享积分。

## 支付（Mock）

`create-checkout` / `payment-webhook` 目前只提供 **Mock 契约**（验签、幂等、状态机）。**不要**接入真实支付渠道；等 superun/Paddle 凭据到位后再换真实 adapter。

## 注意事项

- 所有 secrets 只在 Edge Functions 运行环境持有；桌面端只持构建期内置的 URL/publishable key，用户不能编辑。
- `DAILY_COST_LIMIT_CNY` 是上海自然日的全站预估成本上限；单次预估成本 = 预扣积分 × `COST_CNY_PER_CREDIT`（默认 ¥0.047）。`RATE_LIMIT_PER_USER_PER_MIN` 是同账号每分钟首次上游请求数；同一幂等键重放不重复占用额度，也不会重复提交上游。
- `BOWERBIRD_CLOUD_MOCK` 与 `BOWERBIRD_PAYMENT_MOCK` 是两个独立开关：前者控制算力，后者控制支付。
- 部署完成后请告诉我「已部署」，我会继续真机验收（登录 → 积分 → 生成 → 流水 → 扣费/回滚）。
