# AI Providers 方案（内建对话 + 可切换 provider）

> **版本**：v2 草案 · 2026-07-23
> **状态**：探索方案，待讨论定稿。定稿后关键约定 1 同步演进、进入实现。
> **v1→v2 变更（2026-07-23）**：即梦官方推出 **CLI（`dreamina`，单二进制 + OAuth 登录）**，接入路线从 v1 的「火山引擎 HTTP API（AK/SK + 签名 + 轮询 + 凭据存储）」**整体改为「官方 dreamina CLI（与 codex 同构的本地子进程）」**。这消解了 v1 的签名实现、凭据存储两个老大难，更贴合关键约定 1「AI 全外包给 CLI」。§3/§5.3/§7/§9/§10/§11 据此重写；§4（形态/切换粒度/能力不对等）、§5.1/5.2（trait/命令抽象）、§5.4（多轮模拟）、§6（前端）不受影响，沿用 v1。
> **定位**：把 Bowerbird 的 AI 能力（当前硬绑 codex CLI）解耦为**可切换的 provider 层**，首批接入 **codex（已有）+ 即梦（官方 dreamina CLI）**。
> **关联**：产品全貌见 [PROJECT.md](PROJECT.md)、商业动机见 [PRICING.md](PRICING.md)（风险 4）、技术权威见 [Bowerbird开发计划.md](Bowerbird开发计划.md)。

---

## 0. TL;DR

- **目标**：把生成 / 对话能力从「写死 codex」改为「provider 可切换」，首批 codex + 即梦。
- **动机 = [PRICING.md:144](PRICING.md) 风险 4**：codex 单一供应商是最大底层风险，商业化前必须有一条降级备选 provider 后路（哪怕质量打折）。即梦就是这条路。
- **形态（已定）**：**泛化现有 [GenerationPanel](apps/desktop/src/components/GenerationPanel.tsx)**——它已是多轮生成对话时间线（turns + 流式 + resume 续轮），加 provider 选择即可，**不新建聊天面板**。
- **切换粒度（已定）**：**全局默认（设置里选）+ 单次覆盖（生成面板顶部临时切）**。
- **即梦接入形态（v2 定）**：**官方 `dreamina` CLI 子进程**（`curl -s https://jimeng.jianying.com/cli | bash` 装的单二进制），与 codex CLI 同构——本地子进程 + 自管登录态 + 出图。**不再走火山引擎 HTTP API / AK/SK 签名 / 方舟 API Key**。
- **最大设计张力**：**codex 与即梦能力严重不对等**。codex 能文本对话 / 看图理解 / 出图 / 多轮 resume；**即梦只能出图**（文生图 / 图生图 / 图像超分 / 视频），无文本对话、无看图理解。这决定了：
  - provider 抽象必须**按能力（capability）而非按 provider** 暴露；
  - **理解类任务（反推 / 命名 / 归类）仍只走 codex**，不参与切换；
  - 切换只发生在**生成（出图）**链路。
- **代价**：**关键约定 1 必须演进**——从「AI 全走 codex CLI，禁止 HTTP 路线」改为「图像生成允许多 provider（codex CLI / 即梦 dreamina CLI，均为本地子进程），理解类仍走 codex CLI」。**v2 比 v1 更纯粹**：连 v1 预留的「即梦 HTTP 路线」都不需要引入，全部是 CLI 子进程。

---

## 1. 背景与动机

### 1.1 这是 PRICING.md 早已规划的事

[PRICING.md](PRICING.md) §6 风险 4 原文：

> **codex 单一供应商依赖（最大底层风险）**。OpenAI 一旦调价、改 `--image` 机制、关 ChatGPT 订阅走 codex 的口子，核心功能直接瘫痪。商业化前必须有一条**降级备选 provider 路径**（哪怕质量打折）。

本方案就是这条「备选 provider 路径」的落地设计。动机清晰、非临时起意。

### 1.2 为什么是即梦

- **能力对口**：即梦是国内最强的图像生成模型之一（文生图 / 图生图 / 多图组合编辑），正对 Bowerbird「生成（⑥）」核心场景。
- **官方 CLI 可用（v2 关键变化）**：2026-04 即梦发布官方 CLI `dreamina`（单二进制，全平台含 Windows，OAuth Device Flow 登录，走即梦会员积分）。Bowerbird 像调 codex 一样 spawn 它即可——无需逆向、无需实现火山引擎 V4 签名、无需自建 HTTP 客户端。
- **国内可达**：dreamina 服务端国内直连，无 GFW 问题（对比此前 OpenAI HTTP 被 reset、见 PROJECT.md 踩坑）。
- **与 codex 同构**：本地子进程 + 自管登录态 + 订阅/积分计费，接入模式可几乎完全复用 [CodexCliProvider](apps/desktop/src-tauri/src/codex/codex_cli.rs)（§5.3）。
- **多轮可模拟**：即梦本身无会话上下文记忆，但「把上一轮图作参考图传入 `image2image`」天然等价于 codex 的 resume 续轮——可复用 GenerationPanel 已有的多轮交互模型。

### 1.3 不做什么（明确排除）

