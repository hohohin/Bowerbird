# 收费化架构调整 · 任务进度（会话接续用）

> 用途：跨会话交接。任何新会话接手本任务，**先读本文件**，再按需读 `ARCH-ADJUST-PLAN.md`（原始计划）与 `apps/cloud/DEPLOY.md`（部署操作手册）。
> 更新时间：2026-08-10 ・ 当前分支：`dev` ・ 本文件随最近一次 commit 落盘。

---

## 一句话现状

收费化架构（账号 / 积分 / 托管算力 / 订阅支付 / 功能门控，对应计划 P0–P8）已完成代码、本地回归与真实云端部署：Supabase `0001~0009`、5 个 Edge Functions、Cloud Secrets 均已上线；东京节点真实闭环已通过（注册 30 分 → Seedream 出图 → 扣 5 分 → 余额 25 → 临时账号清理）。支付保持 Mock。

---

## 当前状态与下一步

**云端基础闭环无阻塞。** 2026-08-10 已完成：

- Bowerbird Supabase 项目已链接并推送 `0001~0009`；`0008` 修复注册初始化与 RLS，`0009` 修复 `credit_hold` 的 PL/pgSQL record/alias 遮蔽。
- 5 个 Edge Functions 均为 ACTIVE；`payment-webhook` 关闭网关 JWT、函数内自行验支付签名，其余函数保持 JWT 校验。
- Secrets 已上传：真实方舟开启、支付 Mock 保持；方舟上游超时为 140 秒。
- 真实 E2E 从东京 `ap-northeast-1` 执行成功：耗时 76.3 秒，图片 111,058 字节，注册积分 30、实际扣费 5、生成后 25，临时账号自动清理。
- 桌面端与官网正式云函数调用默认固定东京节点；客户端总超时 145 秒，为 Edge 的 140 秒上游超时留响应余量。

下一步只剩产品级手测：桌面 Magic Link 登录、创作板选择 Bowerbird Cloud、积分流水 UI；以及官网登录后的共享余额。真实支付、Seedance、微信登录仍是凭据/决策驱动的后续项。

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
原基线 `cargo test` **96 passed**（含 cloud/entitlement/auth/policy/source-tag 新增，原有用例无回退）；桌面 `tsc --noEmit` + Vite build 过；官网 build 过；扩展 Node tests 7/7。部署后增量验证：云配置测试 3/3、官网与 E2E 脚本 `node --check` 通过、东京真实 Cloud E2E 通过。

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
| DB 迁移 | `apps/cloud/supabase/migrations/0001~0009` |
| Edge Functions | `apps/cloud/supabase/functions/{generate-proxy,understand-proxy,entitlement,create-checkout,payment-webhook}/index.ts` + `_shared/{auth,ark,billing,errors,limits}.ts` |
| DB / 云闭环测试 | `apps/cloud/supabase/tests/billing.sql`、`apps/cloud/scripts/test-{billing,payment,cloud-e2e}.mjs` |
| 桌面云边界 | `apps/desktop/src-tauri/src/cloud/{config,client,auth,entitlement,policy}.rs` |
| 云 Provider | `apps/desktop/src-tauri/src/codex/bowerbird_cloud.rs`、`codex/understand.rs` |
| 云命令 | `apps/desktop/src-tauri/src/commands/cloud.rs` |
| 前端门控 | `apps/desktop/src/lib/entitlement.ts`、`store.ts`、`components/creation/ProviderSelect.tsx` |
| 官网 | `website/server.mjs`、`website/app.js` |

---

## 待办（凭据/决策驱动，非本次范围）

- **产品 UI 真机验收**：桌面登录 → 云出图 → 流水，以及官网/桌面余额一致；API 层真实闭环已通过。
- Seedance 视频 adapter（需真实 video model endpoint id）。
- 微信登录真实联调（H5 凭据，邮箱 Magic Link 已先行）。
- 真实支付渠道决策 + 接入（见 Mock 开关表）。
