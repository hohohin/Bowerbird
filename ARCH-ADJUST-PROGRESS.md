# 收费化架构调整 · 任务进度（会话接续用）

> 用途：跨会话交接。任何新会话接手本任务，**先读本文件**，再按需读 `ARCH-ADJUST-PLAN.md`（原始计划）与 `apps/cloud/DEPLOY.md`（部署操作手册）。
> 更新时间：2026-08-10 ・ 当前分支：`dev` ・ 本文件随最近一次 commit 落盘。

---

## 一句话现状

收费化架构（账号 / 积分 / 托管算力 / 订阅支付 / 功能门控，对应计划 P0–P8）**代码已全部完成并通过本地回归**；Supabase 与火山方舟已接入**真实凭据**并做了**真实契约级联调**（出图、视觉理解均成功）。**唯一未完成项 = 把云端 schema 与 Edge Functions 真正部署到 Supabase 项目**（当前数据库表在云端是 404）。支付保持 Mock。

---

## 当前阻塞点（下一步唯一要做的事）

**云端尚未部署**，因此「登录 → 积分 → 云生成 → 扣费/回滚」的真机闭环还跑不起来。

- 已实测：Supabase 项目可达（secret key 打 `/rest/v1/` 返回 200；publishable key 打同端点 401 属预期，因为该端点只认 secret）。
- 已实测：**所有计费表在云端返回 404** —— 即 `0001~0007` 迁移尚未 push 到云端。
- 缺的不是代码，是**本机没有 Supabase CLI**（`npx --yes supabase` 安装曾被权限拦下，需用户授权或用户自装）。

### 解锁步骤（详见 `apps/cloud/DEPLOY.md`，按序执行）

1. 装 Supabase CLI：`npm install -g supabase`（或 `scoop install supabase`）。
2. `supabase login`（浏览器授权）。
3. `supabase link --project-ref wpupyuurwmaeozyvkyuo`（project-ref 见 `apps/cloud/.env` 的 SUPABASE_URL 主机段）。
4. `cd apps/cloud && supabase db push`（执行 `0001`~`0007`；`0007_deploy_helper.sql` 幂等，可重复跑做修补）。
5. `supabase functions deploy generate-proxy understand-proxy entitlement create-checkout payment-webhook`。
6. `supabase secrets set ...`（清单见 DEPLOY.md 第 4 节；**保持 `BOWERBIRD_CLOUD_MOCK=false`、`BOWERBIRD_PAYMENT_MOCK=true`**）。
7. 验证：`supabase db reset` + `psql -f supabase/tests/billing.sql` + `node scripts/test-billing.mjs` + `node scripts/test-payment.mjs`。

> 完成后告诉 Claude「已部署」，接着做真机验收（登录 → 领 30 分 → 云出图扣分 → 流水 → 取消/失败回滚）。

---

## 已完成（不要重做）