- ❌ **不新建通用聊天面板**。即梦无文字对话能力，独立聊天面板在即梦侧体验残缺；现有 GenerationPanel 已覆盖「生成对话」语义。
- ❌ **不让即梦做理解类任务**（反推 caption / 命名 / 归类）。即梦无文本输出，硬接等于再配一个 LLM，范围爆炸、偏离「备选出图 provider」初衷。
- ❌ **不在本方案做付费门控**。provider 切换是技术能力；是否把即梦纳入 Pro 付费墙属商业化决策（见 [PRICING.md](PRICING.md) §4），与本方案解耦，后续单独定。
- ❌ **不走火山引擎 HTTP API 路线（v2 删除）**。v1 曾规划即梦走火山引擎 AK/SK 或方舟 API Key + HTTP 轮询；官方 CLI 出来后该路线冗余（签名/凭据存储/HTTP 客户端全是额外复杂度），整体改走 CLI。

---

## 2. 现状盘点（已具备什么，省了多少工）

| 层 | 现状 | 对本方案的意义 |
|---|---|---|
| **后端抽象** | [`CodexProvider`](apps/desktop/src-tauri/src/codex/mod.rs) trait（`name()` + `run()`），`generate_image` 是 `CodexCliProvider` 的 inherent 方法 | trait 已存在但缺「出图」与「能力探测」，需重构（§5） |
| **后端命令** | [`commands/codex.rs`](apps/desktop/src-tauri/src/commands/codex.rs) 全部硬编码 `CodexCliProvider::default()`，命令名 `codex_create_image` 等 | 需引入 provider 选择参数（§5.2） |
| **后端 codex CLI 范式** | [codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs) 已沉淀「子进程 spawn + JSONL 解析 + 取图入库 + Windows 适配」全套（`resolve_codex_binary`/`codex_home`/`codex_command` + 快照差分取图 + `CREATE_NO_WINDOW`） | **即梦 provider 直接复用这套范式**（§5.3），dreamina 是原生 exe 连 shim 问题都没有 |
| **前端对话 UI** | [`GenerationPanel.tsx`](apps/desktop/src/components/GenerationPanel.tsx) 已是多轮时间线（`genTurns` / 流式 / resume / Lightbox） | **直接复用**，仅加 provider 切换条（§6） |
| **前端状态** | [store.ts](apps/desktop/src/store.ts) `startGeneration`/`sendGenRevise`/`applyGenChunk` + 全局 `codex://chunk` 监听（[App.tsx](apps/desktop/src/App.tsx)） | 加 `activeProvider`/`defaultProvider` 字段（§6.1） |
| **配置入口** | [`SettingsDialog.tsx`](apps/desktop/src/components/SettingsDialog.tsx) 全屏 Modal（约定 13 形态），**已挂载**于 [Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx) ⚙ | 即梦登录状态 + 默认 provider 配置加到这里（§7） |
| **首启引导** | [CodexOnboarding.tsx](apps/desktop/src/components/CodexOnboarding.tsx) 全屏 Modal 三步引导（约定 13） | dreamina 登录引导对称复用（§7.4） |
| **创作板 ratio** | [CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) ratio 选择器（1:1/3:4/4:3/2:3/3:2/16:9/9:16，2026-07-20），注释已预留「未来即梦接入对接其 size 参数」 | dreamina `--ratio` 直接对接，**前端零改动**（§5.3） |
| **流式协议** | `codex://chunk` 推 `Chunk{Delta/Done/Error}`（[types.rs](apps/desktop/src-tauri/src/codex/types.rs)） | 即梦无流式，但可把轮询进度映射成同一事件（§6.3） |

**结论**：本方案是「在成熟骨架上加 provider 维度」，不是从零搭。90% 的 UI / store / 事件协议 / 子进程范式可复用。v2 相比 v1 还省掉了「HTTP 客户端 + 签名 + 凭据存储」一整块。

---

## 3. 即梦能力调研（基于官方 dreamina CLI，2026-07-23）

> ✅ 本节基于官方安装脚本、`dreamina -h`、官方 SKILL.md、第三方 `dreamina-cli-skill` 综合，并经 **2026-07-23 本机 spike 实测**（Win11 + dreamina CLI + maestro 会员）：安装 / 登录 / `text2image` / `query_result` 全链路跑通，stdout JSON 结构、下载命名、积分行为均已确认（§3.3/§3.6）。**Phase 0 通过，可直接进 Phase 1。**

### 3.1 dreamina CLI 是什么

`curl -s https://jimeng.jianying.com/cli | bash` 装的是一个**单二进制**工具（不是 npm 包）：

| 项目 | 实际情况 |
|---|---|
| 程序名 | `dreamina`（即梦海外品牌 Dreamina） |
| 二进制来源 | `lf3-static.bytednsdoc.com/.../dreamina_cli_{platform}`（beta） |
| 安装位置 | macOS/Linux `~/.local/bin/dreamina`；Windows `%USERPROFILE%\bin\dreamina.exe` |
| 配置/登录态目录 | `~/.dreamina_cli/`（见 §3.5） |
| 平台覆盖 | darwin/linux/windows × amd64/arm64（全平台，含 Windows 原生 exe） |
| SKILL.md | `~/.dreamina_cli/dreamina/SKILL.md`（给 AI agent 用的用法文档，字节官方为 Claude Code/Codex/openclaw 这类 agent 设计） |

**核心命令面**（官方称「八种生成命令」，Bowerbird v1 只用前两个 + 取图）：

