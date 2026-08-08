# Bowerbird 生成能力「服务器化」可行性研究报告

> 日期：2026-08-07 · 状态：研究报告（非实现方案）
> 目的：回答两个问题——
> **①** 在自有网络服务器部署 codex CLI + dreamina CLI，应用端改调服务器 API，是否可行？
> **②** 把 Bowerbird 全面改为「通过 API 调用」生图/生视频的模式，是否可行？
> 关联：本文是对 [AI-PROVIDERS.md](AI-PROVIDERS.md)（provider 抽象）、[VIDEO-GENERATION.md](VIDEO-GENERATION.md)（并行+视频）、[PRICING.md](PRICING.md)（风险 4 codex 单一供应商）在「远程化」方向上的延伸调研。三方在线调研（2026-08-07）+ 源码改造面评估。

---

## TL;DR（结论先行）

| 问题 | 结论 |
|---|---|
| **① 服务器部署 CLI + 客户端调 API** | **技术上完全可行**（两个 CLI 都官方支持 Linux/无头），**合规上是最大风险**，**架构上是重复造轮子**。 |
| **② Bowerbird 全面改 API 调用** | **可行，且有一条比「套壳 CLI」更优的正道**——火山方舟官方 API（Seedream 生图 + Seedance 生视频），本仓库官网 [server.mjs](website/server.mjs) 已实证跑通。 |
| **一句话建议** | 「服务器跑 CLI 套壳」只适合**个人自用、单一自有账号**的降级通道；规模化/商业化应走**官方 API**（方舟按量 / 用户自带 key），而不是把订阅/积分账号搬到服务器上代理。 |

**关键洞察（回答你上一会话「无法套壳 codex cli 生图」为何卡住）**：之前卡住的是「**在 Bowerbird 应用进程内**把 codex CLI 当黑盒驱动」的技术细节（取图快照差分、JSONL 解析等），不是「codex 能否被远程调用」。实际上 codex 官方**原生支持** headless/无头 + Docker + token 跨机复制，甚至有官方 `codex app-server` 服务形态。真正卡死「服务器套壳」的是**账号/TOS/配额**这层，不是技术。

---

## 1. 现状盘点：Bowerbird 的生成链路长什么样

改造前先摸清现状（源码确认）：

```
创作板 / 反推 / 自动命名 / 归类
   ↓  prompt + 参考图(store_path)
[Tauri 前端 store.ts]  startGeneration / sendGenRevise
   ↓  invoke
[commands/codex.rs]  codex_create_image(job_id, provider, ...)
   ↓  resolve_gen_provider(provider)  ← GenProvider trait（codex/jimeng 两实现）
[GenProvider::generate_image]
   ├─ CodexCliProvider  spawn `codex exec --json --image ...`  → 快照差分取 ~/.codex/generated_images/
   └─ DreaminaCliProvider  spawn `dreamina text2image|image2video` → query_result 下载 → 临时目录
   ↓  Chunk{Submit/Delta/Done/Error} 经 codex://chunk 事件回前端
[generation_worker::finalize_generation_assets]  ingest 入库 + generation_meta + caption + 命名
```

**关键点**：
- 所有 AI 调用都是**本地子进程**（`spawn`），关键约定 1「AI 全外包给 CLI」的精神就是「**不开 HTTP 口子**」。
- 即梦已依赖异步任务制（`submit_id` + `query_result` 轮询）+ 并发=1 串行队列 + 持久化恢复——**这套「异步任务 + 轮询 + 队列」恰好就是官方 HTTP API 的同构模型**（见 §4）。
- 参考图是本地文件路径，改远程后需处理「参考图如何上传到服务器」（图生图场景必需）。

---

## 2. 问题①：服务器部署 CLI 套壳，可行性三维分析

### 2.1 技术可行性 —— ✅ 高，两个 CLI 都官方支持无头/服务器运行

