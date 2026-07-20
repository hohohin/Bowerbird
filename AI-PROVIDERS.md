# AI Providers 方案（内建对话 + 可切换 provider）

> **版本**：v1 草案 · 2026-07-18
> **状态**：探索方案，待讨论定稿。定稿后关键约定 1 同步演进、进入实现。
> **定位**：把 Bowerbird 的 AI 能力（当前硬绑 codex CLI）解耦为**可切换的 provider 层**，首批接入 **codex（已有）+ 即梦（火山引擎 HTTP API）**。
> **关联**：产品全貌见 [PROJECT.md](PROJECT.md)、商业动机见 [PRICING.md](PRICING.md)（风险 4）、技术权威见 [Bowerbird开发计划.md](Bowerbird开发计划.md)。

---

## 0. TL;DR

- **目标**：把生成 / 对话能力从「写死 codex」改为「provider 可切换」，首批 codex + 即梦。
- **动机 = [PRICING.md:144](PRICING.md) 风险 4**：codex 单一供应商是最大底层风险，商业化前必须有一条降级备选 provider 后路（哪怕质量打折）。即梦就是这条路。
- **形态（已定）**：**泛化现有 [GenerationPanel](apps/desktop/src/components/GenerationPanel.tsx)**——它已是多轮生成对话时间线（turns + 流式 + resume 续轮），加 provider 选择即可，**不新建聊天面板**。
- **切换粒度（已定）**：**全局默认（设置里选）+ 单次覆盖（生成面板顶部临时切）**。
- **最大设计张力**：**codex 与即梦能力严重不对等**。codex 能文本对话 / 看图理解 / 出图 / 多轮 resume；**即梦只能出图**（文生图 / 图生图 / 多图组合），无文本对话、无看图理解。这决定了：
  - provider 抽象必须**按能力（capability）而非按 provider** 暴露；
  - **理解类任务（反推 / 命名 / 归类）仍只走 codex**，不参与切换；
  - 切换只发生在**生成（出图）**链路。
- **代价**：**关键约定 1 必须演进**——从「AI 全走 codex CLI，禁止 HTTP 路线」改为「图像生成允许多 provider（codex CLI / 即梦 HTTP API），理解类仍走 codex CLI」。

---

## 1. 背景与动机

### 1.1 这是 PRICING.md 早已规划的事

[PRICING.md](PRICING.md) §6 风险 4 原文：

> **codex 单一供应商依赖（最大底层风险）**。OpenAI 一旦调价、改 `--image` 机制、关 ChatGPT 订阅走 codex 的口子，核心功能直接瘫痪。商业化前必须有一条**降级备选 provider 路径**（哪怕质量打折）。

本方案就是这条「备选 provider 路径」的落地设计。动机清晰、非临时起意。

### 1.2 为什么是即梦