| 命令 | 能力 | Bowerbird 用途 |
|---|---|---|
| `dreamina text2image` | 文生图 | ✅ 首轮生成 |
| `dreamina image2image` | 图生图（传参考图） | ✅ 续轮迭代（§5.4） |
| `dreamina image_upscale` | 图像超分 | 可选，后续 |
| `dreamina text2video` / `image2video` / `frames2video` / `multiframe2video` / `multimodal2video` | 视频生成 | ❌ 本方案不涉及 |
| `dreamina query_result` | 查异步任务 + 下载图 | ✅ 取图（§3.3） |
| `dreamina list_task` / `user_credit` / `session` / `version` | 任务列表 / 积分 / 会话归组 / 版本 | 辅助（health 用 `user_credit`） |
| `dreamina login` / `login checklogin` / `relogin` / `logout` | 登录态管理 | ✅ 首启登录引导（§7.4） |

**关键命令实例**（raw CLI，下划线参数风格，来自 `text2image -h`/`image2image -h`/`query_result -h` 实测 2026-07-23）：

```bash
# 文生图（--resolution_type 必需；--generate_num 原生一次出多张 1-10；--poll 轮询）
dreamina text2image --prompt="..." --ratio=1:1 --resolution_type=2k --generate_num=1 --poll=30

# 图生图（续轮：--images 传 1-10 张本地参考图）
dreamina image2image --images ./prev.png --prompt="改成水彩风格" --resolution_type=2k --poll=30

# 取图下载（直接下到指定目录）
dreamina query_result --submit_id=<id> --download_dir=<库内临时目录>

# 积分自检（health 用）
dreamina user_credit
```

**参数要点（`-h` 实测）**：
- `--resolution_type`（1k/2k/4k）**必需**，非可选——Bowerbird 始终传（默认 2k）。
- `--model_version` 默认 **5.0**（支持 3.0/3.1/4.0/4.1/4.5/4.6/4.7/5.0/5.0Pro；image2image 仅 4.0+）。**v1 设想的「Seedream lite」在 dreamina CLI 不存在**（开放问题 3 据此修正）。
- `--ratio` 默认 16:9，支持 21:9/16:9/3:2/4:3/1:1/3:4/2:3/9:16 共 9 档（Bowerbird 创作板 8 档，dreamina 多一个 21:9；Bowerbird「自动」= omit `--ratio` 走默认 16:9）。
- **`--generate_num` 1-10**：dreamina **原生支持一次出多张**——比 codex 靠 prompt 驱动数量（约定 2）更可靠，即梦 provider 直接用此参数控数量（§5.3）。
- `--poll N`：submit 后**每秒轮询一次、最多 N 秒**，完成返回结果、超时 CLI 退出（保留 submit_id 事后 `query_result` 续查，§3.3）。

> 参数命名：raw CLI 用**下划线** `--resolution_type`/`--submit_id`/`--download_dir`/`--model_version`/`--generate_num`；第三方 Python wrapper 用连字符并转换。**Bowerbird 直连 raw CLI，用下划线。**

### 3.2 认证：OAuth Device Flow（v2 取代 AK/SK）

即梦走 **OAuth Device Flow**（类似 GitHub device flow），**不是 v1 设想的火山引擎 AK/SK 签名**：

```bash
# 有浏览器环境
dreamina login

# 无浏览器 / Agent 驱动（Bowerbird 首启引导用这个）
dreamina login --headless
# → stdout 输出 verification_uri / user_code / device_code
# 用户浏览器打开 verification_uri，输入 user_code 授权

# 授权完成后，用 device_code 轮询登录结果
dreamina login checklogin --device_code=<device_code> --poll=30

# 验证登录态生效（返回含余额的 JSON = 成功）
dreamina user_credit
```

- 登录态由 dreamina 自己存进 `~/.dreamina_cli/credential.json`（§3.5），**Bowerbird 不碰凭据、零存储**（v1 的凭据存储开放问题直接消解）。
- 计费走**即梦会员积分**（高级会员月 15000 积分，约 1500 元价值），`user_credit` 可查余额。与 codex 走 ChatGPT 订阅对称——都是「用户已有的订阅」，不是按量计费 API。

### 3.3 调用模式：异步任务制 + 主动下载

与 codex「同步流式出图、自动落盘」不同，dreamina 是**异步任务制**：

1. `text2image --poll N`：提交任务返回 `submit_id` + `gen_status`；`--poll N` 让 CLI **每秒轮询一次、最多 N 秒**（`-h` 实测），完成则返回结果、超时则 CLI 退出——保留 `submit_id` 事后 `query_result` 续查。
   - **stdout 直接是 JSON**（spike 实测，无需 `--json` flag）。完成时结构：
     ```json
     { "submit_id": "5138eb49-...-9dc39a727e86", "gen_status": "success",
       "result_json": { "images": [ { "image_url": "https://.../x.png?...&x-expires=...&x-signature=...", "width": 2048, "height": 2048 } ], "videos": [] },
       "queue_info": { "queue_status": "Finish", ... } }
     ```
   - ⚠️ **`image_url` 是临时签名 URL（带 `x-expires` + `x-signature`）**，会过期 → **必须及时下载入库**，不能存 URL 等以后用（过期 403）。