**Codex CLI（OpenAI）**：
- `codex exec` **官方就是非交互无头命令**（官方文档标题「Run Codex non-interactively for automation and CI/CD」），支持 `--json`、stdin 输入、`-i/--images` 传图参数、`--sandbox` 沙箱策略——正是 Bowerbird 生图所需。
- 官方认证文档专门有「Authenticate locally and copy your credentials to the headless machine」一节：**`auth.json` 明确「is not tied to a specific host」**，可直接 `scp`/`docker cp` 到远程无头机；也支持 SSH 端口转发回环完成 OAuth 登录。
- **官方 `codex app-server`**：把 codex 以 JSON-RPC 2.0 暴露为服务器（`stdio://` / `ws://IP:PORT` / unix socket），提供 `thread/start`、`turn/start` 等 API，官方博客明确推荐用于「product integration」。**这是比「自包 HTTP」更优的正解**（原生多客户端、沙箱、流式、恢复会话），但注意：WebSocket 传输官方标注「experimental」，协议是 JSON-RPC 不是 REST。
- Docker 里跑 codex headless 是社区主流（`Z7Lab/codex-sandbox` 等）。

**即梦 dreamina CLI（字节）**：
- 官方安装脚本 `detect_platform()` 明确支持 **Linux x86_64 / arm64**，`curl | bash` 纯脚本无 GUI 依赖，VPS/ECS 直接可装（本报告直接抓取脚本验证）。
- 官方 **OAuth Device Flow**，`dreamina login --headless` 打印 `verification_uri/user_code/device_code` 后退出，`checklogin --device_code=...` 补完——**无浏览器服务器可登录**（正是 Bowerbird 踩过的 `isatty` 坑的正解）。
- 登录态存 `~/.dreamina_cli/credential.json` + config.toml，**可抽取、可跨机复用**（社区 token 池工具已证实）。
- 社区已有大量同构先例：iptag/jimeng-api、jimeng-cli、dreamina-free-api 等都把即梦能力封装成 HTTP 服务。

**结论**：把两个 CLI 搬到服务器再包一层 HTTP，**技术上没有障碍**。真正的问题是下面两节。

### 2.2 账号 / TOS 合规性 —— ⚠️ 最大风险，分场景判死刑

**Codex（OpenAI）**：
- OpenAI ROW Terms of Use 原文（2026-03 版）：**「You may not share your account credentials or make your account available to anyone else」**——**一个订阅多人共享 = 明确违反条款**。
- OpenAI Help Center 有专门「Account Sharing Policy」文章。
- EU ToU 禁止「程序化提取数据/输出」——批量转售/代理落在射程内（边界模糊，因官方 CLI 本身即程序化工具）。
- 社区经验（非官方确认）：数据中心 IP 高频直连 chatgpt.com 有流量特征风控风险；token 多端互斥（refresh 轮换会互相挤兑掉线）。

**即梦（字节）**：
- 未抓到《用户协议》原文（需登录），但**几乎可以确定禁止非个人使用/转售**：C 端账号协议普遍禁止转让/转售/共享；所有逆向项目（jimeng-api 等）一致声明「仅供个人学习研究、禁止商用」，即官方口径明确。
- 社区灰产生态（批量注册、多账号池、代理管理）的存在反证该行为风险自担、会封号。
- 会员制本质是「低并发、低成本」的零售方案，规模化就要多账号池轮换——那是灰产路线。

**分场景判定**：

| 场景 | 判定 |
|---|---|
| **你自己的订阅 + 你自己的服务器 + 你自己的 Bowerbird**（个人自用） | 灰色地带，**接近合规**，执行层风险（IP 风控、token 互斥）大于条款风险 |
| **多个用户共享一个订阅**（服务器统一鉴权） | **明确违反条款**（账号共享禁止），封号风险高 |
| **转售/代理给第三方**（商业化 SaaS） | **高风险**，落入程序化提取条款 + 账号共享叠加；OpenAI 的合规轨道是 API key 计费 / Compliance Logs 登记 |

### 2.3 规模化 / 并发 —— ⚠️ 配额是天花板，不是算力

**Codex**：基于**消息配额**（5 小时窗口 + 周限额，非 token 数）。单订阅无法支撑有意义的并发——同订阅并发快速耗尽配额 → 429。规模化必须多订阅轮换 → 账号风控暴露面抬高。

**即梦**：**视频同账号并发=1 是实测硬约束**（Bowerbird spike 实证 `ExceedConcurrencyLimit`），图片宽松但无官方明文。服务器端也得串行队列，吞吐天花板=单账号视频产能；要多并发只能多账号池（灰产）。

