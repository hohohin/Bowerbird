# Bowerbird 架构调整开发计划（收费化改造）

> **版本**：v1 · 2026-08-08
> **依据**：[FRAMEWORK_ADJUST.md](FRAMEWORK_ADJUST.md)（7 项调整清单）+ [Bowerbird定价方案v2-订阅积分制.md](Bowerbird定价方案v2-订阅积分制.md)（档位/积分/消耗表）+ [研究报告-服务器化CLI与API化改造可行性.md](研究报告-服务器化CLI与API化改造可行性.md)（HTTP provider 改造面）+ 当前 commit `b1ae01e` 项目现状
> **执行方式**：以 agent 开发为主。本计划不含时间预估，只定义阶段、任务、依赖与验收标准。
> **读者**：执行开发的 agent 每次开工前先读本计划对应 Phase 的「任务卡」+ 其标注的关联文档。

---

## 0. 总目标与不变量

**目标**：在不破坏现有 Local-First 素材库的前提下，为 Bowerbird 增加「账号 + 积分 + 托管算力 + 订阅支付 + 功能门控」五项收费化能力，落地定价方案 v2（免费 / Pro ¥59 / Studio ¥149 + 积分包）。

**架构不变量（任何任务不得违反）**：

1. **Local-First 完全保留**：素材、提示词、库数据（library.db、images/、thumbnails/）100% 留在本地，永不上云。
2. **云只承载三件事**：账号（Auth）、积分（余额/流水）、托管算力（生成/反推代理）。
3. **BYO 通道不动**：codex CLI / dreamina CLI 两个本地 provider 原样保留，现有 onboarding（一键安装/OAuth）原样复用；BYO 用户断网可用（除首次订阅校验与 7 天宽限到期后）。
4. **桌面端改动集中在抽象层**：`GenProvider` trait、命令层、store 已按 provider 分发——新增能力走「加实现」而非「改主干」，上游（task_queue / generation_worker / GenerationPanel）零改动或最小改动。
5. **合规红线**（研究报告 §5.3）：不把订阅/积分账号搬到服务器代理多用户；不转售 API key；托管算力只走官方 API（火山方舟 Seedream/Seedance/豆包 vision）；面向公众提供生成式服务前单独评估算法备案。

**现状关键资产（复用点）**：

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `GenProvider` trait + `resolve_gen_provider` 工厂 | [codex/mod.rs](apps/desktop/src-tauri/src/codex/mod.rs) | 加第三个 provider「bowerbird-cloud」分支 |
| `openai_api.rs` reqwest b64_json 范式 | [codex/openai_api.rs](apps/desktop/src-tauri/src/codex/openai_api.rs) | HTTP provider 直接照抄骨架 |
| GenJob 持久化 + submit_id + 启动恢复 + 轮询 | [task_queue.rs](apps/desktop/src-tauri/src/core/task_queue.rs) / [generation_worker.rs](apps/desktop/src-tauri/src/core/generation_worker.rs) | 方舟异步任务制同构，零改动复用 |
| 官网服务端代理 + Key 只在服务端 + 限流 | [website/server.mjs](website/server.mjs) `/api/generate` | 云端生成代理的已验证蓝本 |
| 多 job 并行 UI / provider 切换 UI | [GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) / [ProviderSelect.tsx](apps/desktop/src/components/creation/ProviderSelect.tsx) | 加选项即可，交互零新发明 |
| 全屏 Modal / inline 面板范式 | 关键约定 13/15 | 账号、支付、门控 UI 一律复用既有范式，不发明浮层 |

---

## 1. 目标架构总览