2. `query_result --submit_id=<id> --download_dir=<dir>`：下载图到指定目录。stdout 结构同上，但 `images[].image_url` 换成**本地 `path`**：
   ```json
   { "result_json": { "images": [ { "path": "C:\\Users\\...\\<submit_id>_image_1.png", "width": 2048, "height": 2048 } ] } }
   ```
   - **下载命名（spike 实测）**：`{submit_id}_image_{N}.png`（N 从 1 起，多张依次）；PNG；2k 的 1:1 = 2048×2048。
   - **`path` 是 OS 原生路径**（Windows 反斜杠 `C:\\...`，JSON 转义；macOS/Linux 正斜杠），Rust `PathBuf` 直接解析即可。
   - **比 codex 更可控**：直接下到 Bowerbird asset scope（`$APPDATA/**`）内，省掉 codex 那套「跑前快照 `~/.codex/generated_images/` 跑后差分」的绕法（见 [codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs) `list_new_generated`）。
3. 下载后 `ingest_generated` 入库（source="jimeng"，与 source="codex" 对称）。

**判定提交成功**（官方 SKILL.md 契约 + spike 实测）：`submit_id` 存在 **且** `gen_status ∈ {querying, success}`。`gen_status=fail` 视为失败。

**积分消耗（spike 实测，待进一步确认）**：maestro 高级会员一次 `text2image`（1 张 / 2k）后 `total_credit` **未变化**（15080→15080）—— 可能 maestro 文生图权益免费、或扣除有延迟；视频（Seedance 2.0）才显著扣分。**对 Bowerbird 图像生成场景利好**，但 UI 仍应 `user_credit` 显余额。

**无逐字流式**（与 codex `agent_message` Delta 不同）：dreamina 只有任务状态，无「看它画」过程。GenerationPanel 在即梦侧走「伪进度 Delta」（§6.3 方案 A）。

### 3.4 codex vs 即梦：能力对比（抽象层的设计依据）

| 维度 | codex（CodexCliProvider） | 即梦（DreaminaCliProvider，待建） |
|---|---|---|
| 文本对话 | ✅ | ❌ |
| 看图理解（→ caption） | ✅ | ❌（image2image 是「编辑」非「理解」） |
| 文生图 | ✅（imagegen 技能） | ✅ `text2image` |
| 图生图 / 多图组合 | ✅（弱） | ✅✅（强项，`image2image`） |
| 多轮迭代 | ✅ `codex exec resume <sid>`（原生会话上下文） | △ `image2image` 传上一轮图模拟（无上下文记忆，§5.4） |
| 流式 | ✅ JSONL Delta | ❌ 仅任务状态轮询 |
| 认证 | ChatGPT 订阅（本地 CLI auth.json） | 即梦会员 OAuth（本地 CLI credential.json） |
| 调用形态 | 子进程 spawn | 子进程 spawn（**同构**） |
| 出图机制 | 自动落 `~/.codex/generated_images/`（靠快照差分取） | `query_result --download_dir` 主动下到指定目录 |
| 计费 | ChatGPT 订阅额度 | 即梦会员积分 |
| 联网 | 走 chatgpt.com（国内偶尔 reset，自动回退 HTTPS） | 国内直连 |

**核心结论**：两者**只在「出图」维度重叠**，且都是「本地 CLI 子进程」范式。抽象层围绕「出图」建立，能力差异用 capability 标记暴露给 UI（§5.2）。**v2 关键收益：即梦 provider 实现可几乎完全复用 codex 的子进程范式，差异只在「异步任务 + 主动下载」vs「同步流式 + 快照差分」。**

### 3.5 dreamina 本地状态文件（spike 排查 / health 检测用）

`~/.dreamina_cli/` 下：

| 文件 | 用途 |
|---|---|
| `credential.json` | **登录态**（health 检测主依据，对称 codex auth.json） |
| `config.toml` | 环境配置 |
| `tasks.db` | 本地任务记录 |
| `logs/` | 运行日志 |

排查口诀（来自官方 skill 文档）：生成命令报权限/登录/环境异常 → 先查 `config.toml` 是否有效 + `dreamina user_credit` 是否能返回余额 JSON。

### 3.6 spike 验证项（Phase 0，2026-07-23 本机实测 Win11）

1. ✅ **参数契约 + stdout JSON 结构**：`text2image -h` 拿到全部参数（§3.1）；实测 `text2image --poll` stdout 直接是 JSON（无 `--json` flag），`submit_id`(UUID)/`gen_status`/`result_json.images[].image_url` 结构见 §3.3。
2. ✅ **`--poll` 超时续接**：每秒轮询、最多 N 秒、超时 fall back 手动 `query_result --submit_id`（`-h` + 实测）。
3. ✅ **`query_result --download_dir`**：下载到指定目录，命名 `{submit_id}_image_{N}.png`，PNG，`images[].path` 给本地 OS 路径（§3.3）。
4. ✅ **登录**：`dreamina login` OAuth 跑通，`user_credit` 返回 `{total_credit, user_id, vip_level}` JSON = 登录态生效。headless 字段（verification_uri/user_code/device_code）以 `-h` 为准（本次用非 headless）。
5. ⏳ **Windows GUI spawn**：命令行已证二进制可用；Tauri GUI 进程 spawn 的 PATH 问题由 `resolve_dreamina_binary` 主动查 `%USERPROFILE%\bin` 解决（§5.3），留实现时验证。
6. ⏳ **积分消耗**：maestro 本次未扣分（见 §3.3，待进一步确认是免费权益还是延迟）。
7. ⏳ **`AigcComplianceConfirmationRequired`**：本次 5.0 模型未触发；实现时识别为「需用户网页确认」而非重试。

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

    /// 可用性检测（codex=CLI+auth.json；即梦=CLI+credential.json 或 user_credit ping）。
    async fn health(&self) -> Health;
}