### 计划 P0–P8 全量（代码 + 测试）
- **P0 云脚手架**：`apps/cloud/`（Supabase 迁移 + Edge Functions + README/DEPLOY）；桌面 `src-tauri/src/cloud/` 边界（公开配置 + 共享 client，`cloud_enabled` 默认 false）。
- **P1 计费数据层**：`credit_lots`（FIFO daily→sub→topup）/ `credit_holds` + `credit_hold_allocations` / `credit_transactions`(append-only) / `user_credits` 快照 / `usage_daily`；RLS own-row 只读 + 写仅服务端 RPC；注册即发 30 分（与当日免费额度共用 daily lot，首日总计 30，不叠加）。
- **P2 Edge Functions**：`_shared`（JWT、稳定错误码 401/402/413/429/502/503/504、CORS、体积/参考图校验、超时、脱敏日志）；`generate-proxy`（hold→上游→confirm/rollback，异步 pending_settlement+poll）；`understand-proxy`（Free 10 次/日）；`entitlement`（服务端派生 FeaturePolicy + 近 50 条流水）。
- **P3 桌面账号**：`AuthClient`（邮箱 Magic Link、S256 PKCE、callback state 校验、keyring 存 refresh token、Rust 独占 token）、deep-link + single-instance（`bowerbird://auth/callback`）、`EntitlementService`（签名缓存 + 7 天离线宽限 + 时钟回拨检测）、设置账号区 + 统一 Onboarding 账号卡片。
- **P4 Provider**：`BowerbirdCloudProvider`（job_id 幂等、请求期 base64、异步 bounded poll）+ 独立 `UnderstandProvider`（Codex/Cloud）+ `bowerbird-cloud` source 显式映射 + `generation_worker` 恢复接受该 source。
- **P5–P6**：积分流水面板、`FeaturePolicy` 唯一事实源（前端 `entitlement.ts` 镜像，BYO 免费禁用 + 并发闸）。
- **P7 Mock 支付**：`create-checkout`（服务端 SKU 映射）+ `payment-webhook`（常量时间验签、paid/refunded 幂等状态机、topup lot）+ 契约测试脚本。**两个函数都加了 Mock 守卫（`BOWERBIRD_PAYMENT_MOCK != "true"` 时 503），防误开真实扣款**。
- **P8 官网账号化**：`website/server.mjs` `/api/generate` Bearer JWT 转发 generate-proxy、`website/app.js` CDN supabase-js 邮箱 Magic Link 登录 + 余额/402/429 处理，未登录保留旧每 IP demo 兜底。

### 本会话新增（真实凭据接入）
- **Supabase 新 key 体系迁移**：`publishable`/`secret` 取代旧 `anon`/`service_role`。`_shared/auth.ts` 的 `namedKey()` 支持 `SUPABASE_PUBLISHABLE_KEYS`/`SUPABASE_SECRET_KEYS` JSON、直连 `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY`、并回退旧名。桌面 `cloud_supabase_publishable_key` 带 `#[serde(alias="cloud_supabase_anon_key")]` 向后兼容。
- **桌面自动读云配置**：`read_public_supabase_config()`（`cloud/config.rs`）启动时从 `apps/cloud/.env(.local)` 读 `SUPABASE_URL` + publishable key 注入设置快照（env 为本地权威源，settings.json 只存开关），免手动粘贴。
- **火山方舟真实 adapter**：`_shared/ark.ts` 的 `VolcArkAdapter`——`POST /images/generations`（Seedream，b64_json/URL 带回，**不支持 `sequential_image_generation`，已移除该参数**）+ `POST /chat/completions`（Vision 多模态，image_url data URI）。`createArkAdapter()`：`BOWERBIRD_CLOUD_MOCK=true`→Mock，否则→真实方舟。
- **真实契约级联调已通过**（用合成 32×32 PNG，非仓库素材）：
  - 方舟 Vision：`VISION_OK`（真实返回文本）。
  - 方舟 Seedream 出图：`IMAGE_OK`（返回 98 KB 图片字节）。
  - Seedance 视频：**未配置**（`ARK_VIDEO_MODEL` 是 placeholder，adapter 返回 not_configured，视频留待真实 model id）。

### 测试基线（全绿）
`cargo test` **96 passed**（含 cloud/entitlement/auth/policy/source-tag 新增，原有用例无回退）；桌面 `tsc --noEmit` + Vite build 过；官网 build 过；扩展 Node tests 7/7；`apps/cloud` 脚本 `node --check` 过。Supabase CLI/Deno 本机未装，故 `supabase db reset` 与 Function 运行测试标「待工具」。

---

## 关键边界（不可违反）