```
┌─────────────────────────── 桌面端（Tauri，本地）───────────────────────────┐
│ 素材库 library.db / images / thumbnails          ← 100% 本地，永不上云      │
│ 创作板 → store.startGeneration(provider)                                    │
│   ├─ provider=codex / jimeng  → 本地 CLI（BYO，Pro+ 不扣积分）              │
│   └─ provider=bowerbird-cloud → HTTPS → 云代理（扣积分）                    │
│ 反推/命名/归类 → UnderstandProvider（codex CLI 或 云端豆包 vision）         │
│ AuthClient：Supabase Auth 登录 → entitlement 本地缓存（JWT，7 天宽限）      │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ HTTPS（Bearer = Supabase access token）
┌──────────────────────────────────┴────────────────────────────────────────┐
│ 云（Supabase + Edge Functions）                                           │
│  Auth：邮箱魔法链接（一期）/ 微信扫码自定义 JWT（二期）                     │
│  PG：user_credits / credit_transactions / subscriptions / orders（RLS）   │
│  RPC：credit_hold / credit_confirm / credit_rollback（幂等 + FIFO）       │
│  Functions：generate-proxy（方舟 Seedream/Seedance）                      │
│             understand-proxy（豆包 vision）                               │
│             payment-webhook（superun / Paddle）                           │
│  密钥：方舟 API Key、支付商户密钥只在 Functions 环境变量                  │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 人工前置清单（agent 无法代办，开工前由用户完成）

| # | 事项 | 产出物 | 阻塞的 Phase |
|---|---|---|---|
| H1 | 注册 Supabase 项目（免费档），拿到 Project URL / anon key / service_role key | 三枚 key | P1 起全部 |
| H2 | 火山方舟开通并创建 API Key，确认 Seedream / Seedance / 豆包 vision 模型接入点（endpoint id） | API Key + endpoint ids | P2 |
| H3 | superun 商户注册（个人可办），拿到商户号 + webhook 密钥 | 商户配置 | P6 |
| H4 | Paddle 商户注册（海外，可与 H3 并行，一期可只做国内） | 商户配置 | P6 |
| H5 | 微信开放平台「网站应用」注册（**企业资质已确认，2026-08-08**；按网站应用流程提交审核） | AppID/Secret | P3 |
| H6 | 决定域名与云端部署形态：Supabase Edge Functions（推荐，免运维） | 决策 | P2 |

> **agent 注意**：H1–H5 的 key 到手前，所有云端任务先用 `.env.local` 占位 + Mock 模式开发（见各任务卡「验收」），不得硬编码任何 key 进仓库。**需要填写的环境变量全集以 [apps/cloud/.env.example](apps/cloud/.env.example) 为准**（已按 H1–H5 分组，含积分/熔断配置项）。

---

## 3. 数据模型（Supabase PG，Phase P1 落地）

最小实现，全部带 RLS（用户只能读自己的行；写只经 service role 的 RPC/Function）：

```sql
-- 积分余额（单行 per user）
create table user_credits (
  user_id uuid primary key references auth.users,
  daily_balance int not null default 0,      -- 每日赠送分，当日清零
  sub_balance  int not null default 0,       -- 订阅分，30 天有效
  topup_balance int not null default 0,      -- 充值分，2 年有效
  sub_expire_at timestamptz,                 -- 订阅分到期
  updated_at timestamptz not null default now()
);

-- 积分流水（含预授权）
create table credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  idempotency_key text unique,               -- 幂等键：客户端生成 UUID
  kind text not null,        -- hold/confirm/rollback/grant_daily/grant_sub/topup/purchase/refund
  bucket text,               -- daily/sub/topup（FIFO 扣减顺序 daily→sub→topup）
  amount int not null,       -- hold 为负预留、confirm 核销、grant 为正
  service text,              -- caption / image_sd / image_hd / video_sd2_5s ...（消耗表 key）
  status text not null default 'done',       -- held/done/rolled_back
  meta jsonb,
  created_at timestamptz not null default now()
);

-- 订阅态
create table subscriptions (
  user_id uuid primary key references auth.users,
  tier text not null default 'free',         -- free/pro/studio
  period text,                               -- monthly/yearly
  status text not null default 'active',     -- active/canceled/expired
  current_period_end timestamptz,
  provider text,                             -- superun/paddle
  updated_at timestamptz not null default now()
);