#[derive(Clone, Copy)]
pub struct Capabilities { pub chat: bool, pub caption: bool, pub generate: bool }
```

- **会话句柄**：codex 的 `session_id` 是 codex 自管的 UUID；即梦无原生会话上下文，需 Bowerbird 自己造一个「逻辑会话」（见 §5.4）。trait 层用 `Option<&str>` 统一，语义按 provider 解释。

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
    ratio: Option<String>,
    provider: Option<String>,         // 新增；None → 用全局默认
) -> Result<(), AppError>
```

- provider 解析：`None` / `"default"` → 读全局默认配置；`"codex"` / `"jimeng"` → 对应实现。
- 命令层不关心具体 provider，只 `match provider { "codex" => ..., "jimeng" => ... }` 取 trait object 后调 `generate_image`。
- **ratio 透传按 provider 分流**：codex 走 instruction 文本注入（现状，`codex_create_image` 已实现）；即梦走 `--ratio` 参数（§5.3）。

### 5.3 即梦 provider 实现（新建 [codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs)）—— v2 重写

v2 不再用 `reqwest` + 火山引擎签名，改为**与 CodexCliProvider 同构的子进程 spawn**：

```rust
pub struct DreaminaCliProvider {
    pub binary: String,   // resolve_dreamina_binary()，默认 "dreamina"
    pub enabled: bool,
}
```

**`generate_image` 流程**（对照 codex 的差异点已标出）：

```
1. spawn dreamina text2image --prompt=<P> --ratio=<R> --resolution_type=2k --poll=<N>
   （图生图/续轮：dreamina image2image --images=<上一轮图> --prompt=<修改意见> --poll N）
   ※ Windows 经 resolve_dreamina_binary 找 %USERPROFILE%\bin\dreamina.exe，CREATE_NO_WINDOW 防黑窗
2. 逐行读 stdout → 解析 JSON → 拿 submit_id；gen_status ∈ {querying,success} = 提交成功
   ※ 把「即梦生成中…」推 Chunk::Delta（伪进度，§6.3 方案 A）
3. query_result --submit_id=<id> --download_dir=<asset scope 内临时目录>
   ※ 不需要 codex 那套「跑前快照 generated_images 跑后差分」——dreamina 直接下到指定目录
4. download_dir 里的图 → ingest_generated（source="jimeng"，与 source="codex" 对称）
5. Chunk::Done { images }
```