**结论**：**服务器套壳 CLI 的天花板不是服务器性能，而是订阅/积分配额**。这决定了它只适合「低并发个人自用」，撑不起商业产品。

### 2.4 问题① 小结

> **服务器部署 CLI 套壳「可以跑，但不该作为主力路线」**：
> - 技术可行 ✅（官方支持无头/服务器/Linux）
> - 合规风险集中（多用户共享 = 违反 TOS；个人自用 = 灰色）
> - 并发/规模天花板 = 单订阅配额，无法支撑商业多用户
> - **更关键**：它是一条「重复造轮子」的路——CLI 背后本来就是 HTTP API，套壳等于绕一圈，还背上登录态维护（token 刷新/掉线）、进程管理、服务器运维的负担。

---

## 3. 问题②：Bowerbird 全面改 API 调用，可行性

### 3.1 核心发现：官方 API 比「套壳 CLI」更优，且仓库已有实证

本仓库官网 [server.mjs](website/server.mjs) 已经实现并部署了一条「**服务器端调官方 HTTP API → 客户端调用**」的完整链路：

- **火山方舟 Seedream**：`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`（`Bearer` key，`b64_json` 返回）——国内直连、按量计费。
- **BFL FLUX**：`api.bfl.ai` 异步任务 + 轮询。

也就是说，**「通过 API 生图」这条路 Bowerbird 生态已经证明可行**（至少图片侧），缺的只是「把它从官网迁回桌面端做正式 provider」。

### 3.2 官方 API 的成熟度（2026-08 现状）

**图像 —— 火山方舟 Seedream 系列**：
- Seedream 5.0 Pro 企业 API（2026-07-08 上线）：输出 ≤236 万像素 **0.3 元/张**，高清 **0.6 元/张**，输入参考图 0.02 元/张。
- Seedream 4.0：新用户 200 张免费，之后 **约 0.2 元/张**。
- **支持图生图 / 多图融合（≤10 张参考图）**——正好覆盖 Bowerbird 创作板的「参考图 → 出图」核心场景。
- **国内直连无需 VPN**。

**视频 —— 火山方舟 Seedance 系列**：
- Seedance 2.0 mini：**约 0.5 元/秒**（较 2.0 降 50%）；支持文生视频、图生视频（首/尾帧）、最多 9 参考图 + 3 段参考视频 + 3 段参考音频。
- **异步任务制**（提交 task → 轮询/查询结果，有任务 ID 与状态机）——**与 Bowerbird 现有「多 job + submit_id 持久化 + 启动恢复」架构高度同构**，改造成本极低。

**OpenAI gpt-image-1**：
- 按 token 计费（约 $0.02~0.19/张），**国内不可直连**，需海外链路；**ChatGPT 订阅不含 API 额度**。仅适合海外/高质量场景。

### 3.3 关键：即梦会员积分 ≠ 官方 API

**重要概念澄清**：
- **dreamina CLI 走「即梦会员积分」**（固定月费买积分，视频扣分、图片 maestro 免费），底层调的是即梦官网/内部接口。
- **火山方舟 API 走「按量人民币」**（0.2~0.3 元/张、0.5 元/秒）。
- 二者是**同一模型底座（Seedream/Seedance）的两条不同计费通道**，能力基本对齐（方舟版模型更新、并发更高）。
- **「把用户积分换成官方 API」在计费上不成立**——官方 API 只认人民币，不认会员积分。

> 这引出一个**产品决策问题**（不在本报告范围，但必须点出）：如果 Bowerbird 改官方 API，生图成本从「用户已有的订阅/积分（看似免费）」变成「按张付费」——这笔账是产品定价问题（谁出钱），不是技术问题。详见 [PRICING.md](PRICING.md)。

### 3.4 合规性对比：官方 API 反而是最合规的路

| 路线 | 合规性 |
|---|---|
| **官方 API 直连（用户自己 org key）** | ✅ 最合规。用户用自己的 API key 调自己的额度，是官方标准形态 |
| **官方 API + 自建薄代理（key 收在服务端）** | ✅ 基本合规（「在你的产品中调用供最终用户使用」），但禁止转售 key / 对外卖 API 访问权 |
| **服务器跑 CLI 套壳（订阅/积分账号）** | ⚠️ 多用户共享明确违反 TOS；个人自用灰色 |