-- 支付订单（webhook 对账 + 积分包发放凭据）
create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  provider text not null, provider_order_id text unique,
  product text not null,                     -- pro_monthly/pro_yearly/studio_monthly/studio_yearly/credits_100/...
  amount_cny int, status text not null default 'pending',  -- pending/paid/refunded
  created_at timestamptz not null default now()
);
```

**RPC（PL/pgSQL，事务内执行）**：
- `credit_hold(user, idem_key, service, est_amount)` → 校验余额（按 FIFO 顺序预扣）→ 写 `held` 流水 → 返回 hold_id；余额不足返回 402 语义。
- `credit_confirm(hold_id, actual_amount)` → 按实际消耗核销（多退少补）→ `done`。
- `credit_rollback(hold_id)` → 全额返还 → `rolled_back`。**生成失败/审核不过必须走这条**。
- `grant_daily_credits()` / `grant_sub_credits()` → 由 pg_cron / 外部 cron 每日、每月触发。
- 三个 RPC 全部以 `idempotency_key` / `hold_id` 唯一约束兜底，重复调用安全返回原结果。

---

## 4. 阶段计划

### P0 · 决策冻结与工程脚手架

**目标**：把开放问题全部变成决策记录；建好 `apps/cloud` 脚手架，后续 Phase 只往里填实现。

| 任务 | 内容 | 验收 |
|---|---|---|
| P0-T1 | 决策记录写入本计划 §10：Edge Functions vs 自建 Node 服务（默认 Edge Functions）；高清导出门控的具体功能形态（现有导出无高清概念，标记为「随视频/超清增强功能落地时再挂门控」） | §10 无「待定」 |
| P0-T2 | 新建 `apps/cloud/`（Supabase 目录结构：`supabase/migrations/`、`supabase/functions/`），纳入 pnpm workspace 但**不进桌面端构建**；写 README 说明本地开发流程（supabase CLI 本地起栈 / 或直连云端 dev project） | `supabase db push` 空迁移成功（或本地栈启动成功） |
| P0-T3 | 桌面端新建 `apps/desktop/src-tauri/src/cloud/` 模块空骨架（mod.rs + client.rs 占位），建 feature flag：设置项 `cloud_enabled`（默认 false），全部云能力在其后展开，未开启时行为与现状**字节级一致** | `cargo test` 86 全绿不回退；`tsc --noEmit` 过 |

### P1 · 云端数据层（账号 + 积分）

**目标**：§3 的数据模型与 RPC 全部落地并可被调用。纯 SQL/后端任务，不依赖任何前端。

| 任务 | 内容 | 验收 |
|---|---|---|
| P1-T1 | 4 张表 migration + RLS 策略（select: auth.uid()=user_id；insert/update 仅 service role） | 用 anon key 直插被拒；service key 可写 |
| P1-T2 | `credit_hold/confirm/rollback` 三个 RPC + 幂等单测（同 idem_key 二次调用不双扣；rollback 后 confirm 报错） | SQL 测试脚本全过（pgTAP 或 node 脚本调 RPC 断言） |
| P1-T3 | `grant_daily_credits`（每日 30 分、当日清零重置）+ `grant_sub_credits`（按订阅档 800/3000、30 天有效、年付可结转 1 个月规则）+ cron 接入 | 手动触发后余额/流水正确 |
| P1-T4 | 消耗表配置化：`service_costs` 表或 Functions 环境变量 JSON（key=service，value=分），与定价方案 §3.2 对齐；预估价函数 `estimate_cost(service, params)` | 改配置不改代码即可调价 |
| P1-T5 | Supabase Auth 开通邮箱魔法链接；写「注册即建行」触发器（auth.users 新行 → user_credits/subscriptions 初始行） | 新用户注册后自动有余额行 |

### P2 · 云端 API 层（托管算力代理）

**目标**：三个 Edge Function 上线，桌面端/官网可用 token 调用；方舟 key 永不出服务端。

| 任务 | 内容 | 验收 |
|---|---|---|
| P2-T1 | `generate-proxy`：验 Supabase JWT → `estimate_cost` → `credit_hold` → 调方舟 Seedream（图，参考图 ≤10 张 base64）/ Seedance（视频，异步 task_id）→ 成功 `credit_confirm`、失败/审核不过 `credit_rollback` → 返回 b64/task_id。代码骨架移植自 [website/server.mjs](website/server.mjs) `/api/generate`（已验证：请求上限、超时、白名单思路） | curl 带测试 token 出图；失败时流水为 rolled_back；余额不足返回明确错误码 |
| P2-T2 | `understand-proxy`：同骨架调豆包 vision（反推/命名/归类三 prompt 模板与桌面端 autoname/caption 现有提示词对齐）；免费用户每日 10 次限额在此计 | 反推结构化输出与桌面端 `caption::parse` 兼容（sections 格式一致） |
| P2-T3 | 请求/响应契约文档写入 `apps/cloud/README.md`（字段、错误码：401 未登录 / 402 余额不足 / 429 限流 / 502 上游失败） | 契约表可直接对照实现 |
| P2-T4 | 安全：全站每日成本熔断（环境变量日上限，参考官网全站 100 次/日思路）、单请求体上限、超时、上游错误不泄露 key | 超熔断返回 503；日志无明文 key |

### P3 · 桌面端账号系统

**目标**：app 内完成登录/登出，订阅态与余额本地缓存，离线宽限 7 天。

| 任务 | 内容 | 验收 |
|---|---|---|
| P3-T1 | `cloud/auth.rs`：Supabase Auth 邮箱魔法链接登录（app 内输入邮箱 → 系统浏览器开验证页 → 深链/粘贴 code 回 app 换 session；Tauri deep-link 需注册 `bowerbird://` scheme）；token 存 OS keychain（keyring crate）不落明文 | 登录/刷新/登出全链路手测通过；重启免登 |
| P3-T2 | `cloud/entitlement.rs`：启动 + 每 6 小时 + 生成前同步 `subscriptions` + `user_credits` → 本地缓存（带服务端签名的到期时间）；**离线宽限**：缓存 7 天内离线可用，超期降级为免费档 | 断网 7 天内 BYO 可用；改系统时间无法绕过（以服务端签发时间为准） |
| P3-T3 | UI：Onboarding 一级总览加第四卡片「账号」（关键约定 15 范式）；SettingsDialog 加账号区（邮箱、档位徽章、积分余额三分层展示、刷新、登出）；未登录时云相关入口置灰 + reason（约定 7 精神） | 截图级走查；未登录 app 全功能（本地部分）不受影响 |
| P3-T4 | 微信扫码登录（**一期**，企业资质已确认）：`wechat-login` Function 走开放平台网站应用 OAuth（扫码 → code 换 openid → service role 铸自定义 Supabase JWT → 自动建行）；与邮箱账号共存，同微信 unionid 后续可绑定合并 | 扫码登录成功入库，积分/订阅态与邮箱账号同构 |