- **能力对口**：即梦是国内最强的图像生成模型之一（文生图 / 图生图 / 多图组合编辑），正对 Bowerbird「生成（⑥）」核心场景。
- **官方 API 可用**：通过火山引擎开放（[即梦 AI 文档中心](https://www.volcengine.com/docs/85621)），无需逆向、可持续维护。
- **国内可达**：火山引擎国内直连，无 GFW 问题（对比此前 OpenAI HTTP 被 reset、见 PROJECT.md 踩坑）。
- **多轮可模拟**：即梦本身无会话状态，但「把上一轮图作参考图传入图生图」天然等价于 codex 的 resume 续轮——可复用 GenerationPanel 已有的多轮交互模型。

### 1.3 不做什么（明确排除）

- ❌ **不新建通用聊天面板**。即梦无文字对话能力，独立聊天面板在即梦侧体验残缺；现有 GenerationPanel 已覆盖「生成对话」语义。
- ❌ **不让即梦做理解类任务**（反推 caption / 命名 / 归类）。即梦无文本输出，硬接等于再配一个 LLM，范围爆炸、偏离「备选出图 provider」初衷。
- ❌ **不在本方案做付费门控**。provider 切换是技术能力；是否把即梦纳入 Pro 付费墙属商业化决策（见 [PRICING.md](PRICING.md) §4），与本方案解耦，后续单独定。

---

## 2. 现状盘点（已具备什么，省了多少工）

| 层 | 现状 | 对本方案的意义 |
|---|---|---|
| **后端抽象** | [`CodexProvider`](apps/desktop/src-tauri/src/codex/mod.rs) trait（`name()` + `run()`），`generate_image` 是 `CodexCliProvider` 的 inherent 方法 | trait 已存在但缺「出图」与「能力探测」，需重构（§5） |
| **后端命令** | [`commands/codex.rs`](apps/desktop/src-tauri/src/commands/codex.rs) 全部硬编码 `CodexCliProvider::default()`，命令名 `codex_create_image` 等 | 需引入 provider 选择参数（§5.3） |
| **前端对话 UI** | [`GenerationPanel.tsx`](apps/desktop/src/components/GenerationPanel.tsx) 已是多轮时间线（`genTurns` / 流式 / resume / Lightbox） | **直接复用**，仅加 provider 切换条（§6） |
| **前端状态** | [store.ts](apps/desktop/src/store.ts) `startGeneration`/`sendGenRevise`/`applyGenChunk` + 全局 `codex://chunk` 监听（[App.tsx](apps/desktop/src/App.tsx)） | 加 `activeProvider`/`defaultProvider` 字段（§6.1） |
| **配置入口** | [`SettingsDialog.tsx`](apps/desktop/src/components/SettingsDialog.tsx) 全屏 Modal（约定 13 形态），**已挂载**于 [Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx) ⚙ | 即梦 AK/SK + 默认 provider 配置直接加到这里（§7） |
| **流式协议** | `codex://chunk` 推 `Chunk{Delta/Done/Error}`（[types.rs](apps/desktop/src-tauri/src/codex/types.rs)） | 即梦无流式，但可把轮询进度映射成同一事件（§6.3） |

**结论**：本方案是「在成熟骨架上加 provider 维度」，不是从零搭。90% 的 UI / store / 事件协议可复用。

---

## 3. 即梦能力调研（接入前以官方文档为准）

> ⚠️ 以下基于 2026-07 公开文档与搜索结果。**真正动手前必须 spike 验证**（签名方式 / 异步轮询周期 / 返回字段），见 §9 Phase 0。

### 3.1 平台与模型

即梦 AI 通过**火山引擎**对外开 API（[文档中心](https://www.volcengine.com/docs/85621)），主要可用能力：

| 模型 / 接口 | 能力 | 文档 |
|---|---|---|
| **即梦图片生成 4.0** | 文生图 + 图像编辑 + 多图组合（单次最多 10 张参考图） | [1817045](https://www.volcengine.com/docs/85621/1817045) |
| **图生图 3.0 智能参考** | 基于文本指令的图像编辑（精准执行 + 保持完整性） | [1747301](https://www.volcengine.com/docs/85621/1747301) |
| **Seedream 5.0 lite**（方舟平台） | 图片生成，API 参数化调用 | [1541523](https://www.volcengine.com/docs/82379/1541523) |
| 视频生成 / 数字人 | 本方案**不涉及** | — |

**建议首选**：图像生成走**即梦 4.0**（能力最全、与「创作板生成 + 多轮迭代」最契合）；若 4.0 接入成本高，先落 **Seedream 5.0 lite**（方舟 API 更标准、签名更简单）作为最小可用项。

### 3.2 认证

火山引擎两套认证体系（spike 时二选一定）：

- **火山引擎 AK/SK + V4 签名**：通用、复杂（HMAC-SHA256 签名），即梦原生 API 多用此。
- **方舟（Ark）API Key**：更简单（Bearer token），Seedream 模型走方舟平台时用。

→ **倾向方舟 API Key**（若 Seedream 满足需求），显著降低签名实现成本与踩坑面。

### 3.3 调用模式

- **HTTP，异步任务制**：提交生成请求 → 返回 `task_id` → **轮询**任务状态 → 完成后取图 URL。
- **无逐字流式**（与 codex `agent_message` Delta 不同）：即梦只有「排队中 / 生成中 / 完成」状态。
- 图 URL 需下载到本地后 `ingest_generated` 入库（复用 codex 生成图同款路径，见 [ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs) `ingest_generated`）。

### 3.4 codex vs 即梦：能力对比（抽象层的设计依据）

| 维度 | codex（CodexCliProvider） | 即梦（JimengProvider，待建） |
|---|---|---|
| 文本对话 | ✅ | ❌ |
| 看图理解（→ caption） | ✅ | ❌（图生图是「编辑」非「理解」） |
| 文生图 | ✅（imagegen 技能） | ✅ |
| 图生图 / 多图组合 | ✅（弱） | ✅✅（强项，4.0 单次 10 图） |
| 多轮迭代 | ✅ `codex exec resume <sid>` | △ 无原生会话；靠「上一轮图作参考」模拟 |
| 流式 | ✅ JSONL Delta | ❌ 仅任务状态轮询 |
| 认证 | ChatGPT 订阅（本地 CLI） | 火山引擎 AK/SK 或方舟 API Key |
| 调用形态 | 子进程 spawn | HTTP + 轮询 |
| 联网 | 走 chatgpt.com（国内偶尔 reset，自动回退 HTTPS） | 火山引擎国内直连 |

**核心结论**：两者**只在「出图」维度重叠**。抽象层应围绕「出图」建立，能力差异用 capability 标记暴露给 UI（§5.2）。

---

## 4. 核心设计决策（已与用户确认）

### 4.1 形态：泛化 GenerationPanel（不新建聊天面板）

- GenerationPanel 已是「多轮生成对话」：用户组稿 → 首版 → 提修改意见 → 续轮出图 → Lightbox 看图。
- 加 provider 后：同一套 turns 时间线，**每一轮记录它用的 provider**；切换 provider = 下一轮换一个出图器。
- 用户感知：「生成面板现在能选 codex 或即梦」，而非多出一个聊天窗。

### 4.2 切换粒度：全局默认 + 单次覆盖

- **全局默认 provider**：存于设置（SettingsDialog），决定新会话首轮用谁。默认 `codex`（不破坏现状）。
- **单次覆盖**：GenerationPanel 顶部一个 provider 切换条，临时切换**当前会话**的 provider（不写回全局默认）。
- **会话内一致性**：一旦会话首轮定了 provider，续轮默认沿用（codex resume 只能用 codex；即梦多轮只能即梦），UI 在续轮时**禁用切换**并提示原因。

### 4.3 能力不对等的处理原则

| 任务 | 是否参与 provider 切换 | 说明 |
|---|---|---|
| 生成（出图） | ✅ 参与 | codex / 即梦可选 |
| 反推 caption | ❌ 仅 codex | 即梦无文本输出 |
| 采集即命名 / 归类 | ❌ 仅 codex | 同上 |
| 生成图回看（generation_history） | ✅ 按 provider 还原 | 落库时记 provider，回看时按其机制重建时间线 |

---

## 5. 后端：provider 抽象层设计

### 5.1 trait 重构（[codex/mod.rs](apps/desktop/src-tauri/src/codex/mod.rs)）

把 `generate_image` 从 inherent 提到 trait，并加能力探测。命名建议从 `CodexProvider` 广义化为 `GenProvider`（或保留旧名作别名，降低改动面）：

```rust
// 草图，非最终实现
#[async_trait]
pub trait GenProvider: Send + Sync {
    fn name(&self) -> &'static str;                 // "codex" / "jimeng"
    fn capabilities(&self) -> Capabilities;          // 能力自述

    /// 单轮文本（理解类：反推 / 命名 / 归类）。仅 codex 实现；即梦返回 Unsupported。
    async fn run(&self, req: GenRequest) -> Result<GenResult, AppError>;

    /// 出图（生成）。两者都实现。流式经 tx 推 Chunk（codex=Delta，即梦=进度）。
    async fn generate_image(
        &self,
        req: GenRequest,
        tx: &mpsc::Sender<Chunk>,
        session: Option<&str>,   // codex=session_id(resume)；即梦=本地构造的「会话句柄」
    ) -> Result<GenOutcome, AppError>;

    /// 可用性检测（codex=CLI+auth.json；即梦=AK/SK 配置非空 + 可选 ping）。
    async fn health(&self) -> Health;
}

#[derive(Clone, Copy)]
pub struct Capabilities { pub chat: bool, pub caption: bool, pub generate: bool }
```

- **会话句柄**：codex 的 `session_id` 是 codex 自管的 UUID；即梦无原生会话，需 Bowerbird 自己造一个「逻辑会话」（见 §5.4）。trait 层用 `Option<&str>` 统一，语义按 provider 解释。

### 5.2 命令层：provider 选择参数（[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)）

`codex_create_image` 泛化为 provider 感知（命令是否改名见开放问题 §11）：

```rust
// 现状：硬编码 CodexCliProvider::default()
// 改为：按 provider 参数取实现
#[tauri::command]
pub async fn create_image(
    app, db, paths,
    prompt: String,
    reference_images: Vec<String>,
    session_id: Option<String>,
    provider: Option<String>,         // 新增；None → 用全局默认
) -> Result<(), AppError>
```

- provider 解析：`None` / `"default"` → 读全局默认配置；`"codex"` / `"jimeng"` → 对应实现。
- 命令层不关心具体 provider，只 `match provider { "codex" => ..., "jimeng" => ... }` 取 trait object 后调 `generate_image`。

### 5.3 即梦 provider 实现（新建 [codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs)）

- 用 `reqwest`（项目已有依赖，ws_server / 下载器在用）。
- 流程：构造请求（文生图 / 图生图，参考图 base64 或先上传）→ 提交拿 `task_id` → `tokio::time::interval` 轮询 → 完成取图 URL → 下载 → 借 `tx` 推 `Chunk::Done{images}`（**即梦不推 Delta，或推伪进度 Delta 如「即梦生成中…」**）。
- 多轮模拟：`session` 句柄 = 上一轮产出图的 asset store_path；续轮把它作参考图走图生图（§5.4）。
- 复用 [ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs) `ingest_generated` 入库，`source="jimeng"`（与 `source="codex"` 对称，瀑布流角标 / 智能筛选 `source:jimeng` 自动可用）。

### 5.4 即梦的「多轮会话」如何落地

即梦无原生会话，Bowerbird 自己拼：

- 首轮：文生图（纯 prompt）。
- 续轮：取上一轮产出图（store_path）→ 作为参考图走**图生图 / 智能参考**，prompt = 用户修改意见。
- 「会话句柄」= 本地维护的「上一轮图 asset_id」（存内存或 `generation_meta`，不必新表）。
- 这样 GenerationPanel 的「提修改意见续轮」在即梦侧等价可用——用户体感与 codex resume 一致，底层实现不同。

### 5.5 生成来源落库（generation_meta）扩展

[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) 当前把 `{prompt, session_id, references}` 落 `analyses(kind=generation_meta)`。**加一字段 `provider`**：

```json
{ "prompt": "...", "session_id": "...", "references": [...], "provider": "codex" | "jimeng" }
```

- 回看（`generation_history`）按 provider 决定重建机制（codex 走 session_id、即梦走参考图链）。
- `analyses.provider` 列已存在，照填。

---

## 6. 前端设计

### 6.1 store 扩展（[store.ts](apps/desktop/src/store.ts)）

新增字段（**不破坏现有生成逻辑**，仅加 provider 维度）：

```ts
// 全局默认 provider（设置里选），默认 "codex"
defaultProvider: "codex" | "jimeng";
setDefaultProvider: (p) => void;
// 当前生成会话的 provider（单次覆盖；会话开始时 = defaultProvider 或用户手选）
activeGenProvider: "codex" | "jimeng";
// 每个 turn 记录它用的 provider（回看 / 续轮判断要用）
// → GenTurn 加字段 provider
```

`startGeneration(prompt, refs, provider?)`、`sendGenRevise(instruction)` 透传 provider；续轮时若与首轮 provider 冲突（如 codex 会话想切即梦）UI 应禁用并提示。

### 6.2 GenerationPanel UI（[GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx)）

顶部 header 加 provider 切换条：

```
🖼 生成结果 · 3 轮 · 4 图          [ codex ▼ ]  ✕
```

- 下拉项：`codex`（始终可选，就绪时）/ `jimeng`（配好 AK/SK 后可选）。
- 续轮中（`genSessionId` 非空 / 即梦有参考图链）：切换条**置灰** + tooltip「续轮沿用首轮 provider」。
- 每 turn 角标小字标 provider（`via codex` / `via 即梦`），让用户清楚每张图谁出的。

### 6.3 流式体验差异的统一

- **codex**：`codex://chunk` 的 `Delta` 照旧逐字流式（genStreaming 区）。
- **即梦**：无 Delta。两种选择：
  - **(A)** 不推 Delta，只在轮询中推 `Delta{ "[即梦] 生成中…" }` 之类的状态文本（简单，体验接近「等图」）。
  - **(B)** 后端把轮询进度（如「排队中 / 渲染中 60%」）映射成 Delta（更生动，但即梦是否暴露进度需 spike）。
- 倾向 **(A)** 起步，体验不足再升级。

### 6.4 api 层（[lib/api.ts](apps/desktop/src/lib/api.ts)）

`codexCreateImage` 加 `provider` 参数（或新增 `createImage` 别名，旧名保留兼容）：

```ts
createImage: (req: { prompt; referenceImages; sessionId?; provider? }) =>
  invoke<void>("create_image", { ...req, provider: req.provider ?? null });
```

`CodexHealth` 泛化为 provider 健康数组，或加 `jimengHealth`：UI 据各 provider 健康决定下拉项是否可选（约定 7 降级置灰的延伸）。

---

## 7. 配置与认证（即梦 AK/SK 存哪）

### 7.1 配置入口

[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 已挂载（Toolbar ⚙），直接加一个 section：

```
设置
├─ 环境状态（codex）         ← 已有
├─ AI 出图引擎（新增）
│   ├─ 默认 provider：[ codex ▼ ]   ← 全局默认（§4.2）
│   └─ 即梦（火山引擎）
│       ├─ API Key / AK：[ ______ ]
│       ├─ Secret Key / SK：[ ______ ]（或方舟 API Key 单框）
│       ├─ 模型：[ 即梦 4.0 ▼ ]
│       └─ [ 测试连接 ]
├─ 重建色板                  ← 已有
└─ 智能归类全部              ← 已有
```

### 7.2 凭据存储（待定，见开放问题 §11）

项目**零 zustand persist、零 Settings 持久化**（之前 Settings 模块已删，见 PROJECT.md「多模态看图四条路径」）。即梦凭据需新增持久化，候选：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **明文 JSON**（`$APPDATA/bowerbird/providers.json`） | 实现最简、与现有本地优先哲学一致 | 凭据明文，本机其它进程可读 |
| **OS keychain**（[keyring](https://crates.io/crates/keyring) crate） | 安全（OS 级加密） | 多一个依赖、跨平台行为差异 |
| **环境变量** | 零存储 | 桌面应用用户不会设 env，不可行 |

→ **倾向明文 JSON 起步**（与项目「本地优先、数据在用户手里」一致；本机威胁模型下可接受），文档明确风险，后续若商业化可升 keychain。

### 7.3 后端配置模块

新建 `core/provider_config.rs`（或复用 paths 模式），读写上述 JSON；命令 `get_provider_config` / `set_provider_config`（凭据字段写时不回传明文，只回 `configured: bool`）。

---

## 8. 关键约定 1 的演进（定稿后同步 PROJECT.md）

**现行（[PROJECT.md](PROJECT.md) 关键约定 1）**：

> AI 全外包，不自建模型：所有理解/分析与图像生成均走 headless codex 子进程…禁止…HTTP 路线…Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线均已全部移除。

**演进为**：

> AI 全外包，不自建模型。**理解类**（反推 caption / 命名 / 归类）仍走 codex CLI（ChatGPT 订阅，真正看图）。**图像生成（⑥）** 改为多 provider 可切换：codex CLI（默认）/ 即梦（火山引擎 HTTP API，作为 codex 的降级备选，见 [PRICING.md](PRICING.md) 风险 4）。provider 抽象为 `GenProvider` trait，按 capability 暴露；禁止的仍是「自建 / 本地模型」（ONNX / CLIP / 本地扩散 / tesseract / 向量）。

**注**：约定 1 移除「Mock/ClaudeCode/DeepSeek/OpenAI HTTP」那句的历史语境（当年是为「看图」选路），不影响本方案——那些路线是「理解类看图」的失败备选，本方案加的即梦是「生成类出图」的备选，正交。

---

## 9. 落地路线图

> 每个阶段都可独立验证、可回退。**Phase 0 必须先做**（仿项目「多模态看图四条路径实测」传统，即梦接入有未知）。

### Phase 0 · spike 即梦调通（验证可行性，不改主源码架构）

- 目标：在 Bowerbird 后端用 `reqwest` 调通即梦一次文生图 + 一次图生图，拿到图下载到本地。
- 验证项：① 认证（方舟 API Key vs AK/SK 签名，定哪个）；② 异步轮询周期与字段；③ 返回图 URL 可下载；④ 国内直连延迟。
- 产出：一份 spike 笔记（类似 PROJECT.md 踩坑「codex exec --json 事件结构」），修正本方案 §3 的假设。
- **门槛**：spike 通了才进 Phase 1；不通则换模型（4.0 → Seedream lite）或换 provider 候选。

### Phase 1 · provider 抽象重构（行为不变，纯解耦）

- `CodexProvider` → `GenProvider` trait（§5.1），`generate_image` 提到 trait。
- 命令层 `codex_create_image` 加 `provider` 参数，**默认仍 codex、行为零变化**。
- 加 `Capabilities` / `health`。
- 验证：`cargo test` 全绿；现有生成 / 反推 / 回看行为完全不变（回归）。

### Phase 2 · 即梦 provider 实现

- 新建 `codex/jimeng.rs`（§5.3），实现 `GenProvider`。
- 多轮模拟（§5.4）、`source="jimeng"` 入库、`generation_meta.provider` 落库（§5.5）。
- 验证：后端单测 + 一次端到端即梦生成（首轮 + 续轮）。

### Phase 3 · 前端切换 UI + 配置

- store `defaultProvider` / `activeGenProvider`（§6.1）。
- GenerationPanel 顶部 provider 切换条（§6.2）。
- SettingsDialog 即梦配置区 + 默认 provider（§7.1）。
- provider_config 持久化（§7.2/7.3）。
- 验证：创作板发送 → 选即梦 → 出图 → 提修改 → 续轮 → 入库 → 回看，全链路。

### Phase 4 · 文档与约定收尾

- 本方案定稿（修正 spike 发现）。
- PROJECT.md 关键约定 1 演进（§8）+「目前进展」加条目。
- CLAUDE.md 索引已含本文档（落地时补「何时读」）。

---

## 10. 风险与提醒

1. **即梦付费 / 额度**：火山引擎即梦按量计费（与 codex 走用户 ChatGPT 订阅不同）。用户用即梦 = 用户自己掏火山引擎的钱。UI 应明示「即梦调用产生火山引擎费用」，并考虑与 [PRICING.md](PRICING.md) 付费墙的关系（后续单独定，本方案不锁）。

2. **多轮体验打折**：即梦靠「上一轮图作参考」模拟多轮，**不如 codex resume 那样记得完整对话上下文**（codex 记得前几轮所有修改意图，即梦只看上一张图）。复杂迭代场景即梦可能「失忆」，UI 应Manage预期。

3. **流式体验断层**：即梦无逐字流式，GenerationPanel 的 genStreaming 区在即梦侧会「空等 → 突然出图」，与 codex 的「看它画」体验不同（§6.3）。

4. **凭据安全**：明文存 AK/SK 有本机泄露风险（§7.2），文档须明示。

5. **即梦模型 / 接口变更**：火山引擎 API 版本迭代快（4.0 已是迭代后的），需关注废弃。spike 时记下所用版本与文档链接。

6. **provider 健康与降级**：codex 不可用 + 即梦未配置 = 生成完全瘫痪（比单 codex 更脆）。约定 7 的「置灰 + 提示」需覆盖「所有 provider 都不可用」的场景。

---

## 11. 开放问题（需后续拍板）

| # | 问题 | 倾向 |
|---|---|---|
| 1 | 命令是否从 `codex_create_image` 改名为 `create_image`？ | 改名更准确，但破坏前端 api 与历史调用；倾向**加新名 `create_image`，旧名保留为 codex 别名**，迁移完再删 |
| 2 | 即梦认证走方舟 API Key 还是火山 AK/SK？ | **方舟 API Key**（若 Seedream 满足），签名简单；spike 定 |
| 3 | 即梦首选模型（4.0 vs Seedream lite）？ | 先 **Seedream lite**（接入快）验证链路，再上 4.0 |
| 4 | 凭据存储明文 JSON vs keychain？ | **明文 JSON 起步**，商业化时升 keyring |
| 5 | 即梦多轮失忆是否给 UI 提示？ | **是**，续轮切换即梦时 tooltip 提示「即梦仅参考上一张图」 |
| 6 | 即梦是否纳入 Pro 付费墙？ | **本方案不锁**，留商业化决策（见 [PRICING.md](PRICING.md) §4） |
| 7 | trait 改名 `CodexProvider` → `GenProvider` 还是保留旧名？ | 倾向**改名**（语义已超出 codex），用 `type CodexProvider = GenProvider` 过渡 |

---

## 附：关键决策记录

| 日期 | 决策 |
|---|---|
| 2026-07-18 | 首版方案草案：泛化 GenerationPanel + 全局默认/单次覆盖 + codex/即梦首批；理解类仍只走 codex；待 spike 即梦后定稿。 |
