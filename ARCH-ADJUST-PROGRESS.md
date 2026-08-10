# 收费化架构调整 · 任务进度（会话接续用）

> 用途：跨会话交接。任何新会话接手本任务，**先读本文件**，再按需读 `ARCH-ADJUST-PLAN.md`（原始计划）与 `apps/cloud/DEPLOY.md`（部署操作手册）。
> 更新时间：2026-08-10 ・ 当前分支：`dev` ・ 本文件随最近一次 commit 落盘。

---

## 一句话现状

收费化架构（账号 / 积分 / 托管算力 / 订阅支付 / 功能门控，对应计划 P0–P8）已完成代码、P9-T2 全量回归、P9-T3 安全审计与真实云端部署：Supabase `0001~0010`、5 个 Edge Functions、Cloud Secrets 均已上线；桌面与官网同账号登录/共享余额、东京 Seedream 出图、本地入库、来源标记、扣费流水、幂等认领、限流与成本熔断均已验收。支付保持 Mock。

---

## 当前状态与下一步

**云端基础闭环无阻塞。** 2026-08-10 已完成：

- Bowerbird Supabase 项目已链接并推送 `0001~0010`；`0008` 修复注册初始化与 RLS，`0009` 修复 `credit_hold` 的 PL/pgSQL record/alias 遮蔽，`0010` 落地原子用量守卫。
- 5 个 Edge Functions 均为 ACTIVE；`payment-webhook` 关闭网关 JWT、函数内自行验支付签名，其余函数保持 JWT 校验。
- Secrets 已上传：真实方舟开启、支付 Mock 保持；方舟上游超时为 140 秒。
- 真实 E2E 从东京 `ap-northeast-1` 执行成功：耗时 76.3 秒，图片 111,058 字节，注册积分 30、实际扣费 5、生成后 25，临时账号自动清理。
- 桌面端与官网正式云函数调用默认固定东京节点；客户端总超时 145 秒，为 Edge 的 140 秒上游超时留响应余量。
- 免费档产品真机验收通过：桌面 Magic Link 登录 → 创作板 Bowerbird Cloud 出图 → 图片进入本地素材库且来源正确 → 余额扣 5 分与流水正确 → 官网同账号余额共享。

P9-T2 已完成：`cargo test` 98/98、桌面 TypeScript/Vite、官网 build、扩展 Node 10/10 均通过。P9-T3 已完成：12 张云表均启用并强制 RLS，仓库密钥特征 0 命中，Function 日志只走脱敏 `safeLog`，5 个 Function Deno type-check 全过；`0010_managed_usage_guard.sql` 已推送，`COST_CNY_PER_CREDIT=0.047` 已上传，`generate-proxy` / `understand-proxy` / `payment-webhook` 已部署为 ACTIVE v4。东京真实 E2E 再验收通过：76.6 秒、图片 106,982 字节、30→25 分、预留成本 235,000 微元；同幂等键重放、单用户分钟限流、全站日成本熔断均正确拒绝并完成测试 hold 回滚。远端数据库 error 级 lint 0 项；webhook 伪造签名返回 401。P9-T1 中购买 Pro、800 分到账及订阅门控仍依赖真实支付渠道决策；Seedance 与微信登录也是凭据驱动的后续项。

P9-T4 文档收尾与版本日期化已完成：AGENTS/CLAUDE 索引已补齐，桌面版本由 `26.8.8` 更新为 `26.8.10`，本轮随用户“存档”指令提交。

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
当前基线 `cargo test` **98 passed**；桌面 `tsc --noEmit` + Vite build、官网 build、扩展 Node tests 10/10 均通过。部署后增量验证：云配置测试 3/3、Auth 测试 3/3、官网/E2E/支付脚本 `node --check`、5 个 Edge Functions Deno type-check、桌面/官网免费档产品真机闭环均通过；`0010` 已在远端应用，迁移版本 0001–0010 本地/远端一致，数据库 error 级 lint 0 项，真实 Cloud E2E + 用量守卫断言全过。因本机无 Docker/Podman，事务型 `billing.sql` 全量脚本仍不能本地执行；本轮已通过远端 REST/RPC 覆盖 `0010` 的核心断言。

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
| DB 迁移 | `apps/cloud/supabase/migrations/0001~0010` |
| Edge Functions | `apps/cloud/supabase/functions/{generate-proxy,understand-proxy,entitlement,create-checkout,payment-webhook}/index.ts` + `_shared/{auth,ark,billing,errors,limits,usage}.ts` |
| DB / 云闭环测试 | `apps/cloud/supabase/tests/billing.sql`、`apps/cloud/scripts/test-{billing,payment,payment-webhook-smoke,cloud-e2e}.mjs` |
| 桌面云边界 | `apps/desktop/src-tauri/src/cloud/{config,client,auth,entitlement,policy}.rs` |
| 云 Provider | `apps/desktop/src-tauri/src/codex/bowerbird_cloud.rs`、`codex/understand.rs` |
| 云命令 | `apps/desktop/src-tauri/src/commands/cloud.rs` |
| 前端门控 | `apps/desktop/src/lib/entitlement.ts`、`store.ts`、`components/creation/ProviderSelect.tsx` |
| 官网 | `website/server.mjs`、`website/app.js` |

---

## 待办（凭据/决策驱动，非本次范围）

- Seedance 视频 adapter（需真实 video model endpoint id）。
- 微信登录真实联调（H5 凭据，邮箱 Magic Link 已先行）。
- 真实支付渠道决策 + 接入（见 Mock 开关表）。