### P4 · 托管 provider「Bowerbird Cloud」（桌面端）

**目标**：创作板 provider 切换条出现第三个选项「☁️ 云端」，开箱即用。

| 任务 | 内容 | 验收 |
|---|---|---|
| P4-T1 | 新建 [codex/bowerbird_cloud.rs](apps/desktop/src-tauri/src/codex/bowerbird_cloud.rs) `BowerbirdCloudProvider` 实现 `GenProvider::generate_image`：读本地参考图 → base64 → 带 token POST `generate-proxy` → b64 落临时文件 → `GenOutcome`（骨架照抄 openai_api.rs）；方舟视频走 submit_id + 轮询，复用 `poll_query_and_download` 模式 | `resolve_gen_provider("bowerbird-cloud")` 可用；`cargo test` 新增用例过 |
| P4-T2 | 理解类可切换：当前反推/命名/归类直构造 `CodexCliProvider`（AI-PROVIDERS §4.3），新增 `UnderstandProvider` 抽象或 `understand_provider` 设置项（codex / cloud 二选一），云端走 `understand-proxy`；**默认逻辑：登录且有余额走 cloud，否则回退 codex，皆不可用按约定 7 置灰** | 设置页切换生效；反推 sections 格式与 codex 路径一致（caption::parse 测试全过） |
| P4-T3 | 前端：`ProviderSelect` 加云端选项（未登录/余额不足置灰 + tooltip 原因）；store 透传与 `GenTurn.provider` 角标「via 云端」；onboarding 卡片联动 | 真机：选云端出图入库 source=bowerbird-cloud、✨ 角标/回看/复用全通 |
| P4-T4 | 失败语义：402 → 前端弹「积分不足 → 去充值」；审核不过 → 明确提示且不扣分（回滚已由服务端做，前端只展示） | 各错误码 UI 走查 |

### P5 · 积分扣费链路（端到端）

**目标**：「预估 → 预扣 → 成功确认 / 失败回滚」在真实生成链路闭合；BYO 明确不扣。

| 任务 | 内容 | 验收 |
|---|---|---|
| P5-T1 | 扣费时机落在服务端（P2-T1 已做），桌面端只负责：生成前本地预估提示（「本次预计 5 分」）、idempotency_key 生成（前端 jobId 直接复用为幂等键——多 job 架构已保证唯一） | 同一 jobId 重试不双扣 |
| P5-T2 | BYO 免积分判定：provider=codex/jimeng 时不走任何积分链路（服务端也不经手），且门控要求 Pro+（P6 挂接） | BYO 生成流水零记录 |
| P5-T3 | 流水 UI：SettingsDialog 账号区「积分明细」inline 面板（近 50 条，grant/hold/confirm/rollback 图标区分） | 与实际流水一致 |
| P5-T4 | 余额实时性：每次 confirm 响应带回最新余额 → store 更新；生成面板轻量余额角标 | 连续生成余额递减正确 |