1. **素材 / 提示词 / 库数据永不上云**，不形成云端资产库。云只承载：账号、积分、官方 API 托管算力。
2. 仅当用户**明确选择**云生成/云理解（含设置里显式开启 `cloud_auto_understand`）时，所选图片才在**请求期临时**发给官方模型 API；云端不持久化图/提示词，日志只记 request id/user hash/service/状态。
3. **门控单一事实源**：前端只镜像服务端派生的 `FeaturePolicy`，不散落 tier 字符串比较；服务端独立复核订阅/额度/限流。
4. **积分三段式**：`credit_hold`（幂等 + FIFO + 行锁）→ 上游 → `credit_confirm`/`credit_rollback`；异步先 `pending_settlement`，**前端取消不盲退**。
5. **密钥分级**：桌面端只持 publishable key + URL，refresh token 进 OS keychain；secret/方舟/支付密钥只在 Edge Functions。
6. **BYO 双轨保留**：codex / dreamina 本地 CLI provider 不受云影响，免费档禁用 BYO、Pro/Studio 解锁。

---

## Mock 开关当前状态

| 开关 | 值 | 含义 |
|---|---|---|
| `BOWERBIRD_CLOUD_MOCK` | `false` | 算力走**真实方舟**（已验证） |
| `BOWERBIRD_PAYMENT_MOCK` | `true` | 支付走 **Mock**（保持，待真实支付渠道决策） |

> 支付真实化前需先定渠道：superun 未能证实存在（搜到的是无关产品）；候选 虎皮椒 / PayJS / 支付宝当面付 / 微信支付商户号；Paddle 延后。**不要在未决策前把 `BOWERBIRD_PAYMENT_MOCK` 改 false**（已加守卫，改 false 会 503 而非误扣款）。

---

## 安全红线（务必遵守）

- **绝不把任何 key 贴进聊天 / 写进仓库 / 写进日志**。`apps/cloud/.env`、`*.env.local` 已 gitignore，保持本地。
- **不自动 commit**——只有用户说「存档」或明确要求 commit 时才提交。
- 用户未提交的文件（`AGENTS.md`、`ARCH-ADJUST-PLAN.md`、`apps/cloud/` 等）必须保留：**不 stash / reset / clean / 覆盖**。
- 不经用户授权不用 `npx` 下载外部工具；不上传仓库素材到外部 API（联调用程序合成的测试图）。
- 用户对 migrations / tests 的手工改动要尊重，不回退。

---

## 关键文件速查

| 类别 | 文件 |
|---|---|
| 原始计划 | `ARCH-ADJUST-PLAN.md` |
| 部署手册 | `apps/cloud/DEPLOY.md` |
| 云端说明 | `apps/cloud/README.md` |
| DB 迁移 | `apps/cloud/supabase/migrations/0001~0007` |
| Edge Functions | `apps/cloud/supabase/functions/{generate-proxy,understand-proxy,entitlement,create-checkout,payment-webhook}/index.ts` + `_shared/{auth,ark,billing,errors,limits}.ts` |
| DB 测试 | `apps/cloud/supabase/tests/billing.sql`、`apps/cloud/scripts/test-{billing,payment}.mjs` |
| 桌面云边界 | `apps/desktop/src-tauri/src/cloud/{config,client,auth,entitlement,policy}.rs` |
| 云 Provider | `apps/desktop/src-tauri/src/codex/bowerbird_cloud.rs`、`codex/understand.rs` |
| 云命令 | `apps/desktop/src-tauri/src/commands/cloud.rs` |
| 前端门控 | `apps/desktop/src/lib/entitlement.ts`、`store.ts`、`components/creation/ProviderSelect.tsx` |
| 官网 | `website/server.mjs`、`website/app.js` |

---

## 待办（凭据/决策驱动，非本次范围）

- **云端部署**（见上文「当前阻塞点」）——唯一阻塞真机闭环的项。
- 部署后**真机验收**：登录 → 首日 30 分 → 云出图扣分 → 流水 → 取消/失败回滚 → 余额官网/桌面一致。
- Seedance 视频 adapter（需真实 video model endpoint id）。
- 微信登录真实联调（H5 凭据，邮箱 Magic Link 已先行）。
- 真实支付渠道决策 + 接入（见 Mock 开关表）。