- 方舟豆包协议：授权**不可转让/转售/分许可**；但「在自己的产品中调用以供最终用户使用」是允许的——薄代理自用即此范畴。
- OpenAI：禁止卖/转让 key、共享订阅；**用自己 org key 自建产品合规**。
- **算法备案**：若 Bowerbird 成为「面向公众提供生成式 AI 服务」需安全评估/备案——这取决于产品形态与运营者，需单独评估（桌面本地应用通常风险较低，但若做远程服务则要过）。

### 3.5 问题② 小结

> **Bowerbird 全面改 API 调用：可行，且有明确的推荐路线**——
> - **图片**：火山方舟 Seedream（国内直连、按张 0.2~0.3 元、图生图成熟）
> - **视频**：火山方舟 Seedance（异步任务制与现有架构同构）
> - **理解类**（反推/命名/归类）：仍走本地 codex CLI（或 OpenAI API），因为即梦/方舟的 Seedream 无文本理解能力
> - **合规性反而是加分项**（官方 API = 用户自己 key = 最标准）
> - **代价**：引入「按张/按秒付费」+ 需要处理参考图上传 + key 管理

---

## 4. 改造面评估：从「本地 CLI 子进程」改为「HTTP API 调用」

假设采用推荐路线（桌面端新增 `GenProvider` 的 HTTP 实现，替代/并存本地 CLI），改造面如下。

### 4.1 后端改动（Rust，改动集中、可复用现有抽象）

**改动核心集中在 `GenProvider` trait 的实现层**，上游抽象（trait / 命令 / 队列 / 恢复）几乎不用动：

| 文件 | 改动 | 规模 |
|---|---|---|
| [codex/mod.rs](apps/desktop/src-tauri/src/codex/mod.rs) | `resolve_gen_provider` 加新 provider 分支（如 `"volc"`/`"api"`），返回 HTTP provider | 小 |
| 新建 [codex/http_api.rs](apps/desktop/src-tauri/src/codex/http_api.rs) | 新 `HttpApiProvider` 实现 `GenProvider::generate_image`：`reqwest` 调方舟 API（b64_json）→ 落临时文件 → 返回 `GenOutcome`。**复用 `openai_api.rs` 的 reqwest 范式** | 中（~200 行） |
| [codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs) | 可选保留（本地 CLI 降级通道）；视频命令映射逻辑可抽给 HTTP provider 复用 | 小 |
| [codex/types.rs](apps/desktop/src-tauri/src/codex/types.rs) | `GenOutcome` 已兼容（`source_images` + `temp_dir`）；`CodexRequest.reference_images` 需支持**从 store_path 读字节 → base64 上传** | 小 |
| [generation_worker.rs](apps/desktop/src-tauri/src/core/generation_worker.rs) | `finalize_generation_assets` 已 provider 无关，零改动 | 零 |
| [task_queue.rs](apps/desktop/src-tauri/src/core/task_queue.rs) | 零改动（`GenJob` 已有 `provider` 字段） | 零 |

**关键复用点**：
- `GenProvider` trait 抽象得干净，**换实现 = 加一个 struct**，命令层/队列/恢复/前端全部不动。
- 方舟 Seedance 的异步任务制与 Bowerbird 已有的「submit_id 持久化 + 轮询 + 启动恢复」**同构**——`poll_query_and_download` 的轮询循环可类比复用。
- reqwest 已有先例（[openai_api.rs](apps/desktop/src-tauri/src/codex/openai_api.rs) 已验证 b64_json 落盘 + [ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs) 的 reqwest Client）。

### 4.2 前端改动（小，基本是配置/设置面）

| 文件 | 改动 | 规模 |
|---|---|---|
| [lib/api.ts](apps/desktop/src/lib/api.ts) | `codexCreateImage` 已带 `provider` 参数，透传即可 | 零/极小 |
| [store.ts](apps/desktop/src/store.ts) | 已按 `provider` 分发；新增 provider 的 health/登录态字段 | 小 |
| [settings/onboarding](apps/desktop/src/components/SettingsDialog.tsx) | 新增「API provider 配置」（key 输入 / 或服务器代理地址） | 小 |
| GenerationPanel / ProviderSelect | 已按 provider 渲染，加一个选项即可 | 极小 |