### P6 · 功能门控

**目标**：免费 / Pro / Studio 三档在 app 内真实生效；门控判定全部走本地 entitlement 缓存（离线宽限内不联网）。

| 门控点 | 免费 | Pro | Studio | 实现位置 |
|---|---|---|---|---|
| 素材管理（L1 全部） | ✅ 全部 | ✅ | ✅ | 无门控，永免费 |
| 反推/命名/归类 | 10 次/日（云端计） | 不限（公平使用 2000 次/月） | 同 Pro | understand 调用前查 entitlement |
| 创作板 + 生成入口 | 仅云端 + 每日 30 分额度 | ✅ | ✅ | CreationBoard 发送按钮 |
| BYO 引擎（codex/即梦） | ❌（置灰 + 升级提示） | ✅ 不扣积分 | ✅ | ProviderSelect |
| 多 job 并行 | 1（串行） | 并行 | 并行 + 优先队列 | startGeneration 并发闸 |
| 高清/4K 导出、商用授权、云端备份 | ❌ | ❌ | ✅ | 随对应功能落地挂接（P0-T1 决策） |

| 任务 | 内容 | 验收 |
|---|---|---|
| P6-T1 | `entitlement` 单一事实源：store `tier` 派生 canBoard/canByo/maxParallel/canHdExport；**所有门控点只读该派生**，禁止散落 tier 字符串比较 | grep 确认门控判断仅一处 |
| P6-T2 | 各门控点接 UI：置灰 + tooltip「升级 Pro 解锁」+ 点击跳账号区；免费档超每日反推次数的提示 | 三档账号分别真机走查 |
| P6-T3 | 降级路径测试：Pro 到期 → 免费档行为正确；离线 7 天边界 | 构造过期订阅测试通过 |

### P7 · 订阅与支付

**目标**：国内 superun 闭环收款，webhook 自动开通订阅态；积分包可购。海外 Paddle 作为独立后续任务。

| 任务 | 内容 | 验收 |
|---|---|---|
| P7-T1 | `payment-webhook` Function：superun 回调验签 → 写 orders → 更新 subscriptions → 积分包则 `topup` 流水；全部幂等（provider_order_id 唯一） | 重放回调不重复开通/发分 |
| P7-T2 | 购买链路：app/官网定价页 → superun 托管收银台（微信/支付宝扫码）→ webhook 开通 → app 下次同步生效（+「支付已完成？刷新」按钮） | 真实小额测试单全流程 |
| P7-T3 | 4 个订阅 SKU + 4 个积分包 SKU 配置（定价 §3.1/§3.2），退款规则（7 天无理由 / 按已用整月扣减）走 superun 人工流程，文档化 | 价格表与定价文档一致 |
| P7-T4 | 年付特殊逻辑：积分按月发放（cron 已就绪）、结转 1 个月、续费同价、早鸟价（如启用）——配置化 | 年付用户月度 grant 正确 |
| P7-T5 | 海外 Paddle（可延后）：同 webhook 骨架第二 provider 分支 | 测试模式回调通过 |

### P8 · 官网试用接账号

**目标**：[website/server.mjs](website/server.mjs) 的每 IP 限流替换为「登录送 30 分体验分」，官网成为账号体系入口。

| 任务 | 内容 | 验收 |
|---|---|---|
| P8-T1 | 官网接 Supabase Auth（邮箱魔法链接，纯前端 SDK）；`/api/generate` 改验 JWT + 调云端同一套积分 RPC（与 P2 generate-proxy 合并或转发） | 未登录不可生成；登录送 30 分 |
| P8-T2 | 注册触发体验分 grant（`kind=grant_daily` 或独立 `trial` bucket，30 分） | 新账号余额 30 |
| P8-T3 | 试用耗尽 CTA：引导下载桌面端（账号互通，积分随账号走）；删旧每 IP 限流代码 | 全链路走查；旧限流零残留 |

### P9 · 联调、测试与发布