**二进制解析**（对称 [codex_cli.rs:425](apps/desktop/src-tauri/src/codex/codex_cli.rs#L425) `resolve_codex_binary`）：

```rust
pub(crate) fn resolve_dreamina_binary() -> Option<String> {
    // BOWERBIRD_DREAMINA_BINARY env 显式覆盖 →
    //   Windows: %USERPROFILE%\bin\dreamina.exe  → PATH
    //   Unix:    ~/.local/bin/dreamina           → PATH
}
```

**子进程构造**（对称 `codex_command`，但更简单）：

```rust
pub(crate) fn dreamina_command(binary: &str) -> Command {
    // dreamina 是原生二进制（非 npm .cmd/.bat shim）→ 不需要 codex_command 那套 cmd.exe /D /S /C 包装
    // 仍需 CREATE_NO_WINDOW（0x08000000）防 GUI release 弹黑窗（Windows）
    // Unix 直接 Command::new(binary)
}
```

**Windows 适配（比 codex 更省心）**：dreamina 是**原生 .exe**，没有 codex 那套 npm `.cmd`/`.bat` shim 的 `CreateProcess` 不解析 PATHEXT 问题（见踩坑「dev 在 Windows 检测不到 codex」）。但仍要注意：安装脚本用 PowerShell 把 `%USERPROFILE%\bin` 加进 **User PATH**，GUI 应用要重启才生效——所以 `resolve_dreamina_binary` 必须主动查 `%USERPROFILE%\bin\dreamina.exe`，不能只依赖 PATH。

**多轮模拟**：见 §5.4。复用 [ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs) `ingest_generated` 入库，`source="jimeng"`（与 `source="codex"` 对称，瀑布流角标 / 智能筛选 `source:jimeng` 自动可用）。

### 5.4 即梦的「多轮会话」如何落地

即梦无原生会话上下文（`dreamina session` 只是本地任务归组，**不是模型记得对话**），Bowerbird 自己拼：

- 首轮：文生图（纯 prompt）。
- 续轮：取上一轮产出图（store_path）→ 作为参考图走 **`image2image --images`**，prompt = 用户修改意见。
- 「会话句柄」= 本地维护的「上一轮图 asset_id」（存内存或 `generation_meta`，不必新表）。
- 这样 GenerationPanel 的「提修改意见续轮」在即梦侧等价可用——用户体感与 codex resume 一致，底层实现不同（风险：即梦只看上一张图、不记前几轮意图，见 §10）。

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

`startGeneration(prompt, refs, ratio?, provider?)`、`sendGenRevise(instruction)` 透传 provider；续轮时若与首轮 provider 冲突（如 codex 会话想切即梦）UI 应禁用并提示。

### 6.2 GenerationPanel UI（[GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx)）

顶部 header 加 provider 切换条：

```
🖼 生成结果 · 3 轮 · 4 图          [ codex ▼ ]  ✕
```

- 下拉项：`codex`（始终可选，就绪时）/ `jimeng`（dreamina 装好且已登录后可选）。
- 续轮中（`genSessionId` 非空 / 即梦有参考图链）：切换条**置灰** + tooltip「续轮沿用首轮 provider」。
- 每 turn 角标小字标 provider（`via codex` / `via 即梦`），让用户清楚每张图谁出的。

### 6.3 流式体验差异的统一

- **codex**：`codex://chunk` 的 `Delta` 照旧逐字流式（genStreaming 区）。
- **即梦**：无 Delta。两种选择：
  - **(A)** 不推 Delta，只在轮询中推 `Delta{ "[即梦] 生成中…" }` 之类的状态文本（简单，体验接近「等图」）。
  - **(B)** 后端把轮询进度映射成 Delta（更生动，但 dreamina 是否暴露进度需 spike）。
- 倾向 **(A)** 起步，体验不足再升级。

### 6.4 api 层（[lib/api.ts](apps/desktop/src/lib/api.ts)）

`codexCreateImage` 加 `provider` 参数（或新增 `createImage` 别名，旧名保留兼容）：

```ts
createImage: (req: { prompt; referenceImages; sessionId?; ratio?; provider? }) =>
  invoke<void>("create_image", { ...req, provider: req.provider ?? null });
```

`CodexHealth` 泛化为 provider 健康数组，或加 `jimengHealth`：UI 据各 provider 健康决定下拉项是否可选（约定 7 降级置灰的延伸）。

---

## 7. 配置与认证（v2 大幅简化：dreamina 自管登录态，零凭据存储）

### 7.1 配置入口

[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 已挂载（Toolbar ⚙），直接加一个 section。**v2 取代 v1 的 AK/SK 输入框**——改为「登录状态 + 重新登录 + 积分余额」：

```
设置
├─ 环境状态（codex）                ← 已有
├─ AI 出图引擎（新增）
│   ├─ 默认 provider：[ codex ▼ ]   ← 全局默认（§4.2）
│   └─ 即梦（dreamina CLI）
│       ├─ 状态：未安装 / 未登录 / 已登录（余额 N 积分）
│       ├─ [ 安装 dreamina CLI ]     ← 跑 curl 安装脚本（或给指引）
│       ├─ [ 登录即梦账号 ]          ← 触发 dreamina login --headless（§7.4）
│       └─ 模型：[ 即梦 4.0 ▼ ]      ← --model-version
├─ 重建色板                         ← 已有
└─ 智能归类全部                     ← 已有
```

### 7.2 凭据存储：不存（v2 关键简化）

**v1 曾在此节纠结「明文 JSON vs OS keychain」**（开放问题 4）——**v2 整体删除**。原因：dreamina 自己把登录态存进 `~/.dreamina_cli/credential.json`（OAuth token），Bowerbird **完全不碰凭据、零持久化**，与 codex 处理 auth.json 的方式完全一致（codex 的登录态也是 codex CLI 自管，Bowerbird 从不存储）。

- 好处：不新增持久化层、不引入 keyring 依赖、无凭据泄露面。
- 代价：卸载 Bowerbird 不会清 dreamina 登录态（与 codex 同理，可接受）。

### 7.3 后端配置模块：删（v2 取消 v1 的 `core/provider_config.rs`）

v1 曾规划新建 `core/provider_config.rs` 读写凭据 JSON + `get_provider_config`/`set_provider_config` 命令——**v2 全部不需要**（无凭据可存）。改为：

- `dreamina_health` 命令：检测 dreamina 二进制 + `~/.dreamina_cli/credential.json` + 可选 `dreamina user_credit` ping（§7.5）。
- `dreamina_login` 命令：spawn `dreamina login --headless`，把 OAuth 授权材料（verification_uri/user_code/device_code）流式推给前端引导（§7.4）。
- 默认 provider 的存储：仅一个字符串（`"codex"`/`"jimeng"`），与现有「项目零 zustand persist」一致——照 AssetDetail 范式存 `localStorage`（`bowerbird.defaultProvider`），不入库、不需后端命令。

### 7.4 即梦登录引导（唯一比 codex 复杂的新 UI）

codex 登录是 `codex login` 跳浏览器完事；dreamina `login --headless` 是 OAuth Device Flow，需在 app 内展示授权材料。方案：仿 [CodexOnboarding.tsx](apps/desktop/src/components/CodexOnboarding.tsx)（约定 13 全屏 Modal）做一个 dreamina 登录流程：

1. 检测 dreamina 未登录 → 弹引导。
2. 点「登录」→ 后端 spawn `dreamina login --headless` → stdout 解析出 `verification_uri` + `user_code` + `device_code` → Modal 内展示（一个可点链接 + 一串短码 + 「打开浏览器输入此码」）。
3. 用户浏览器授权后 → 后端 `dreamina login checklogin --device_code=<code> --poll=30` → 成功则 `dreamina user_credit` 取余额 → 关 Modal。
4. `AigcComplianceConfirmationRequired` → 提示「需在即梦网页完成一次合规确认」。

> **首版兜底**：也可让用户自己在终端 `dreamina login`（最省事），app 只检测 `credential.json` + `user_credit` 登录态——与 codex onboarding 早期做法一致，in-app OAuth 引导后续再补。

### 7.5 dreamina_health 检测（对称 codex_health）

照 [codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_health`（查二进制 + auth.json）对称写：

```rust
pub async fn dreamina_health(...) -> Health {
    // 1. 二进制存在 → resolve_dreamina_binary().is_some()
    //    否则 reason = "未安装 dreamina CLI（运行 curl -s https://jimeng.jianying.com/cli | bash）"
    // 2. 登录态 → ~/.dreamina_cli/credential.json 存在
    //    否则 reason = "未登录（运行 dreamina login）"
    // 3. 可选 ping → spawn dreamina user_credit，返回 JSON = token 有效
    //    失败 reason = "登录态可能过期，请 dreamina relogin"
}
```

未就绪时按约定 7 置灰生成按钮 + 显 reason（跟 codex 一致）。

---

## 8. 关键约定 1 的演进（定稿后同步 PROJECT.md）

**现行（[PROJECT.md](PROJECT.md) 关键约定 1）**：

> AI 全外包，不自建模型：所有理解/分析与图像生成均走 headless codex 子进程…禁止…HTTP 路线…Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线均已全部移除。

**演进为（v2，比 v1 更纯粹）**：

> AI 全外包，不自建模型。**理解类**（反推 caption / 命名 / 归类）仍走 codex CLI（ChatGPT 订阅，真正看图）。**图像生成（⑥）** 改为多 provider 可切换：codex CLI（默认）/ 即梦（官方 **dreamina CLI**，与 codex 同构的本地子进程，作为 codex 的降级备选，见 [PRICING.md](PRICING.md) 风险 4）。provider 抽象为 `GenProvider` trait，按 capability 暴露；禁止的仍是「自建 / 本地模型」（ONNX / CLIP / 本地扩散 / tesseract / 向量）。

**v2 vs v1 差异**：v1 演进文本写的是「即梦（火山引擎 HTTP API）」，会为即梦开口子允许 HTTP 路线；**v2 改成「即梦 dreamina CLI」后，所有 provider 都是本地子进程，连 HTTP 口子都不用开**——约定 1 的「禁止 HTTP 路线」精神完整保留，只是「唯一 codex」变「codex + 即梦两个 CLI」。

**注**：约定 1 移除「Mock/ClaudeCode/DeepSeek/OpenAI HTTP」那句的历史语境（当年是为「看图」选路），不影响本方案——那些路线是「理解类看图」的失败备选，本方案加的即梦是「生成类出图」的备选，正交。

---

## 9. 落地路线图（v2：Phase 0 改为 CLI spike）

> 每个阶段都可独立验证、可回退。**Phase 0 必须先做**（仿项目「多模态看图四条路径实测」传统，dreamina CLI 虽调研清楚，本机链路仍有未知）。

### Phase 0 · spike dreamina CLI 调通 ✅（2026-07-23 完成，Win11 + maestro 会员）

- 目标：本机装 dreamina、登录、跑通一次 `text2image --poll` + `query_result --download_dir`，图下载到本地。
- 验证项（对应 §3.6）：① `text2image` stdout JSON 结构 + submit_id/gen_status 字段；② `--poll` 超时续接策略；③ `query_result` 下载图格式/命名；④ `login --headless` OAuth 字段；⑤ Windows `%USERPROFILE%\bin\dreamina.exe` 能否被 GUI 进程 spawn；⑥ 积分消耗；⑦ `AigcComplianceConfirmationRequired` 处理。
- **结果**：①②③④ 通过（stdout 直接 JSON、`{submit_id}_image_N.png` 下载、OAuth 登录 + `user_credit` 验证）；⑤⑥⑦ 留实现时验证（Windows GUI spawn / 积分是否延迟扣 / 合规确认）。详见 §3.3/§3.6。
- **门槛已过**：进 Phase 1。回退到火山引擎 HTTP API（v1）的保底路线无需启用。

### Phase 1 · provider 抽象重构（行为不变，纯解耦）

- `CodexProvider` → `GenProvider` trait（§5.1），`generate_image` 提到 trait。
- 命令层 `codex_create_image` 加 `provider` 参数，**默认仍 codex、行为零变化**。
- 加 `Capabilities` / `health`。
- 验证：`cargo test` 全绿；现有生成 / 反推 / 回看行为完全不变（回归）。

### Phase 2 · 即梦 provider 实现

- 新建 `codex/jimeng.rs`（§5.3），实现 `GenProvider`——spawn dreamina 子进程。
- 多轮模拟（§5.4）、`source="jimeng"` 入库、`generation_meta.provider` 落库（§5.5）。
- `dreamina_health` / `dreamina_login` 命令（§7.3/7.5）。
- 验证：后端单测 + 一次端到端即梦生成（首轮 + 续轮）。

### Phase 3 · 前端切换 UI + 配置

- store `defaultProvider` / `activeGenProvider`（§6.1）。
- GenerationPanel 顶部 provider 切换条（§6.2）。
- SettingsDialog 即梦配置区 + 默认 provider（§7.1）。
- dreamina 登录引导（§7.4）。
- 验证：创作板发送 → 选即梦 → 出图 → 提修改 → 续轮 → 入库 → 回看，全链路。

### Phase 4 · 文档与约定收尾

- 本方案定稿（修正 spike 发现）。
- PROJECT.md 关键约定 1 演进（§8）+「目前进展」加条目。
- CLAUDE.md 索引已含本文档（补「何时读」）。

---

## 10. 风险与提醒（v2 增删）

1. **即梦付费 / 积分**：dreamina 走即梦会员积分（与 codex 走用户 ChatGPT 订阅不同——即梦积分是用户自己的会员额度）。用户用即梦 = 消耗自己的即梦积分。UI 应明示余额 + 「即梦调用消耗即梦会员积分」，并考虑与 [PRICING.md](PRICING.md) 付费墙的关系（后续单独定，本方案不锁）。

2. **多轮体验打折**：即梦靠 `image2image` 传上一轮图模拟多轮，**不如 codex resume 那样记得完整对话上下文**（codex 记得前几轮所有修改意图，即梦只看上一张图）。复杂迭代场景即梦可能「失忆」，续轮切即梦时 tooltip 提示「即梦仅参考上一张图」（§6.2）。

3. **流式体验断层**：即梦无逐字流式，GenerationPanel 的 genStreaming 区在即梦侧会「空等 → 突然出图」，与 codex 的「看它画」体验不同（§6.3）。

4. ~~**凭据安全**（v1 风险 4，v2 删除）~~：dreamina 自管 `credential.json`，Bowerbird 零凭据存储（§7.2），此风险消除。

5. **dreamina CLI 仍是 beta**（v2 新增）：二进制源 `dreamina_cli_beta`，命令/输出契约可能变。以 `dreamina -h` 为最终事实源（官方 SKILL.md 明示）；版本锁死 + spike 记下所用版本。

6. **headless 登录交互**（v2 新增）：OAuth Device Flow 比 codex login 复杂，in-app 引导（§7.4）做不好会卡在登录这一步。首版可让用户终端登录兜底。

7. **provider 健康与降级**：codex 不可用 + 即梦未配置 = 生成完全瘫痪（比单 codex 更脆）。约定 7 的「置灰 + 提示」需覆盖「所有 provider 都不可用」的场景。

8. **Windows PATH 生效**（v2 新增）：dreamina 装到 `%USERPROFILE%\bin`，安装脚本加的是 User PATH、GUI 应用重启才生效。`resolve_dreamina_binary` 必须主动查该目录，不能只靠 PATH（同 codex 踩坑教训）。

---

## 11. 开放问题（需后续拍板，v2 更新）

| # | 问题 | 倾向 |
|---|---|---|
| 1 | 命令是否从 `codex_create_image` 改名为 `create_image`？ | 改名更准确，但破坏前端 api 与历史调用；倾向**加新名 `create_image`，旧名保留为 codex 别名**，迁移完再删 |
| 2 | ~~即梦认证走方舟 API Key 还是火山 AK/SK？~~（v2 消解） | **都不用**——走 dreamina CLI OAuth Device Flow（§3.2），无签名 |
| 3 | 即梦首选 `--model_version`？ | ✅ 默认 **5.0**（`-h` 实测，支持 3.0/3.1/4.0/4.1/4.5/4.6/4.7/5.0/5.0Pro；v1 设想的「Seedream lite」在 dreamina CLI 不存在）；Bowerbird 用默认 5.0 起步，质量不足再升 5.0Pro |
| 4 | ~~凭据存储明文 JSON vs keychain？~~（v2 消解） | **不存**——dreamina 自管 credential.json（§7.2） |
| 5 | 即梦多轮失忆是否给 UI 提示？ | **是**，续轮切换即梦时 tooltip 提示「即梦仅参考上一张图」 |
| 6 | 即梦是否纳入 Pro 付费墙？ | **本方案不锁**，留商业化决策（见 [PRICING.md](PRICING.md) §4） |
| 7 | trait 改名 `CodexProvider` → `GenProvider` 还是保留旧名？ | 倾向**改名**（语义已超出 codex），用 `type CodexProvider = GenProvider` 过渡 |
| 8 | dreamina 登录首版做 in-app OAuth 引导还是终端兜底？ | 倾向**首版终端兜底**（检测 credential.json + user_credit），in-app 引导（§7.4）Phase 3 再做 |

---

## 附：关键决策记录

| 日期 | 决策 |
|---|---|
| 2026-07-18 | 首版方案草案（v1）：泛化 GenerationPanel + 全局默认/单次覆盖 + codex/即梦首批；理解类仍只走 codex；即梦走火山引擎 HTTP API；待 spike 后定稿。 |
| 2026-07-23 | v2 修订：即梦官方推出 CLI（`dreamina`，单二进制 + OAuth 登录 + 积分制），接入路线**整体从火山引擎 HTTP API 改为官方 dreamina CLI**（与 codex 同构子进程）。消解签名实现（开放问题 2）、凭据存储（开放问题 4）两个老大难；关键约定 1 演进更纯粹（所有 provider 都是 CLI，不开 HTTP 口子）。命令面/登录/状态文件已调研清楚（§3），Phase 0 改为 dreamina CLI 本机 spike。 |
| 2026-07-23 | Phase 0 spike 通过（Win11 + maestro）：`text2image --poll` + `query_result --download_dir` 全链路实测跑通；stdout 直接 JSON、下载 `{submit_id}_image_N.png`、OAuth 登录 + `user_credit` 验证。maestro 文生图本次未扣分（待确认是免费权益还是延迟）。详见 §3.3/§3.6，进 Phase 1。 |