### 4.3 关键设计点（比想象中多的事）

1. **参考图上传**（图生图必需）：Bowerbird 的参考图是本地文件。HTTP 模式下要把 `store_path` 转 base64（或上传到服务器）随请求发方舟。方舟接口支持 `image` 参数传 URL/base64 数组（≤10 张）。
2. **key 放哪**：官方建议 key 不进客户端二进制（可提取/盗刷）。两种选择：**(a) 用户自己填 key**（最简单、最合规，key 留在本机 DB/settings）→ 客户端直连方舟；**(b) 自建薄代理**（key 收在服务器）→ 客户端调自己的代理。前者 Bowerbird 改造最省，后者适合未来做远程服务/商业化。
3. **本地 CLI 保留与否**：建议保留作**降级通道**（约定 7 精神：codex/即梦 CLI 不可用时还有 API；或 API 欠费时回 CLI）。这正好也是 [PRICING.md](PRICING.md) 风险 4 想要的「备选 provider」。
4. **计费主体**：谁为生成付费？用户自有 API key（默认）还是 Bowerbird 统一采购（商业化后）？决定 key 管理与配额设计。

### 4.4 工作量量级（估）

| 方案 | 工作量 | 说明 |
|---|---|---|
| 桌面端新增方舟 HTTP provider（图片） | ~1~2 天 | 复用 trait + openai_api 范式 |
| 视频（Seedance）接入 | ~2~3 天 | 复用即梦的异步轮询/恢复逻辑，改请求目标 |
| 薄代理服务器 | ~1 天 | 很薄（转发 + key 托管 + 配额），参考官网 server.mjs |
| 前端 provider 配置 UI | ~1 天 | 加一个 provider 卡片 |

**合计：MVP（图片 + 视频 + 配置 UI）约 5~7 天**，比「服务器套壳 CLI + 客户端改造」**更省**——后者要额外搭服务器、维护登录态、写 HTTP 封装层，且不解决合规/并发。

---

## 5. 结论与建议

### 5.1 直接回答你的两个问题

**Q1：服务器部署 codex CLI + dreamina CLI，应用端调 API，是否可行？**
> **技术上可行，但不推荐作为主力路线。** 两个 CLI 都官方支持 Linux/无头运行，登录态可跨机复用，社区有大量同构先例。**但**：(1) 多用户共享订阅/积分账号明确违反 TOS，封号风险高；(2) 单订阅配额是并发天花板，撑不起商业多用户；(3) 是重复造轮子——CLI 背后本来就是 HTTP API，套壳不如直接用官方 API。**仅适合「单一自有账号、个人自用」的降级通道。**

**Q2：Bowerbird 全面改为通过 API 调用生图/生视频，是否可行？**
> **可行，且推荐。** 正道是**火山方舟官方 API**（Seedream 生图 0.2~0.3 元/张 + Seedance 生视频 0.5 元/秒，均国内直连、支持图生图、视频异步任务制与现有架构同构），官网 [server.mjs](website/server.mjs) 已实证图片链路。改造面小（`GenProvider` trait 已抽象干净，换实现 = 加一个 HTTP provider struct），约 5~7 天 MVP。

### 5.2 路线建议（阶梯式）

| 阶段 | 动作 | 价值 |
|---|---|---|
| **现在（可选）** | 桌面端新增「方舟 HTTP provider」作为 codex/即梦 CLI 的**第三 provider**（默认仍 CLI） | 补上 PRICING.md 风险 4 的备选后路；验证 API 链路 |
| **商业化前** | 若做「远程生图服务」→ 自建薄代理（key 托管 + 配额），或直接让用户自带 key | 合规、可收费 |
| **长期** | 保留本地 CLI 作降级通道；视频逐步由即梦 CLI → 方舟 Seedance | 摆脱积分/订阅账号依赖 |

### 5.3 明确的红线

- ❌ **不要**把「一个订阅/积分账号」搬到服务器给多用户代理（违反 TOS、封号风险）。
- ❌ **不要**把 API key / 订阅额度转售、共享给第三方。
- ❌ **不要**把「逆向官网接口」（jimeng-free-api 类）当产品方案（随时失效 + 违规）。
- ✅ **要**做的合规姿态：官方 API + 用户自带 key / 自用薄代理 + 若面向公众生成式 AI 先评估算法备案。