| 任务 | 内容 | 验收 |
|---|---|---|
| P9-T1 | E2E 剧本（真机）：新用户注册 → 免费档每日 30 分生成 → 耗尽被门控 → 购 Pro → BYO 解锁 + 800 分到账 → 生成扣费正确 → 失败回滚 → 断网宽限 → 到期降级 | 剧本逐项签字 |
| P9-T2 | 回归基线：`cargo test` 全绿（含新增）、`tsc --noEmit`、Vite build、官网 build、扩展 node tests | CI 式清单全过 |
| P9-T3 | 安全审计：RLS 全表复核、key 零入仓、webhook 验签、熔断值、日志脱敏 | 审计清单逐项过 |
| P9-T4 | 文档收尾：按 AGENTS.md 维护规则更新 PROJECT.md（关键约定 1 演进为「托管 + BYO 双轨」、新增约定「云只承载账号/积分/算力」）、AGENTS.md/CLAUDE.md 索引、版本号日期化 | 存档 commit |

---

## 5. 依赖关系与推荐执行顺序

```
H1(人工 Supabase) ─→ P0 ─→ P1 ─→ P2 ─┬─→ P4 ─→ P5 ─┐
                       │             └─→ P3 ────────┼─→ P6 ─→ P7 ─→ P9
                       └─→ P3 可部分并行 ────────────┘          P8（P2 后任意）
```

- **严格串行**：P1 → P2 → P5；P3 → P6 → P7。
- **可并行**：P3 与 P4（P4 的 provider 实现可用 Mock token 先行）；P8 在 P2 完成后随时插入。
- **建议顺序**：P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 →（P8）→ P9。
- 每个 Phase 完成即独立可用：P1+P2 完成 = 云端可收费跑通；P6 完成 = 三档可卖；P7 完成 = 能收钱。

## 6. 测试策略

- **云端**：SQL/RPC 用脚本化断言（node + supabase-js 调 RPC，覆盖幂等/回滚/FIFO/余额不足）；Functions 用本地 serve + curl 剧本。
- **桌面端**：Rust 侧为新 provider / entitlement / auth 补单测（照 task_queue 7 单测范式）；前端 `tsc --noEmit` + 关键 store 逻辑单测。
- **真机**：每个 Phase 的「验收」列即真机剧本；P9-T1 是总剧本。
- **不回退红线**：每次提交 `cargo test` 现有用例必须全绿（当前 86）。

## 7. 关键约定演进预告（P9-T4 落笔时执行）

- **约定 1**（AI 全外包走用户 CLI、不开 HTTP 口子）→ 演进为「**托管 + BYO 双轨**：BYO 走本地 CLI（原约定）；托管走云代理官方 API，HTTP 口子只开向自家云」。
- **新增约定**：云只承载账号/积分/算力三件事；素材数据永不上云（写进隐私承诺）。
- **新增约定**：所有门控判定走 entitlement 单一事实源；积分扣费必须经 hold/confirm/rollback 三段式。

---

## 8. 风险与对冲（与定价方案 §7 对齐）

| 风险 | 工程对冲 |
|---|---|
| 方舟 API 涨价 | 消耗表配置化（P1-T4），调价不改代码 |
| 免费层被打穿 | P2-T4 全站日熔断 + 免费档只给标清图 |
| 账号化惹恼极客 | BYO 永久保留 + 7 天离线宽限 + 素材不上云承诺 |
| 微信开放平台审核不通过 | 网站应用审核被拒时回退邮箱-only，主链路不受影响（资质已确认，风险低） |
| superun/Paddle 接入变数 | webhook 骨架 provider 化，换支付商只加分支 |
| codex 政策变化 | 托管 Cloud 已是主链路，BYO 降级为加分项 |

## 9. 明确不做（本计划范围外）

- 素材/提示词云端同步（违反 Local-First，永不）。
- 生成历史云端备份（Studio 权益，随视频功能单独立项）。
- 服务器套壳 codex/即梦 CLI（研究报告已判死刑，禁止复活）。
- 积分转让/赠送/交易市场。

## 10. 决策记录（P0-T1 填充）

| # | 问题 | 决策 | 日期 |
|---|---|---|---|
| D1 | 云端形态 | Supabase Edge Functions（默认，待 H6 确认） | 待定 |
| D2 | 微信登录一期/二期 | **一期做**（企业资质已确认，2026-08-08 用户确认） | 2026-08-08 |
| D3 | 高清导出门控形态 | 随视频/超清功能落地时挂接 | 待定 |
| D4 | 海外 Paddle 一期是否做 | 默认延后（P7-T5） | 待定 |