---

## 附：来源与证据

### 官方文档 / 一手来源
- [Codex CLI 无头模式官方文档](https://mintlify.wiki/openai/codex/cli/exec)（`codex exec` 非交互/CI，`-i/--images`）
- [Codex CLI app-server 官方文档](https://mintlify.wiki/openai/codex/cli/app-server)（JSON-RPC 服务形态）
- [Codex 认证文档「headless machine」节](https://github.com/omnara-ai/codex/blob/main/docs/authentication.md)（auth.json 不绑定主机、可复制到无头机）
- [Codex App Server 官方 README](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md)
- [OpenAI 博客《Unlocking the Codex harness: how we built the App Server》](https://www.engineering.fyi/article/unlocking-the-codex-harness-how-we-built-the-app-server)
- [OpenAI ROW Terms of Use](https://openai.com/policies/row-terms-of-use/)（禁止共享账号凭证）
- [OpenAI Account Sharing Policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)
- [Codex CLI release 0.141.0（远程执行器 / rate-limit credits）](https://github.com/openai/codex/releases/tag/rust-v0.141.0)
- [即梦 CLI 官方飞书文档](https://bytedance.larkoffice.com/wiki/FVTwwm0bGiishxkKOoScdHR2nsg)
- [即梦 CLI SKILL.md（OAuth Device Flow / 异步任务制 / AigcCompliance 授权）](https://raw.githubusercontent.com/simonjiang99/dreamina-cli/main/skill/SKILL.md)
- [火山方舟文档导航（Seedream/Seedance API 章节）](https://docs.volcengine.com/docs/82379/1369901)
- [豆包模型服务协议（火山方舟，禁止转售/分许可，面向公众需算法备案）](https://www.volcengine.com/docs/82379/1142195)

### 先例 / 社区
- [Z7Lab/codex-sandbox（Docker 隔离 + headless 编排）](https://github.com/Z7Lab/codex-sandbox)
- [OpenClaw OAuth 文档（Codex OAuth 服务端复用、token sink、多账号）](https://docs.openclaw.ai/concepts/oauth)
- [iptag/jimeng-api（逆向 API + Token 绑代理 + 风险声明）](https://github.com/iptag/jimeng-api)
- [npm jimeng-cli（token 池、多区域、轮换）](https://cdn.jsdelivr.net/npm/jimeng-cli@0.3.9/README.md)
- [jimeng-free-api-all（逆向，非官方，自述「仅个人研究」）](https://github.com/zhizinan1997/jimeng-free-api-all/blob/main/README.md)
- [suyashb734/cliagents（多 CLI → HTTP API 网关）](https://github.com/suyashb734/cliagents)

### 定价 / 报道
- [Seedream 5.0 Pro API 0.3 元/图起（AITOP100）](https://www.aitop100.cn/infomation/details/34216.html)
- [Seedream 4.0 约 0.2 元/张 + 国内直连实测（teslamate-bridge）](https://github.com/jakezai250808-sudo/teslamate-llm-bridge/blob/main/docs/image-generation.md)
- [Seedance 2.0 mini 约 0.5 元/秒（新浪财经）](https://finance.sina.com.cn/jjxw/2026-06-16/doc-inicqhiz4571121.shtml)
- [gpt-image-1 定价 $0.02~0.19/张（澎湃/机器之心）](https://m.thepaper.cn/newsdetail_forward_30713077)
- [API易 Seedream 文档（能力/计费/限流，与 BytePlus 官方同价）](https://docs.apiyi.com/api-capabilities/seedream-image/overview)

### 风控 / 社区观察（非官方，标注为推测）
- [Codex 使用限额（5h 窗口/周配额，第三方估计）](https://apidog.com/blog/codex-usage-limits/)
- [ChatGPT/Codex 封号原因（腾讯云社区观察）](https://cloud.tencent.com.cn/developer/article/2688138)
- [OpenAI Community：Pro 账号无警告封禁帖](https://community.openai.com/t/codex-chatgpt-pro-account-banned-with-no-warning-no-explanation-18-month-subscriber/1381906/6)
- [codex issue #2515：auth token 能力边界官方未答复](https://github.com/openai/codex/issues/2515)
