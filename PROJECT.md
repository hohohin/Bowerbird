# PROJECT.md

本文件是项目内容的**唯一活文档**（living doc），记录说明、进展、约定与踩坑。基础设计见 `dev-doc/Bowerbird开发计划.md`；若其与本文件的较新决策或专项计划冲突，以较新的记录为准。Agent 工作规则与阅读索引见 [AGENTS.md](AGENTS.md)。

---

## 子文档索引

- [dev-doc/ONBOARDING.md](dev-doc/ONBOARDING.md) — 项目画板入门引导 v2：本地示例、五步操作、暂停恢复、按需提示与隔离验收（2026-09-11）。

- [dev-doc/EMBEDDED-BROWSER.md](dev-doc/EMBEDDED-BROWSER.md) — 探索内置浏览器、登录状态、拖图采集与隔离验证（2026-09-10，Windows 首版完成，用户确认采集成功，未发包）。

- [dev-doc/LOCAL-CLASSIFICATION.md](dev-doc/LOCAL-CLASSIFICATION.md) — 本地动态标签发现、自定义标签匹配、模型包与验证记录（2026-09-10）。

- [dev-doc/CREATIVE-MEMORY-PLAN.md](dev-doc/CREATIVE-MEMORY-PLAN.md) — 创作记忆与常用提示词库专项（复用事件/文字快照 → 常用库 → 定期候选提炼 → 用户确认 → 按需只读注入，CM0–CM7；v1.0 2026-09-10，方向已确认，尚未实现）。

- [dev-doc/VIDEO-API-INTEGRATION-V3.md](dev-doc/VIDEO-API-INTEGRATION-V3.md) — 视频与 FFmpeg 主目录集成、0058 迁移、回滚与验证（2026-09-06；本地集成完成，GUI/线上验收待安排）。

- [dev-doc/VIDEO-API-INTEGRATION-PREP-V2.md](dev-doc/VIDEO-API-INTEGRATION-PREP-V2.md) — 视频隔离提交与 v2 历史集成演练（2026-09-06；已由 v3 实际集成接续）。

- [dev-doc/VIDEO-API-INTEGRATION.md](dev-doc/VIDEO-API-INTEGRATION.md) — 国内方舟 Seedance 2.5 Cloud 视频实现及历史归因（2026-09-11；0058/Worker/Edge 已部署，未启价/未完成真实生成验收）。

- [dev-doc/SEEDANCE-2.5-INTEGRATION.md](dev-doc/SEEDANCE-2.5-INTEGRATION.md) — 即梦 Seedance 2.5 四模式视频接入、官方 CLI 核验与验收记录（2026-09-06；沿用即梦账号与积分）。
- [dev-doc/analyse-panel-todo.md](dev-doc/analyse-panel-todo.md) — 详情页「反推」面板待优化清单（结果管理 / 流式取消 / 术语统一 / 未登录置灰 等，2026-07-07 评审，P0–P2 分级）
- [dev-doc/AI-PROVIDERS.md](dev-doc/AI-PROVIDERS.md) — AI provider 可切换方案（泛化 GenerationPanel + 全局默认/单次覆盖 + codex/即梦首批 + 即梦走官方 dreamina CLI + 关键约定 1 演进，v2 草案 2026-07-23）
- [dev-doc/ARCH-ADJUST-PROGRESS.md](dev-doc/ARCH-ADJUST-PROGRESS.md) — 收费化架构调整（P0–P9）跨会话任务进度与交接（本地进度已更新至 2026-09-11；当前线上指纹见 VIDEO-API-INTEGRATION.md，部署步骤见 apps/cloud/DEPLOY.md）
- [dev-doc/AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md) — Bowerbird 受限 VPS Worker 与内置 Skill Agent Runtime 专项计划（首版 `bowerbird-controlled-image-edit`：纯文本意图分析 → 有限澄清 → Skill 动态规划 → 审批 → Cloud 或本机 CLI 工具执行 → 反馈诊断与修订；Agent Kernel / 独立视觉规范 / Supabase / 方舟 / 桌面会话 UI，历史 v1.23 2026-08-25，见 [apps/agent-worker](apps/agent-worker/)）
- [dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md) — 通用云端 Agent Harness 新专项（一个 Bowerbird Agent + 多种受控 Tool/输出配方；Bowerbird Tool Gateway 与控制面权威；HTML/未来渠道能力禁止另造 Agent Runner，U0–U6 与开发收敛，v1.60 2026-09-05；DSH 统一入口已真实自主选择并完成 HTML 四工具链，统一图片执行已在源码放开多 final 并按 DAG 层并发，仍因自然样本与基础层 HIGH/CRITICAL 保持 test-only）
- [dev-doc/HTML-RENDER-PLAN.md](dev-doc/HTML-RENDER-PLAN.md) — 受限 HTML 离线排版与截图专项计划（独立无外网 Chromium renderer、整页/视口/纵向切片、Kernel `render_html` 工具、第二个官方内置 Skill，H0–H6；明确不做网页访问、自由浏览器 Agent、Vision 自检或自动修订；**H0–H5 已完成，H6 test-only 观察进行中（2026-08-28）**，当前不扩大开放、不调整计费）
- [dev-doc/PROJECT-CANVAS-PLAN.md](dev-doc/PROJECT-CANVAS-PLAN.md) — “一个项目 = 一块无限画板；项目内多条创作线程”当前桌面专项（项目为一级生命周期与画板身份；普通生成/Agent Run 归入线程；不保留旧用户会话；自动化冲突收敛完成，待真机/升级验收，v1.5 2026-09-04）
- [dev-doc/CANVAS-SESSION-PLAN.md](dev-doc/CANVAS-SESSION-PLAN.md) — 已被替代的“一画板一会话”v0.8 实施记录；保留 CS0–CS7 自动实现、测试基线和真实库副本旧契约回填证据，不再作为执行权威
- [dev-doc/进展归档.md](dev-doc/进展归档.md) — 「目前进展」已完成条目的历史全量归档（append-only 只进不改；PROJECT.md 只留最近 3 条里程碑）

## 项目说明

**Bowerbird（园丁鸟）** —— 为 AI 图像创作服务的、本地优先的「提示词 + 参考图」素材库与编排工作台。形态：Tauri 2 桌面应用 + 浏览器扩展。

- **核心交互**：目标形态是“一个项目 = 一块无限画板”，项目内可并排组织素材、提示词、普通生成/Agent 线程和结果分支；画板嵌入现有拟文本创作输入（选图 + 维度下拉，所见即一段中文句子），将完整 prompt + 参考图交给所选 provider 或 Agent。当前调整专项见 [PROJECT-CANVAS-PLAN.md](dev-doc/PROJECT-CANVAS-PLAN.md)，早期面板设计见 [桌面端UI设计.html](dev-doc/桌面端UI设计.html)。
- **范围**：v1 覆盖六大工作流 —— 收集 / 浏览 / 搜索 / 整理 / 分析 / **生成（⑥）**（2026-07-06 决策扩展，覆盖开发计划 v1.2 §1.4「不做生成」，详见关键约定 2）。
- **定位**：不是「复现 Eagle」，而是把散落的灵感图片组织成可复用的「提示词 + 参考图」资产并交给 AI。
- **哲学**：素材库与提示词以本地为权威（Local-First）；AI 推理与生成可经用户自有 CLI 或 Bowerbird Cloud，上传范围、provider 与计费均由用户选择及对应门控约束。

完整的基础定位、范围、技术栈、数据模型与 Roadmap 见 `dev-doc/Bowerbird开发计划.md`（v1.3，2026 年 7 月）；后续变更以本文件和对应专项计划为准。

---

## 目前进展

**近期里程碑（只保留最近 3 条；更早的全量历史见 [dev-doc/进展归档.md](dev-doc/进展归档.md)）**

> **Windows 26.9.14 存档与打包（2026-09-14）：** 纳入 Agent 按项目/线程记忆的「请求批准 / 自行批准」切换、后台执行与修订计划自动审批、结果自动接受整组入库及失败回退；入门引导支持在欢迎页、展开/收起清单和恢复气泡明确跳过，保留学习进度与草稿并避让登录/设置弹窗；修复首次生成任务缺少 session_id 时的历史恢复，仍可找回完整轮次，产物缺失时保留真实提交。Tauri/Cargo 日期版本同步为 26.9.14，从 canonical 主源码构建 Windows x64 NSIS；旧 26.9.11 包保留。相关逻辑、隔离界面和 Rust 回归通过，代码、测试、版本与文档同次提交。本次为桌面更新，无 Worker/Edge/数据库差异，无需部署 VPS；未运行安装程序或调用真实生成服务。

> **桌面导入、Agent 提醒与拖动修复存档及重新打包（2026-09-11）：** 本次纳入显式本地文件按字节去重、损坏图片拒绝、导入失败/部分成功反馈、全窗口文件拖入与冻结项目/画板落点、Agent 整组持久化标识对齐及旧 checkpoint 恢复、任务提醒独立清除、侧栏/画板素材栏拖动减少 React 提交，以及空素材库提示文案调整。回归通过后从 canonical 主源码重建 Windows x64 NSIS，继续使用同日版本 26.9.11，旧包保留在 `Windows/dist/archive/20260911-b01a522/`。本次只有桌面更新，VPS/Edge/数据库维持上一轮部署状态；没有调用 provider 或修改真实用户素材库。代码、共享测试 fixture、测试与 PROJECT/历史归档同次提交。

> **云端同步上线、画板草稿与 Windows 26.9.11 重新打包（2026-09-11）：** 按用户“全面更新后再存档并重新打包”指令完成 VPS Worker 视频链路、Supabase 0058 与全部 12 个 Edge Functions 同步；新 Worker 含 ffprobe 和跨包契约，非 root/只读运行，HTML renderer 与 DSH Profile 运行源码核对一致。视频价格仍未启用、真实生成及账单验收未完成，支付 Mock 与 DSH test-only 策略不变。桌面同时纳入已完成的白底草稿与画圆、铅笔、多行文字标注增量，复用既有图片入库和画板持久化；重新构建同日版本的 Windows x64 NSIS，旧包保留至 `Windows/dist/archive/20260911-before-cloud-update/`。源码、部署与测试证据随本次存档提交；线上状态与回滚见 [VIDEO-API-INTEGRATION.md](dev-doc/VIDEO-API-INTEGRATION.md#2026-09-11-云端同步部署)。

**26.9.14 存档打包复核（2026-09-14，当前交付）：** 审批/自动接受 **7/7**、入门引导 **4/4**、画板/路由/Agent 契约 **112/112**，两组 Chrome 合成 IPC 界面回归（Agent 审批与自动入库、入门引导退出与弹窗避让）通过；Rust **333 passed / 4 ignored / 11 filtered**，包含新增按 job 找回首次生成会话及完整历史测试，沿用既有媒体工具子进程组过滤。根目录 pnpm tauri build --bundles nsis 的 TypeScript/Vite、release 与 x64 NSIS 构建通过，保留既有大 chunk 和 Rust unused/dead-code 警告。安装包 Windows/dist/Bowerbird_26.9.14_x64-setup.exe 为 **53,631,569 bytes**，SHA-256 **02A842241B5DADE3C83F4C95F02737DBC598B0D129A5075218D660015E8DBD48**，校验文件同目录；旧 26.9.11 包保持原文件。日志与源文件指纹保留于本地 .tmp/repack-20260914/，不入 Git。未操作真实素材库、未安装新包；原生窗口、真实付费生成和计费验收仍待进行。

**桌面修复重包复核（2026-09-11）：** Rust **332 passed / 4 ignored / 11 filtered**（沿用既有媒体工具子进程过滤，包含入库、Agent 恢复与迁移回归）、画板/路由/Agent 契约 **112/112**、五组 Chrome 合成 IPC 界面测试（桌面可靠性、全局文件拖图、画板工具条、项目拖图、集合面板）均通过。Tauri 前置 TypeScript/Vite、release 与 x64 NSIS 构建通过；既有大 chunk、Rust unused/dead-code 警告保留。安装包 `Windows/dist/Bowerbird_26.9.11_x64-setup.exe` 为 **53,627,396 bytes**，SHA-256 **`96B5E439D8EE51F21B0009DEEC39ACEEA4C99D82A2CDD75CA78FA25F0E520D58`**，同目录附校验文件；上一份包的指纹为 FC5DC9A2…A75D6E7，已按 b01a522 单独保留。测试和构建日志位于本地 `.tmp/repack-20260911-r3/`，不入 Git。此次未安装新包、未验证原生窗口帧率或真实生成/计费；不将合成 IPC 回归扩大为真机全量验收。

**全面更新与重新打包复核（2026-09-11）：** Worker 本地 **352/352**、Worker TypeScript、视频迁移 PGlite 事务/恢复/结算测试、Edge **52 tests / 15 steps**、全部 12 个入口 Deno check 通过。VPS 镜像在原内存限制下通过 500 MiB 合成 MP4 探测，DSH ACP/审批/计量离线探针通过；完整源码测试直接运行于精简只读镜像为 335/352，另 17 项需要仓库夹具或测试工作目录，不能称容器全套通过。线上 12 函数 ACTIVE 且 JWT 设置逐项保持、10 个受保护入口返回 401、视频路由无任务返回 404、价格活动行 0；权益 Ed25519 真实签名冒烟通过且临时账号删除复核成功，Worker 四个循环正常、重启 0、renderer healthy，无 provider 调用。桌面草稿、标注、入门、工具条、探索画板五组 UI 与画板/路由 **111/111**、TypeScript/Vite 和 canonical Tauri NSIS 构建通过；Rust 沿用本次稍早未变源码的 **330 passed / 4 ignored / 11 filtered** 结果，未再次扩大原生测试。新安装包 **53,626,916 bytes**，SHA-256 **`FC5DC9A22ED159F282C64B0E1713C863C2FE68B604F4E89F4213880C5A75D6E7`**；校验文件同目录。日志与发布清单保留在本地 `.tmp/release-20260911/`，不入 Git；未操作真实素材库、未安装新包，真实视频生成/计费仍待启价后专项验收。

**26.9.11 存档打包复核（2026-09-11）：** 契约 **122/122**（引导 4、画板/路由 111、探索/来源 7）、七组 Chrome 隔离 UI（引导/集合、生成完成提醒、项目拖图、工具条、探索界面、探索画板、既有集合面板）通过；Rust **330 passed / 4 ignored / 11 filtered**，包含示例真实资源导入、设置持久化和迁移回归，沿既有记录跳过媒体工具子进程组。Tauri 的前置 TypeScript/production build 与 release/NSIS 构建通过，保留既有大 chunk 和 Rust unused/dead-code 警告。构建命令为根目录 `pnpm tauri build --bundles nsis`，直接使用主源码及资源，未使用历史 override。安装包 **53,619,569 bytes**，SHA-256 **`434C09ED8A32C3FDDE4C6BE11BB0DD7882D6C15FF089E2E78EB3EFDBBC0A0BA2`**。最终 diff、暂存空白检查与旧里程碑原样归档检查通过；代码、版本和文档同次提交。复跑日志在本地 `.tmp/archive-20260911-*.log`；安装包与 SHA-256 校验文件在 `Windows/dist/`。广告素材、临时截图/日志、旧 spike 结果及无关网页未纳入提交。未重跑线上服务、真实模型、完整原生 UI 或历史项目删除 UI 待办，因此不宣称全量产品验收通过。

**本次存档复核（2026-09-10）：** Worker **352/352**、DSH Profile **25/25**、桌面契约及 Agent 入口 **173/173**、Rust **324 passed / 4 ignored / 11 filtered**（沿本地分类已记录边界过滤媒体工具子进程测试，未重跑真实模型 ignored 项）、视频验收脚本 **7/7**、Edge **14 tests / 15 steps** 通过；两端 TypeScript、桌面 production build 与六个 Edge 入口 Deno check 通过。另有 9 组浏览器脚本通过：视觉规范、后台提炼任务、本地分类、画板整理、引用落点、项目顺序、项目重命名、集合面板、视频引用编辑器。**未通过/未覆盖：** 独立 `project-deletion-ui.test.mjs` 在合成 Vite 服务启动后仍等待“删除测试项目”按钮超时，待定位（项目删除 Rust 回归和重命名脚本中的删除选项验证已通过，不能替代此项）；`cargo fmt --check` 发现已有 Rust 格式差异，未在存档中批量重排；媒体子进程 11 项及 Tauri 真机/真实视频链路未重验。因此本轮不宣称全量通过。桌面测试须从 `apps/desktop` 启动并使用本机 Chrome；根目录启动会漏载 Tailwind 配置，部分界面脚本还须显式指定 renderer 的 Playwright 模块。`git diff --cached --check` 在提交前复核；日志保留在本地 `.tmp/archive-*.log`，不随源码提交。

**探索功能存档复核（2026-09-10，接续上述综合存档）：** 用户确认修复后采集成功；沿用本功能最近已完成的协议/来源 7 项、拖拽 5 类、React 界面、画板路由 111 项、Rust 浏览器/入库 7 项、隐藏 WebView2 与 production build 结果，存档阶段未重复运行或操作用户窗口。提交前检查最终 diff、历史里程碑原样搬运及暂存范围；只提交探索功能、测试和相关文档，临时资料、截图及无关工作区文件不纳入。本次不发布安装包或部署服务。

**探索画板增量存档复核（2026-09-10）：** 本轮复跑 `test:explorer:canvas`、`test:explorer:ui`、`test:canvas`（111/111）及 `build`（含 TypeScript）通过；构建保留现有大 chunk 提示。最终 diff 与暂存空白检查通过，源码、测试和文档同次提交；旧里程碑原样移入历史归档。日志位于本地 `.tmp/archive-explorer-*.log`；临时目录、广告/图片素材、旧 spike 结果与无关网页未纳入提交。本次未重跑 Rust/原生 WebView2 或真实站点验收，未部署或发包。

**阶段清单（含已完成、延后与当前待办）：**
- **通用 Agent Harness U6 — 实现与真实四工具链已完成，发布观察待办**：无内容观察、升级/回滚 Runbook、SPDX/license、包含 U5 的候选重建/扫描、test-only 部署、零 provider smoke、部署后真实 paired、桌面测试入口及统一 DSH 自主 HTML 四工具链均已完成；普通账号不显示 DSH，旧专用 HTML 不接受 runtime，创建后会话展示服务端锁定值。当前只剩发布层面的两类观察：继续积累 `bowerbird_test` 自然小名单/人工质量样本，以及等待官方基础镜像修复或由明确责任人接受剩余 4 CRITICAL / 18 HIGH。公开档位、预算/计费和 正式账号开放策略需另行产品决策（测试入口已于 2026-09-06 收敛为统一 DSH Agent），当前不扩大开放、不扩成小红书发布产品。
- **多模态看图 spike — 已接通（codex CLI），非待办**：四路径实测后定型为唯一 `CodexCliProvider`（`codex exec --image`，ChatGPT 订阅，绕过 API quota）；Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线已全部移除（`codex/` 仅 `codex_cli.rs` + `types.rs` + `mod.rs`），反推会话回看走 `open_codex_session`（`codex resume <thread_id>`）。详见关键约定 1 + 踩坑「多模态看图四条路径实测」。旧 provider 切换 / in-app apikey 配置已删（`config.json` / 后端 `Settings` 模块 / `base64` 依赖随路线移除）；**`SettingsDialog` / ⚙️ 设置按钮 2026-07-18 同名复活为「整库运维面板」**（codex 状态检测 / 重建色板 / 智能归类全部，[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx)，Toolbar ⚙ 入口、约定 13 全屏 Modal 形态），与 apikey 无关。`codex_health` 命令保留作离线/无账号降级探测（约定 7）。
- **Phase 4 剩余 — FTS 扩列已完成（2026-08-27，0019）**：`prompt_body`（有 sections 的反推 caption 正文）/ `annotation`（标注 token）经 analyses 触发器同步进 `library_fts`，改名不再清空新列，存量整表回填；检索的 caption 维度从「仅反推提示词 section」扩到**任意 section 正文**（未反推/无 sections 仍搜不到，刻意行为）。`ocr` 列随 Phase 5 简化不再需要。**tags 已可检索**——走 `tag:<name>` 智能文件夹 JOIN（不进 FTS，见 P2 设计）；codex 批量自动打标已通（采集即归类 + `reclassify_all`）。
- **Phase 5 剩余**：用户已简化为只做反推（caption）；OCR/版式/关键词/灵感卡模板集 + 批量分析队列留待需要时再做。
- PSD 预览（计划 §1.3 P1）暂未做（SVG/视频已覆盖；psd crate 与 image 0.25 兼容未验证，留后续）。
- **创作板 UI — 已实现（见「已完成」，非待办）**：原「占位填空 + 维度下拉」设计演化为「真实 prompt 文本编辑器 + `@` 选图 + 维度 chips 来自图片 sections」（2026-07-18 重写为 ProseMirror）；图像生成亦已通。
- **图像生成（⑥）— 已端到端打通（2026-07-08，见「已完成」，非待办）**：创作板→codex imagegen→真流式回显→入库进瀑布流→多轮修改（resume）→生成图标记（角标/筛选/来源/命名）整条打通。**剩余**：`generations` 表落库（开发计划 §4.2 原移除；目前用 `analyses(kind=generation_meta)` 存来源元信息，够用）。

- **收费化 P9 剩余**：P9-T2/T3/T4/T5 与 P6.1 多层权限门控代码已完成；**Entitlement 非对称签名已上线（2026-08-27）**——Edge Ed25519 私钥（Secret `ENTITLEMENT_SIGNING_KEY`）对权益快照门控字段做规范化 JSON 签名（`_shared/entitlement-signing.ts` ↔ 桌面 `cloud/entitlement.rs` 逐字节镜像，跨语言向量测试锁定），桌面构建期内置公钥验签（`BOWERBIRD_ENTITLEMENT_PUBKEY`），验签通过的快照才允许 7 天离线 Pro 宽限；线上冒烟（`smoke-entitlement-signing.mjs`）已通过。剩余：用测试订阅数据验收 Pro/Studio 解锁、到期降级、历史任务阻断；P9-T1 真实购买/到账仍等待备案/商户资质。跨会话细节见 [dev-doc/ARCH-ADJUST-PROGRESS.md](dev-doc/ARCH-ADJUST-PROGRESS.md)。
- **收费化延后项（凭据/决策驱动）**：Seedance 视频 Cloud 已完成 v3 主目录集成并于 2026-09-11 部署，待正式启价与真实端到端/账单验收、微信登录真实联调（H5）；真实支付在备案完成前不选 provider、不做真实联调，历史候选仅供恢复时重新调研，决策前 `BOWERBIRD_PAYMENT_MOCK` 保持 true。

**里程碑：** 内部 Alpha（Phase 1 ✅）→ 公开 Beta 0.5（Phase 3 ✅）→ 1.0 正式版（Phase 5 简化版 ✅，真实 VLM 看图 spike 后转正）→ **1.x 生成（⑥，codex imagegen 端到端实测跑通 + 入库 + 标记，2026-07-08）**。

---

## 功能清单

[x] 允许用户通过codex一次生成多张图片（codex无疑能生成多张图片，但bowerbird需要增加在一次发送内接收多张返回的图片的功能）— 2026-07-17 完成（接收侧本就 Vec 全链路；瓶颈是首轮 instruction 硬编码「一张」，改为 prompt 驱动数量，详见「目前进展」）
[x] 生成结果历史，允许用户像回看对话一样回看某个图片的生成结果界面，能看到生成时的prompt，并且能提出对该图片的修改意见（给codex）— 2026-07-17 完成（后端 `generation_history` 按会话重建各轮 prompt+图；前端复用 GenerationPanel，详情页「回看生成对话」入口 load 历史会话 + 续轮 resume，详见「目前进展」）
[x] 创作板新增”用途”功能：允许用户将某段提示词及参考图（可选）登记为一个用途，若选择了某用途，那创作时就会首先加载其代表的提示词和参考图。— 2026-07-17 完成（用途 = preset：[0009_presets.sql](apps/desktop/src-tauri/sql/0009_presets.sql) + `createPreset`/`updatePreset`/`deletePreset` CRUD；CreationBoard 用途区选中即加载、可编辑/删除；生成面板「📋 复用」可把某轮 prompt 登记为用途，详见「已完成：回看后复用 prompt / 登记为用途」）；**2026-08-18 起入口被 `PRESET_FEATURE_ENABLED=false` 隐藏（功能待重做，见 featureFlags.ts）**
[x] 允许用户在瀑布流中拖拽素材来放入某个文件夹 — 2026-07-18 完成（Thumb 拖拽源 + FolderRow 放置目标仅普通文件夹；payload 走模块变量避开 WKWebView 自定义 MIME strip；后端 move_assets_to_folder 加 emit 刷新，详见「目前进展」）
[x] 改变生成图的点击行为，目前点击之后会跳转默认浏览器打开本地图片。但应该要的是就是跟常见的图片交互一样，点击后放大展示。— 2026-07-18 完成（生成图点击改 app 内 Lightbox 全屏放大，跨轮 ←/→ 切换，详见「目前进展」）
[ ] 新增功能：允许用户上传文件（如品牌全案）以生成合理的视觉系统规范——可以作为用途。
[x] 记录素材被创作板调用（参考）的次数 — 2026-08-27 完成（`assets.reference_count`：`codex_create_image` 每次实际下发参考图命中资产各 +1（同次去重），0020 迁移 hook 按 generation_meta.payload.references 回填历史；详情页信息区显示「创作板引用 N 次」。自学习体验策略文档仍待设计输出。）
[x] 通用云端 Agent Harness 专项 U4：runtime 兼容、真实 18-case 文本门禁、本地全回归、test-only 远端 `0047`–`0050`/Edge/VPS、零 provider smoke、legacy/DSH 同 case 真实图片与 crash/re-claim 均已通过；actual paired no-regression PASS。普通账号与 HTML 继续保持 legacy，公开迁移留到 U6 决策。

## 关键约定

**2026-09-11 入门引导退出与弹窗避让（已纳入 26.9.14 本地安装包）：** 欢迎页、任务清单（含收起状态）与暂停恢复气泡均可明确跳过；跳过立即关闭浮层并记住选择，保留项目、草稿和学习步骤，可从设置重新打开续学。草稿保存失败不阻止跳过，暂停保存完成的迟到回调不能重新弹出已跳过的引导。登录、设置等模态窗口出现时清单和恢复气泡均隐藏，关闭窗口后恢复，浮层层级低于模态遮罩。详见 [ONBOARDING.md](dev-doc/ONBOARDING.md)。

**2026-09-11 Agent 会话审批模式（已纳入 26.9.14 本地安装包）：** 画板 Agent 会话卡片左下方和展开会话底部提供「请求批准 / 自行批准」切换，默认请求批准；按项目与创作线程在本机记忆选择，同线程的执行与修订计划沿用。开启后由 App 常驻协调器通过既有审批接口批准有效待审批计划，并在结果就绪后自动接受、整组入库，无需再次点击接受；图片和 HTML 结果沿用统一结果集合、持久化确认及入库重试机制。收起详情或切换项目仍处理，切回请求批准会撤销尚未提交的自动审批或接受结果。保留澄清问题、Skill 版本/过期检查以及云端预算、权益和工具权限校验；请求批准模式仍手动验收结果，旧无项目线程归属的只读会话不参与。自动审批或接受失败切回请求批准并提示，不循环提交；应用退出期间不代批，重开恢复后按保存模式继续。本次不需要 Worker/Edge/数据库变更，已于 2026-09-14 重新打包，真实付费生成仍未验收。

验证：审批/自动接受逻辑 7/7、画板/运行协调/路由 112/112、Chrome 合成 IPC 界面回归及 TypeScript/Vite production build 通过；覆盖卡片左下位置、两处开关同步、后台与修订自动审批、撤销、澄清保留、手动验收、后台自动接受与两张结果整组入库、防重复、审批/接受失败回退与本机记忆。截图在本地 `apps/desktop/.tmp/agent-approval-mode.png`；没有调用真实 provider 或修改用户素材库。

**2026-09-11 本地导入与桌面反馈：** 显式文件/目录及无来源 URL 的本地字节导入仅合并内容字节完全相同且库文件仍存在的素材，保留相似构图与修订版本；带来源 URL 的网页采集继续近似去重。外部文件由全局入口接收，松手冻结项目与画板落点，保留集合及内部拖动独立链路；成功数量和失败反馈以实际入库结果为准。Agent 整组落库确认使用前后端一致的原始有序去重标识，旧哈希回执由已有持久结果恢复，不重生成或重扣费；清除提醒只影响提醒。空素材库统一显示“点击左上方导入按钮导入素材 或 投放导入素材 或 ctrl+v 粘贴导入素材”，移除空状态导入按钮及重复粘贴提示，搜索无结果仍保留清除筛选。

**2026-09-11 画板草稿（已纳入本日重新打包）：** 在项目画板空白处、图片、素材组及生成卡片的右键菜单提供“新建草稿”，复用图片标注器打开本地生成的 1600×1200 白底 PNG，默认黑色线条，支持画框、箭头、画圆（Shift 正圆）、铅笔自由线条、文字、裁剪、旋转和撤销。草稿与素材标注共用全部工具；文字可选黑体/宋体/等宽、字号和粗体，支持多行，输入后点击图片放置。自由线条保留完整轨迹，文字保留字体样式，裁剪/旋转同步变换新增标注；导出的 annotation 继续用既有 bbox/point 加文字说明，不增加模型专用标记。打开或取消不新增素材、不持久化临时项目；首次保存先持久化项目，再沿既有 annotation 入库链路保存图片及坐标，在右键时冻结的画板坐标创建独立素材卡片。保存失败保留编辑器，队列重试复用已入库素材；白底草稿的 `source_asset_id=null`，不伪造来源资产。已有图片标注仍保留“保存到素材库”和“不入库插入创作板”出口。隔离合成 IPC 界面验收见 `apps/desktop/scripts/canvas-draft-ui.test.mjs` 与 `apps/desktop/scripts/annotation-tools-ui.test.mjs`，覆盖两种入口、PNG 实际像素、正圆/闭合自由线条、中英多行文字、字体/字号/粗体、输入法与撤销、裁剪/旋转，以及入库/临时输出；画板契约 111 项及 TypeScript/production build 通过，未操作真实素材库；本次综合存档已重新构建安装包。

**2026-09-11 项目拖图与画板反馈：** 素材库单张或多选图片可拖入首页折叠/展开项目、侧栏项目及折叠侧栏入口，通过既有项目成员 API 添加关联；同一素材可供多个项目使用，重复拖入不重复增加关系，不切换项目或移动/删除原素材。临时/归档项目不接受拖入；失败提示后可重试。画板保存提示固定占位，短写入不闪烁，慢写入延迟显示并短暂保留，避免工具条尺寸跳动；保存失败继续明确显示。探索浏览器仅在对话框或实际覆盖网页的菜单出现时暂时隐藏，画板侧右键菜单不影响网页，恢复不导航、不刷新。

**2026-09-14 Windows 打包版本：** 继续使用两位年份的日期版本，Tauri 配置与 Cargo package/lock 同步为 26.9.14；根与前端 npm workspace 的 0.1.0 不作为安装包版本。安装包仅本地交付，旧 26.9.11 包保留，当前 SHA-256 以上方最新复核为准。

**2026-09-11 生成完成提醒（已纳入 26.9.11 本地安装包）：** 普通图片、视频每轮成功收到产物，以及正式 Agent 整组产物入库确认后，显示应用右上角弹窗并播放短提示音。设置 → 个性化与记忆 → 生成完成提醒提供独立弹窗/声音开关，默认开启，写入 settings.json；旧配置补默认值，启动恢复先读取已保存偏好。提醒在全局完成入口触发，关闭详情或切换项目仍有效；回看已完成历史、失败、取消和空产物不触发，重复完成按任务轮次/Agent 产物组去重，同时完成的短提示音合并。采用应用内弹窗与 Web Audio，未增加操作系统通知。`npm run test:generation-notifications` 合成 IPC/真实组件界面回归、画板 111 项、Rust 设置 7 项、TypeScript 与 production build 通过；未调用真实生成服务，原生 WebView2 提示音及最小化场景待真机验收。

**2026-09-10 画板素材栏折叠：** 素材栏自身提供收起按钮与 36px 展开窄栏，支持键盘操作；打开探索（含进入已打开探索的画板）自动收起，探索期间可手动展开，关闭探索后保持当前折叠状态。隐藏内容与分隔条但不卸载素材栏，保留来源选项、宽度、原有卡片和画板平移/缩放；不把素材栏开关放进画板工具条。

**2026-09-10 探索采集的画板落点：** 网页图片 drop 在画板舞台时，松手立即冻结项目与经过平移/缩放换算的坐标；入库成功后在该点居中创建并持久化一张独立素材卡片。重复采集可复用中央资产，但每次拖放各建卡片实例。等待下载期间移动视口或切换项目不重定向落点；切换后的新项目不出现旧拖放卡片，返回原项目可见。非画板区域维持仅入库，失败不建空卡片；不自动平移视口或调整既有卡片。

**2026-09-10 探索内置浏览器（Windows 首版）：** 在新建创作左侧设置探索入口，打开用户手动浏览的持久原生 WebView，作为左侧附加面板，右侧保留原素材库/画板主页面，不创建素材副本。收起与展开只改变可见性和尺寸，不重新导航、刷新或卸载页面，网页表单/滚动位置/浏览历史保留；网页图片拖入等同扩展采集，来源、去重和后续处理复用已有管线。网站登录由本机独立 WebView2 资料目录持久化，不导出或同步 Cookie，也不复用系统浏览器登录。首版快捷站点 Pinterest/花瓣/小红书/即梦，HTTP(S) 地址开放输入；窗口命令仅本地主界面可调用，网站没有资料库/Agent 权限。采集目标按松手时冻结，先持久化临时项目；当前只实现 Windows 图片取字节，支持常见光栅图，用户已确认修复后采集成功，四站完整兼容性与登录边界不作扩大验收。此功能属于人工收集，不改变 HTML renderer 离线约束、Agent 工具或 Cloud 授权范围。详见 [EMBEDDED-BROWSER.md](dev-doc/EMBEDDED-BROWSER.md)。

**2026-09-10 已有视觉规范管理（源码完成，桌面待新构建）：** 规范列表和详情均可删除单个版本，确认后从集合历史及创作选择中移除；仅删除当前选用版本时清空选择，不自动换用其他规范。底层沿用 `archived` 保留规则、来源快照和历史生成依据，不删除原素材或已生成内容，也不复用版本号。详情提供“返回”，回到集合提炼页并展开已有规范，未保存修改继续受离开保护。查看时直接展示该版本生成时冻结的完整来源素材，依据 `source_payload` 中的素材 ID 读取，不随当前集合成员或后续规则微调变化；素材已移除时显示占位，来源读取失败可以重试。验证：Rust 视觉规范专项 27 项、真实组件合成 IPC 回归（返回、取消删除、失败重试、防重复删除、选择同步、历史素材与缺失占位）、桌面类型检查及 production build 通过；未操作真实用户素材库。

**2026-09-10 品牌原文标注与 VPS 提示词（服务端已部署，桌面待新构建）：** 明确标注的品牌色板、字体及尺寸要求与普通作品风格分开处理。Cloud 图片观察逐项转录原文色号（HEX/RGB/CMYK/Pantone 不互相换算）、用途和名称；无标注色块只描述风格，不猜精确色号。文字提炼按原文单独保留“品牌规范”节及素材来源，不受多数支持率筛除、不截断，风格方向选择不丢弃明确规范。同名异值保留为待核对条目，用户微调确认后才可保存；已保存规范继续只读用于生成。新提炼只复用带 v2 标识的观察，旧反推在用户点击提炼后补做，不回填已保存规范或历史任务。桌面只传 `bowerbird:brand-visual-observation:v2`，两阶段提示词在 VPS `/opt/bowerbird/agent-worker/src/prompts/brand-visual/` 维护，容器只读挂载 `/app/brand-prompts`；每项任务开始时读取、单任务内冻结，后续措辞更新无需发桌面包。维护说明见 [品牌提示词 README](apps/agent-worker/src/prompts/brand-visual/README.md)。定向发布基于现役镜像，保留其他 Agent/视频代码；新镜像 `sha256:04732a2a630d0a58f814696d98ffdbf35313224639ed41dbc45b279057ecf977`，understand-proxy v32、visual-profile v12 均 ACTIVE 且保留 JWT 验证。发布前四类活动队列为 0，发布后 Agent/renderer 健康、restart 0，原 Skill hash 未变。Worker 专项 27 项（本机及 VPS 断网）和 Rust 25 项通过，桌面界面回归、两端类型检查、production build 与两支 Edge check 通过；在线合成探针验证挂载提示词读取与色号保留，未调用真实模型，实际识别准确率尚未实图评测。回滚镜像 `bowerbird/generation-worker:brand-base-20260910`，VPS 备份 `/opt/bowerbird/deploy-backups/brand-20260910/pre-source.tar`；Edge 原版本及其独立依赖备份在 `.tmp/brand-understand-edge-before` 与 `.tmp/brand-edge-before`。

**2026-09-10 本地动态分类（首版源码完成，未发包）：** 分类不预设词表，从实际图片内容与风格生成多标签；支持用户自建标签、说明和正反例，对存量/新素材进行匹配。分类完全本地，与 API/CLI 反推维度分开。首版采用应用管理的 llama.cpp + Qwen3.5-0.8B 量化视觉模型，按需下载约 756 MB，Windows x64 CPU 优先验证；用户纠正优先，移除标签留下排除记录，历史归属不视为训练样本。不新增云端分类回退或积分门控。覆盖下方约定 1 对本地分类模型的禁止及约定 11 的云端固定词表归类；反推/生图/Agent 的原 provider 与授权契约保持。实现范围及验收见 [LOCAL-CLASSIFICATION.md](dev-doc/LOCAL-CLASSIFICATION.md)。

**2026-09-10 创作记忆方向（已确认，开发计划待实施）：** 从用户主动复用生成提示词的行为建立本地常用库，区分点击、成功载入与实际提交，不把高频点击或生成成功直接当成满意/长期偏好。定期增量分析先产出带证据、适用类型与项目/全局范围的候选，用户确认后才可应用；学习与生成应用分别开关，支持本次不使用、查看来源、编辑、停用、删除及防旧证据重新学回。个人偏好只补未指定的视觉选择，优先级为本次明确要求 > 已选视觉规范 > 项目偏好 > 全局偏好；不推断品牌/主体/客户文案为个人倾向，不改变授权/工具/预算。原始输入、引用维度和系统附加块分开保存，系统注入不得作为新的用户证据循环强化。长期记录以本地资料库为权威，云提炼仅接收允许范围的必要文字，生成只带少量相关已确认规则；复用现有统一 Agent、计量、TTL 和恢复边界，不新增 Harness。任务拆分、首版建议默认值及验收见 [CREATIVE-MEMORY-PLAN.md](dev-doc/CREATIVE-MEMORY-PLAN.md)，本次仅计划，不代表实现、迁移、上线或新收费政策已生效。

**2026-09-10 视觉规范沿用集合提炼与创作选择（用户最终纠正，源码完成，未部署/发包）：** 正确链路为集合内点击“视觉规范” → 点击“开始提炼” → 沿既有流程形成规范 → 点击“保存规范” → 在创作对话框中显式选择调用。简化的是呈现，不是另建上传、创建品牌或自动选用的流程；此条取代本日较早“添加品牌图片/使用这个风格自动选择”的设计。集合入口显示集合名称、素材数、素材缩略图、必要费用说明与开始按钮，集合素材直接展示，不设折叠开关；结果保留简短总览，规范详情、微调、试画与历史按需展开。集合已有历史版本时仍先显示提炼确认，用户也可展开查看已有规范。保存只确认入库并更新可选列表，不改变当前创作选择；选择器仅选择已保存规范，不创建集合。空集合引导返回集合添加素材。规范仍独立于项目，可跨项目、跨生成入口调用。后台继续复用有效观察、串行补齐缺失观察和原 Cloud 文字提炼服务；1–500 张来源、少于 3 张提示初步风格、来源冻结、停止/重试、防重复提交及只读注入边界不变，不增加 Agent/Harness 或更改计费。真实组件合成 IPC 已验证集合入口、素材直接展示与规范详情默认收起、单图/空集合、保存后显式选择、保留原选择、跨项目使用、失败重试/停止、编辑校验和过期试画清理；未使用真实图片调用模型。本次两组界面回归、品牌流程 6 项、类型检查和 production build 通过；此前后端验证见下一条。本日配套 Edge 与 Worker 已随“品牌原文标注与 VPS 提示词”上线，桌面界面仍需新构建生效。

**2026-09-10 视觉规范独立于项目（用户纠正，源码完成，未发包）：** 视觉规范是素材库内独立可复用的资产，任何生成都可显式选择；项目仅使用规范，不拥有规范。本条取代旧约定 26/V1–V4 的项目归属、项目筛选与禁止跨项目使用约束。集合里的“视觉规范”直接打开该集合的提炼确认界面，不要求创建/选择/切换项目；选择器列出全部已确认规范，首页、临时项目和不同项目可使用同一版本，用户选择独立持久化。普通图片/视频、Cloud Agent、本机精修及开发态 Z/G/DS 入口均接收所选版本，继续保留 confirmed 门槛、用户当前意图优先、既有生成任务冻结快照及账号权益边界。SQLite 0027 解除项目及来源文件夹级联删除，不重写既有 ID/版本/内容/hash；旧 project_id 只留历史来源，新规范为 NULL，按来源集合续增版本。项目物理清理保护所有规范引用的素材，删除原项目/来源集合后仍可查看、选用已保存规范。验证：品牌规范与集合入口的真实组件合成 IPC 均通过（无项目创建/保存、跨项目选择、退出/临时项目保留选择、来源缺失仍可查看）；Agent 入口 5 项、路由/品牌逻辑 24 项、桌面类型检查与 production build 通过。Rust 回归 318 passed / 4 ignored / 11 filtered：媒体工具探测组在本机两次长时间未返回后停止，重跑排除该无关组，未宣称完整全量通过；迁移及项目清理相关用例全部通过。未修改真实用户库、调用模型或重启应用；配套新桌面构建生效。


**视频渠道补充（2026-09-06）：** 国内方舟 doubao-seedance-2-5-260628 使用现有服务端 ARK_API_KEY，由 Bowerbird Cloud 托管扣积分；即梦 CLI 并存，无 BYOK/海外回退。四模式先完成功能，测试不因预估额度而停止，但保留生产预留、预算、幂等和实际 usage 结算。视频正式价未定，不启用活动价格；已提交但结果未知的任务不自动重发或退款，停止等待后只取回原任务。

**2026-09-06 即梦 Seedance 2.5 视频接入：** 用户确认沿用即梦官方 Dreamina CLI 与用户自己的即梦账号/积分，不新增 Cloud 托管视频计费路径。创作板视频首版覆盖 `text2video` / `image2video` / `frames2video` / `multimodal2video`，显式指定 `seedance2.5`，权限不足或不可用时不能静默降级 2.0；不把固定模型的 `multiframe2video` 当作 2.5。默认 5 秒、720p，允许 4–30 秒；文生/多参考使用六档视频比例，单图/首尾帧由输入图决定。参考图/视频按本轮显式选择使用，不自动把上一轮视频当图片；复用现有普通生成任务、项目线程、持久化与查询恢复，视频不进入 Agent 或 Cloud 图片链路。本机 CLI 帮助已核验支持，但不等于账号真实生成验收；实现与测试证据见 [SEEDANCE-2.5-INTEGRATION.md](dev-doc/SEEDANCE-2.5-INTEGRATION.md)。本条覆盖旧视频规划中本次不适用的五模式、默认模型与自动回退规则。

**2026-09-06 Agent 用户入口收敛（本地实现与验证完成，尚未部署/发包）：** 用户侧只保留「Agent」开关，新任务统一为 `bowerbird-unified-agent + dsh`；移除 Legacy/DSH 与受控生图/独立 HTML 的选择入口。前端、桌面 IPC 和 `agent-run` Edge 新建边界拒绝旧路线，不回退新建 Legacy；测试账号标记、统一 Skill 权益与云端开关维持原范围，无权限明确不可用，失去权限不静默改为普通生成。历史 Run 的 skill/runtime 仍按持久化快照处理，查看、结果取回、审批、取消、本机任务收尾及既有幂等上传恢复保留；不删除旧执行器，不改授权、计费或恢复控制面。普通生成的本机引擎继续可用，Agent 使用原有 Cloud 工具。发布只需本次 `agent-run` Edge 增量与桌面应用更新，无 Worker/数据库迁移/FeaturePolicy 变更；线上全面禁止旧路线须待 Edge 部署后才生效。

**2026-09-06 首页项目素材视图：** 主界面右上角集中放置「生成图：只看 / 不看」与「项目素材：收起 / 展开」切换栏；再次点击当前生成图选项恢复全部。画板内生成图筛选放在素材面板顶部，与缩略图大小同排，对项目素材和中央素材均生效。项目素材默认收起并记住全局选择：项目以九宫格预览、项目名与当前筛选命中的素材数呈现，点击卡片在原列表位置展开单个项目，不再打开中间浏览弹层；单个项目可独立收起，全局「展开 / 收起」每次点击均覆盖全部可见项目的局部状态。项目卡片和展开框复用侧栏项目右键菜单，框内素材保留自己的右键菜单。展开项目以带项目名的整行边框呈现，标题旁铅笔支持重命名并同步侧栏，右上角提供「打开项目」直达对应画板、收起和删除按钮；删除沿用既有影响确认与运行任务阻止，中央素材和底层执行审计保留。共享素材在各所属项目出现一次，未归入可见项目的素材保留在全局。首页先筛选 canonical assets，再按项目归组及折叠生成流程，避免跨项目丢图；旧 hide_project_assets 设置只继续控制画板内全局素材查询，不隐藏首页项目卡片。新增查询不执行用户库迁移或历史 backfill。

**2026-09-06 用户确认：DSH 是通用 Agent 的唯一 Harness。** 对话历史、工作上下文、自动摘要和工具选择交给 DSH；禁止在计量代理中另做截尾、摘要或注入每轮状态来代替 DSH 上下文。Bowerbird 保留业务工具、`ask_user` 提问/选项 UI、答案检查点、授权、计费、持久化动作及结果交付。当前钉版 `0.1.1-rc.2` ACP 只支持新会话，不支持 load/resume，因此跨提问/审批仍由业务检查点启动新原生会话，不宣称完整会话已恢复。原生压缩属于 DSH，不再自建替代压缩器。

> 团队已定的、不轻易改的决策。基础论证见 `dev-doc/Bowerbird开发计划.md`，后续专项论证见上方索引。约定内容只在本文件维护，不镜像到 `AGENTS.md` 或兼容性规则文件。

1. **反推与生成外包，本地分类例外**（2026-09-10 更新见上）：所有理解/分析（VLM 描述、OCR、版式、关键词、灵感卡）**不自建本地模型、全外包**：本机走 headless codex 子进程，Cloud 走 `UnderstandProvider`（方舟 Vision，2026-08-18 起经 VPS understand 异步链路）；**图像生成（⑥）多 provider 可切换**（2026-07-23 Phase 1+2 落地，2026-08-10 Cloud 加入）——抽象 `GenProvider` trait（原 `CodexProvider`，[codex/mod.rs](apps/desktop/src-tauri/src/codex/mod.rs)），三实现：`CodexCliProvider`（默认，`codex exec --image`，ChatGPT 订阅，真正看图 + 出图）/ `DreaminaCliProvider`（即梦官方 dreamina CLI，OAuth + 积分，**仅出图**，[codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs)）/ `BowerbirdCloudProvider`（Bowerbird Cloud 托管生图，Pro/Fast/Lite 档位数据驱动见约定 31，[codex/bowerbird_cloud.rs](apps/desktop/src-tauri/src/codex/bowerbird_cloud.rs)；免费档唯一生图路径）；命令层 `codex_create_image` 的 `provider` 参数选（None=codex），工厂 `resolve_gen_provider`。**理解类（反推/命名）走 `UnderstandProvider`（[codex/understand.rs](apps/desktop/src-tauri/src/codex/understand.rs)）**：本机 codex 或 Bowerbird Cloud 引擎显式二选一（2026-08-13 起；档位门控免费档仅 Cloud；即梦无文本能力，§4.3）。**本地模型例外仅限已确认的本地分类专项**；反推与生成仍沿用现有 provider，不扩大到本地扩散或其他未确认模型；Mock / ClaudeCode / OpenAI HTTP 路线在桌面 provider 层均已移除（[codex/openai_api.rs](apps/desktop/src-tauri/src/codex/openai_api.rs) 仅存 spike 备选；DeepSeek 只在 agent-worker 作 Agent 文本回合后端，见约定 25/28；详见踩坑「多模态看图四条路径实测」）。详见 [dev-doc/AI-PROVIDERS.md](dev-doc/AI-PROVIDERS.md)。
2. **v1 做图像生成（⑥）**（2026-07-06 决策，**覆盖开发计划 v1.2 §1.4「不做生成」**）：在原五件套（收集/浏览/搜索/整理/分析）基础上加入生成。生成多 provider（约定 1）：codex 路径走 CLI tool-use（codex 内置 `imagegen` 技能，不自建扩散模型），Cloud 路径走方舟 Seedream（VPS 异步链路，约定 24/31），即梦走官方 CLI。**已端到端打通（2026-07-08）**：codex exec 触发 `imagegen` 画图，产物落 `~/.codex/generated_images/<thread>/`（路径不在 JSONL 一等字段，靠**快照差分**取图，详见踩坑）；创作板生成 → 真流式回显 → `ingest_generated` 入库为正式资产（`source=codex`、不算 pHash 不去重、进瀑布流）→ 多轮 `codex exec resume` 迭代修改 → 生成图标记（✨ 角标 / `source:codex` 筛选 / `generation_meta` 来源追溯 / 自动命名）。**生成图 caption 策略（2026-08-11 反转）**：曾从生成 prompt 拆 `【维度】：正文` 自动落 caption（2026-07-10 起，不调 codex 反推），导致所有生成图被标「有反推」（🏷️/创作板 @ 池虚构维度）——已反转：**生成图入库不自动写 caption，需手动反推才有**（generation_worker 移除维度拆解，详见「已完成」条目）。prompt 原文仍存 `generation_meta`；**生成 UI 独立为 `GenerationPanel` 覆盖层**（与创作板解耦，状态在 store）；**同流程合并**（2026-07-10）：同一 `session_id` 的过程图入库时写 `assets.generation_session_id`，瀑布流 `collapse_generation_groups` 每组只显最新一张，缩略图/详情页可左右切换过程图（详情页支持 ←/→ 键）；**2026-08-18 扩展（0014）**：`generation_conversations` 把 session 组再扩成 conversation 组——「重新编辑/重试」的版本分支归入同一会话（后端权威、重启不丢）。**一次生成多张（2026-07-17）**：接收侧本就是 Vec 全链路、无需新增能力；数量完全由用户 prompt 驱动（不加 UI 控件），首轮 instruction 不再硬编码「一张」（改「张数以提示词为准」），续轮 resume 天然支持，首轮多张同 session_id 合并成一组。**剩余**：`generations` 表落库（开发计划 §4.2 原移除；目前用 `analyses(kind=generation_meta)` 存来源元信息，够用）。
3. **检索用 FTS5 全文**（`trigram` 起步；**0019 起 `name`/`prompt_body`（有 sections 的反推正文）/`annotation`（标注 token）三列同步**，`ocr` 随 Phase 5 简化不需要）。检索实现为多维度 LIKE 子串（trigram FTS 对 <3 字符与跨维度 AND/NOT 语义不适配，`search_assets_ex`；FTS 列为后续索引化预留一致数据）。pHash **仅用于采集去重**，不做以图搜图；无 CLIP 语义/向量搜索。**标签/颜色不走 FTS**——`tag:<name>` 走 `list_assets_smart` JOIN（P2）、颜色走 `asset_colors` JOIN（P3）。
4. **性能目标：千图级流畅**，不追求万图秒开（据此决定虚拟滚动/缓存不要过度优化）。
5. **codex 调用走独立 Worker + 持久化 SQLite 任务队列**（可取消 / 重试 / 并发上限）；单个 codex 子进程崩溃/超时不得拖垮主进程与资源库。
6. **核心数据已从「图片 ↔ 提示词映射」演变为 caption 体系（2026-08-18 修订）**：`asset_prompts`（`role`: main / ref / desc）是 Phase 3 早期枢纽，现为后端遗留（表与 `commands/prompt.rs` CRUD 保留、前端零调用）；**实际枢纽 = 反推 caption `sections`（约定 10）+ 创作板 @图/维度（约定 9）+ preset「用途」+ `generation_meta` 生成来源**，新功能围绕后者设计，不再基于 `asset_prompts` 扩展。
7. **离线/无账号降级**：未配置 codex 时，分析类功能置灰并提示，而非崩溃。
8. **浏览/批量双模式交互**：默认浏览模式（点图 → 详情页覆盖主区：大图 + 信息/反推/类别/来源工作区；旧 PromptEditor 已随创作板演进移除）；manage 多选模式经右键「选择」等入口进入（顶栏「批量管理」入口 2026-08-14 已移除；点图 = 切换选中，含取消），BatchBar 按语义分组（选择/整理/AI/危险：批量反推 / 删除三模式 / 加入项目 / 移入文件夹，2026-08-11 重做；旧「批量生成提示词」已不存在）。详情页大图走 `store_path`（原图全尺寸），来源外链用 `source_url`（`@tauri-apps/plugin-shell` 的 `open` 经系统浏览器打开，`shell:allow-open` 已授权）。

9. **创作板 = 核心交互的 UI 形态**（2026-07-06 定稿，2026-07-08 实现；设计稿 [dev-doc/桌面端UI设计.html](dev-doc/桌面端UI设计.html)）：右侧面板的「真实 prompt 文本编辑器」——用户像跟 AI 输入 prompt 一样自由书写，**插入参考图两类入口**（2026-07-18 重写为 ProseMirror 后）：① 创作板打开时直接点瀑布流任意图（默认）→ 在**当前光标处**插 image chip（取代旧版末尾追加）；② 输入 `@图名` + 空格/回车/标点 → 自动识别为 image chip（`@` = mention 前缀，asset 名贪心最长 + 边界检查匹配，失败则 `@文本` 保持纯文本）；载入（`board-load-prompt`）/粘贴含 `@图名` 的 prompt 文本时整段解析转 chip。两者都插「缩略图 + 图名」原子 chip 并焦点回编辑框；图片后浮现维度 chips，点击插入蓝色下划线维度 token，**面板常驻可连续点多个维度**（同图的光影/类型/氛围… 不用重新 `@` 选图；Esc / ✕ 收起）；手输维度按空格/回车/标点自动识别转 token。底部「确认生成」把图片 token 按所选维度展开为 `@图名 的【维度】：section 正文`（多维度各自取片段，详见踩坑「多维度序列化」）；**未选维度的图片 token = 纯参考引用**（只序列化 `@图名`，图经 reference_images 传给 codex、不灌整段 caption，支持「将@B 变为@A 的调性」里 @B 仅作参考图；点图也不再自动插「的」，由维度展开自带或用户手输）。+ 参考图集 → 经当前所选 GenProvider 发送（**生成已端到端打通，2026-07-08**，见约定 1/2；早期「优化 / 扩写」动作未落地，仅生成）。**维度 chips 不来自预置 `prompts(kind=template)`**，而是按图动态生成（取该图反推 `sections` 标题，见约定 10）；早期 `0003_templates.sql` seed 的 template 行已被 `0004_templates_clear.sql` 清空（迁移历史保留，net DB 无 template 行）。入口为 Toolbar「创作板」按钮（2026-08-14 外壳精简后为文本按钮、紧邻全局状态，旧 🎬 emoji 已去），非批量管理模式。

10. **反推 caption 维度片段存储约定**（2026-07-07）：不新增 `asset_dimension_prompts` 表；反推仍是分析数据，落 `analyses(kind=caption).payload`。payload 兼容旧 `{text}`，新版包含 `schema_version/text/instruction/session_id/sections/dimensions/parse_status`；`sections` 是模型实际输出的全部维度（按文档顺序，动态、不固定），`dimensions` 是经别名表归一化的五大标准键（`composition/light/palette/action/mood`，用于 `parse_status` 判定）。**创作板维度下拉按图动态生成**：取该图 `sections` 的标题作为可选项，`@图片 + 维度` 只注入对应 section 正文，缺失时回退整段 caption。**反推任务全局串行**（2026-07-08）：store 维护单槽队列（`describeQueue` / `pumpDescribe`），同一时刻只调一次 `codex_describe_asset`（后端 `DESCRIBE_CANCEL` 单例），连点 N 张图排队执行、各自在缩略图角标可见可取消（详见踩坑「连点反推前一张被静默 kill」）。

11. **采集即命名 + 基础/反推分层**（2026-07-08）：图片进库即后台跑一次自动分析（[core/autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs) `spawn_auto_analyze`；本机 = codex，Cloud 路径须用户显式开启 `cloud_auto_understand` 且 2026-08-18 起经 VPS understand 异步链路），一次产出「≤8 字命名 → `assets.name`」+「基础 caption → `analyses(kind=caption)`」。**基础分析刻意不带维度**——指令只要求「描述 + 取名」（首行命名、第二行描述），caption 多为 `raw_fallback`（`sections`/`dimensions` 空）；**维度结构交给后续手动「反推」带来**。反推默认指令预置**带维度模板**（11 个 `- **维度名**` 段落：类型/ratio/构图/光影/色调/主体动作/材质·笔触/背景/氛围·情绪/反推提示词/负面提示词，定义在 [lib/describePrompt.ts](apps/desktop/src/lib/describePrompt.ts) `DEFAULT_DESCRIBE_PROMPT`（2026-07-23 自 AssetDetail 抽离、详情页与右键反推共用）；localStorage 记忆、旧默认「请描述这张图片」自动迁移到新模板），该 `- **维度名**` 格式正中 `caption::parse` 的 section 识别 → 反推产出的 caption sections 齐全，创作板维度 chips 随之丰富。**反推累加**：每次 `INSERT` 新 caption 行（不覆盖、不改 `name`），详情页列全部 caption 卡片（可单删），创作板取最新一条 caption 的 sections 当维度 chips。命名硬上限 8 字（`clean_name` 截断，即便指令未提 8 字）；改名走 `update_asset_name`，命中 FTS5 触发器自动重建搜索索引。**采集即同时自动归类**（2026-07-09 续）：同一次 codex 调用还产出 `[[CAT: 类别]]` 哨兵 → 写 auto tag（受控词表，仅当该图尚无 auto tag 防顶手改），详见 P2 标签。

12. **收藏夹是多对多、独立于「文件夹位置」的维度（2026-07-10）**：现有 `assets.folder_id` 是 1对1 位置语义（素材只在一个文件夹，`move_assets_to_folder` = 换位置）；**收藏夹另起一套多对多**——`asset_collections(asset_id, folder_id, created_at)` 关联表 + `folders.kind='collection'` 标识（与 `asset_tags`/`asset_colors` 多对多表对称）。一个素材可同时收进多个收藏夹、`folder_id` 原位置不变。`folders.kind` 三态：`folder`（位置容器）/ `smart`（智能查询）/ `collection`（收藏夹）。入口：详情页 header ☆/★ 按钮（行内 panel 选已有 / 新建）。**凡按 kind 过滤「可放入 `folder_id` 的容器」处，必须正向判 `kind==='folder'`**（排除式 `kind!=='smart'` 会漏掉 collection → 收藏夹污染 folder_id，见踩坑）。

13. **首个 Modal 形态：全屏遮罩（2026-07-10）**：项目此前**无 Dialog/Modal/`fixed` 先例**——唯一的「盖住主区」覆盖层 GenerationPanel 用 `absolute inset-0 z-10`（只盖主区、不盖 Toolbar/Sidebar、无 backdrop）。首启引导页 [CodexOnboarding.tsx](apps/desktop/src/components/CodexOnboarding.tsx) 新立全屏模态：`fixed inset-0 z-50`（盖住整个 app）+ `bg-black/60` 半透明遮罩 + 居中卡片（`bg-panel border border-edge rounded-lg`，项目首个用 box-shadow 的浮层）。组件**自管可见性**（不满足条件直接 `return null`），挂载点 `App.tsx` 最外层 div 内、`<Toolbar>` 前，**无条件渲染** `{<CodexOnboarding />}`；「已看过」flag 不入 store（项目零 zustand persist），照 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 直接读写 `localStorage`（key 前缀 `bowerbird.`）。后续 Modal/Dialog/确认框 的底层形态范式；2026-08-14 起通用弹窗统一为 `ModalShell`（品牌化遮罩 + 固定动作栏 + 焦点循环/Esc/焦点恢复 + 忙碌锁定），引导类弹窗由设置/引导体系唤起，本条「App.tsx 无条件渲染」等挂载细节已过时。

14. **平台适配只维护 canonical source（2026-07-27，prod 线）**：Windows / macOS / Linux 共用 `apps/desktop/`、`apps/extension/` 和根 workspace；平台差异优先用可移植实现，必要时只在接缝处使用 `#[cfg(target_os = ...)]`，不再长期维护整文件 override。`Windows/` 是开发/构建与独立扩展工具目录，不是第二套产品源码；`Windows/overrides/` 只留退役说明，不应重新加入 payload。浏览器采集协议中，`save_blob + binary` 用于需要 Cookie/登录态的图片，`save_batch` 用于公开 URL 的结构化批量采集，两条通路并存、不得互相替代。

15. **codex CLI 隐形（一键安装 + OAuth 登录）**（2026-07-29）：codex CLI 是本机 provider 之一（约定 1：另有即梦与 Bowerbird Cloud），但用户**无需碰终端**——首启引导（[CodexOnboarding.tsx](apps/desktop/src/components/CodexOnboarding.tsx)）从「复制命令让用户去终端跑」升级为 app 内一键执行：step1 `codex_install`（spawn `npm install -g @openai/codex`，逐行进度经 `codex://setup-progress` 流式）+ step2 `codex_login`（spawn `codex login`，codex 自己开浏览器走 ChatGPT OAuth，写 `~/.codex/auth.json`）。后端 spawn 走 `tokio::process::Command`（**不受 Tauri shell scope 限制**，不改 capabilities）。Node/npm 缺失返回 reason，前端引导装 Node。安装/登录成功 emit `codex://health-changed`，App + AssetDetail 各自监听重取 codexHealth（修 AssetDetail 独立 useState 不同步，见踩坑）。Windows 上 npm.cmd 路径常含空格（`C:\Program Files\nodejs`），`npm_command` 用 `raw_arg` 拼 `cmd /S /C ""path" args"`（详见踩坑）。**备选**：[codex/openai_api.rs](apps/desktop/src-tauri/src/codex/openai_api.rs)（OpenAI Images API 生图，API key 路线，未接入主线）——经研究 ChatGPT 订阅额度不对第三方 API 开放、codex CLI 是唯一合法订阅通道，故走 CLI 隐形而非换 provider。

16. **环境状态入口收敛进设置面板 + 扩展心跳连接跟踪（2026-07-31 立，2026-08-15 重构）**：原两级「环境状态 Onboarding」（一级 Onboarding.tsx 三卡片总览 + store `onboardingForceOpen` 跳转二级）**已于 2026-08-15 删除**——codex / 即梦 CLI 状态与引导移入设置「模型设置」、浏览器扩展引导移入「系统设置」直接唤起，二级引导（Codex/Dreamina/Extension Onboarding）关闭即返回设置；**2026-09-11 入门主线更新为项目画板实操**：本地示例项目或自己的图片 → 拖入与移动卡片 → 写目标并选参考/维度 → 用户主动图片生成即完成五步主线；集合通过独立教程覆盖创建、添加素材、按需提炼及保存后选择规范。版本化进度独立保存，可暂停/恢复；先完成准备与实际生成完成分别记录，跳过维度明确标注。账号和模型配置沿原入口按需进行，引导不得自动调用分析/生成；旧用户用一次新版变化介绍，专题说明按需展示。详见 [ONBOARDING.md](dev-doc/ONBOARDING.md)。**扩展连接跟踪不变**：canonical 扩展（[apps/extension/](apps/extension/)）每 15s WS ping；后端 `ExtensionStatus`（last_seen + connected）收任意消息 touch/emit connected、后台 tick 30s 超时 emit disconnected。随包内嵌（tauri resources `../../extension/` → `extension/`，用**目录源**保留子目录结构——map+glob 会拍平子目录致 release 扩展图标加载失败，见踩坑；dev 源码、release resource）。

17. **扩展采集统一走浏览器 save_blob + 通用候选管线（2026-07-29）**：canonical 与旧 Windows 版不再分叉——[background.js](apps/extension/background.js) 在浏览器会话内 fetch（继承代理/Cookie/登录态）后，以 `save_blob` metadata + binary WS 上传；桌面 [ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs) → [ingest_from_bytes](apps/desktop/src-tauri/src/core/ingest.rs) 按真实字节 sniff/decode，**禁止退回桌面 reqwest 二次下载作为主路径**（Pinterest/登录态站会回归）。通用候选见 [candidate-utils.js](apps/extension/candidate-utils.js)：`img/currentSrc`、srcset/picture、lazy data-*、CSS background、OG/Twitter、JSON-LD、poster/SVG、open shadow；拖拽 HTML 图片优先，禁止把外层商品页 URL混为图片；Alt 明确目标支持 overlay/CSS/blob/data/canvas。XHS 结构化适配保留为高置信度增强但共用后续管线。安全边界：候选≤100、fetch 45s、图片≤50MiB、HTML fallback≤2MiB且深度1、防循环、Rust 100MP/32768边界、metadata状态机/长度限制、日志 query 脱敏；不绕 closed shadow/跨域 iframe/tainted canvas。真机以 Pinterest + `petcollars.com.au` 商品页通过为验收。

18. **项目是中央素材库上的多对多 Workspace 视图（2026-07-30）**：`projects` 只登记 canonical workspace 路径与名称，`project_assets` 只登记成员关系；项目**不是第二套素材库**，不改变 `assets.folder_id` 的全局位置语义。创建项目只在登记时递归导入目录现有图片，之后不监听/同步、不写回、不删除用户原目录；所有素材仍复制到 Bowerbird 中央库，dHash 去重命中时仅新增项目关系。进入项目后，所有素材查询与成员集合取交集，文件夹/收藏夹/标签/颜色元数据仍为全局共享；项目内导入、扩展采集、生成均同时进入中央库和当前项目。应用启动默认全局，不持久化 active project。项目内单次删除必须每次二选一（仅移出 / 全局彻删）；删除项目三选一（2026-07-31）：仅删关系 / **移出独占素材文件回 workspace 并删行**（这是唯一会写 workspace 的操作，且由用户显式触发）/ 物理删除独占素材（红色 + 手输「确认删除」），被其他项目共享的素材必须保留。扩展的 active project 由后端 `ActiveProjectContext` 快照，生成续轮使用首轮 `genProjectId` 快照，禁止因中途切换 scope 造成归属漂移。

19. **素材库根可自定义并可整体迁移（2026-08-01）**：库根不再写死应用数据目录——`settings.json` 增 `library_root`（只存指向，文件体量小可留系统盘），[lib.rs](apps/desktop/src-tauri/src/lib.rs) 启动先读设置定根，默认仍为应用数据目录。迁移只复制不删除，用自定义根打开成功后由启动流程清理 app_data_dir 旧库残留（images/thumbnails/library.db*），彻底释放系统盘；`VACUUM INTO` 拿一致性 DB 快照、`REPLACE` 改写新库 `store_path`/`thumb_path`/analyses payload 绝对路径前缀。**`convertFileSrc` 走 asset 协议、受目录白名单约束（默认仅应用数据目录）**——自定义库根必须 `asset_protocol_scope().allow_directory(&paths.root, true)` 显式放行，否则迁移后全部破图（见踩坑「迁移素材库到自定义位置后全部图片破图」）。

20. **图片删除统一走三模式，与「删除项目」语义对齐（2026-08-01；2026-09-04 补全全局语义）**：单素材删除（右键菜单）使用 `keep`=仅移出当前项目（素材留全局）；`move_out`=移出园丁鸟（项目视图中的共享素材只移出当前项目成员、资产行与库内文件保留；中央素材库中的操作在原文件恢复后删除中央资产及全部项目成员关系；原始文件不在且无法恢复时如实报告失败）；`delete`=从全局及所有项目物理删除（红色入口 + 手输「确认删除」口令，避开 WKWebView 对 `window.confirm` 的拦截）。浏览器扩展采集图及拖入字节、剪贴板、标注、Cloud/即梦等只产生临时来源的素材没有可靠的用户原始文件位置；新入库不得把 Bowerbird 临时路径保存为 `origin_path`，存量以 `source=extension` 或 `Temp/tmp` 下已知的 `bowerbird-upload-*`、`bowerbird-cloud-*`、`bowerbird-dreamina-*` 临时目录识别。单图与任意包含此类素材的批量选择必须置灰 `move_out`，只允许保留项目关系操作或物理删除，后端同样拒绝绕过 UI 的 `move_out`。项目删除的旧三选项已被约定 47 覆盖，但单素材三模式继续保留。**删资产前必须先 `drop(conn)` 释放锁再走 `delete_asset`**（`delete_asset` 内部会再拿锁 + 文件 IO，锁内调用即死锁）；若旧数据的 `store_path == origin_path`，只能删 DB 与独立缩略图，不能调用会删除原文件的 `delete_asset`。

21. **官网试用创作板的生图 provider 独立于桌面端（2026-08-02）**：官网运行在浏览器，禁止把 API Key 写进 `index.html` / `app.js` / bundle；真实生成统一经 [`website/server.mjs`](website/server.mjs) 的同源服务端代理。`BOWERBIRD_IMAGE_REGION=cn` 时首选 Seedream 5.0 Lite，其他地区首选 FLUX.2 Klein 9B；`BOWERBIRD_IMAGE_PROVIDER` 可显式覆盖。编辑器只提交 prompt 与演示图 ID，服务端按固定白名单读取参考图并转 data URI。官网试用的产品目标是**演示生成后自动入库**，不是提供免费生图：前端不提供下载按钮；服务端默认每 IP 每自然日 3 次、全站 100 次/日（均可由环境变量收紧），第 3 次后前端隐藏生成按钮并展示下载 CTA。首屏只用动态节点图解释参考图、维度与输出图的关系，不明文展示或复制最终 prompt；图作为来源分组，组内每个维度必须拥有独立节点、端口和到输出图的连线，未选维度的纯参考图以「整图参考」节点接线；但底层序列化与 API 请求保持真实 prompt，不因可视化改变生成语义。内存计数服务重启后清空，公开部署仍应叠加 CDN/WAF 限流。官网 HTTP provider 只服务公开试用页，**不推翻桌面端“本地 CLI 子进程”约定**。

22. **官网本地与 Render 统一 pnpm，部署在 codex/render-deploy 分支（2026-08-04）**：[`website/`](website/) 是 pnpm workspace 成员（锁文件用根 `pnpm-lock.yaml`），本地与 Render 必须用同一套包管理器（pnpm@11.10.0，根 [package.json](package.json) 的 `packageManager` 字段），**禁止在 website 目录跑 `npm install`**——会生成 `package-lock.json` 并破坏 pnpm 的 `node_modules/.bin`（详见踩坑）。Render Blueprint（[render.yaml](render.yaml)）push 到 **`codex/render-deploy`** 分支触发自动部署（这是 Render 实际监听的分支，不是 main/dev/mac）。Render 构建环境 `/usr/lib/node_modules` 与 `/usr/bin` 只读，`corepack enable` 与 `npm i -g` 都失败，buildCommand 必须把 pnpm 装到用户可写目录 `$HOME/.npm-global`（`npm i -g pnpm@11.10.0 --prefix $HOME/.npm-global`）并用绝对路径调用（详见踩坑）。官网静态资源（含 mp4）经 [server.mjs](website/server.mjs) 同源伺服，已支持 MP4 Range 分段请求（`206`），大视频可拖动进度条。

23. **生成任务持久化 + per-job 取消 + 即梦串行 + 前端多 job（2026-08-06）**：生成（图片/视频）任务进 `task_queue`（kind=generation，payload = `GenJob` JSON：id/media/provider/status/prompt/references/session_id/ratio/submit_id/video_options/turns/queue_idx/timestamps）；`job_id` 由前端 `crypto.randomUUID()` 生成传入（多 job 路由无 race），`codex_create_image` upsert（续轮复用同 job_id 刷新回 running）+ emit `codex://chunk{job_id}` + 成功 `mark_done` / 取消 `mark_cancelled`（保留 submit_id 事后取回，演进约定 5）。**per-job 取消**：`GENERATE_CANCEL` 为 `HashMap<job_id, oneshot::Sender>`（非单槽），`cancel_codex_create(job_id)` 精确取消指定任务。**即梦同账号并发=1**（spike 实证 `ExceedConcurrencyLimit` ret=1310）：`JIMENG_FLY` Semaphore(permit=1) 串行化即梦 job，codex 不受此限可并行。**前端多 job 状态机**（Task 3，2026-08-06）：store `genJobs: Record<id, GenJob>` + `activeJobId`，`generating` 派生（任一 job running）；`startGeneration` 不再单槽阻塞（可并发发多个生成），chunk 按 `job_id` 路由；续轮/复用/取消/重试基于 activeJob；GenerationPanel 呈现活跃 job/会话（2026-08-15 起会话化，2026-08-18 起侧栏 SidebarStatus 悬浮会话面板亦可切换查看，旧「顶部 job 标签栏」形态已演进）。**submit_id 事件回填持久化**（Task 5，2026-08-06）：jimeng provider 拿到 submit_id 瞬间经 `Chunk::Submit` 回传，转发 task 立即 upsert GenJob.submit_id + 细粒度 status=querying（app 此后被杀也有 submit_id 续查）。**启动恢复**（Task 5 阶段1+2，2026-08-06）：app 启动 `generation_worker::spawn_recovery` 扫 `list_running` → 即梦 job + submit_id 后台 `query_result` 续查入库（`finalize_generation_assets` 复用 meta/caption/autoname）/ codex job 不可恢复 `mark_failed`（codex exec 无 resume-from-mid）；前端挂载 `loadGenJobs` 重建 genJobs。**同步 invoke 模型**（命令阻塞到完成，但 Tauri 后台 async 不冻结 UI）；**远端孤儿取回（阶段 3，2026-08-27 完成）**：启动 `spawn_orphan_scan`（延迟 15s、BYO 权益门控）调 `dreamina list_task --limit 20`，与本地已知 submit_id（task_queue 全状态 GenJob + generation_meta）比对，远端仍在 `querying`/`success` 且本地无记录的**图片**任务 emit `codex://jimeng-orphans` → 侧栏会话面板生成 tab 顶部提供「取回/忽略」；取回经 `jimeng_retrieve_orphan` 合成 job id 固定 `orphan-{submit_id}` 的 GenJob（幂等）复用 `recover_one_jimeng_job` 续查下载入库；`list_task` 多项包裹格式 spike 未实证，解析器对数组/`{tasks:[...]}`/单对象递归收集含 submit_id 的对象免疫。详见 [dev-doc/VIDEO-GENERATION.md](dev-doc/VIDEO-GENERATION.md)。

24. **Bowerbird Cloud 收费化边界（2026-08-08，2026-08-11 P6.1/P9-T5 收口，2026-08-12 Agent Runtime 扩展，2026-08-15 Cloud 生图异步化决策）**：云承载**只三件事**——账号（Auth）、积分（账本/预授权）、托管算力（官方 API 代理与内置 Skill Agent 执行）。**素材库、整库提示词、项目数据永不上云，不形成云端资产库/同步服务**；Cloud 生成/理解只有用户**明确选择**时才发送本次输入。异步图片生成与理解（2026-08-18 起理解同款异步化，开关 `UNDERSTAND_ASYNC`）允许把本次 prompt、明确选择的参考图（理解为单图）和产物放入**私有、job 隔离、短 TTL 临时工作区**，桌面确认下载后立即清理，输入/失败任务最迟 24h、最终产物最迟 7d；理解结果文本只短时投递（行内存放，输入对象过期清理时同步清空）。Agent Runtime 因跨步骤、审批和崩溃恢复需要，同样允许用户为该次 Run 明确选择的输入、目标、中间状态和产物进入私有、Run 隔离、短 TTL 临时工作区。长期只留不含用户内容的技术状态/usage/账务，本地素材库与本地任务历史仍是长期权威。日志只记 request/job/run id、user hash、service/skill、状态、时延与 usage，不记图片、目标/提示词正文、签名 URL。**门控单一事实源**：前端只镜像服务端派生的 `FeaturePolicy`（`effectivePolicy`/`canUseByo`/`canStartAnotherJob`，[entitlement.ts](apps/desktop/src/lib/entitlement.ts)），不散落 tier 字符串比较；UI、store、Rust command、后台自动分析与任务恢复都必须复核它。免费档只能使用 Cloud，Pro/Studio 才能使用 Codex/即梦本机 CLI。**积分三段式**：`credit_hold`（幂等、FIFO daily→sub→topup、行锁防透支）→ 上游 → `credit_confirm`/`credit_rollback`；异步任务先 `pending_settlement`，绝不在前端取消即盲退。方舟明确失败才回滚；Worker 已把请求发给方舟但连接丢失时必须记 `outcome_unknown`，不自动重试、不重复扣费，等待人工/后续可审计处理。**安全**：桌面端只持构建期内置、用户不可编辑的 publishable key + URL，refresh token 存 OS keychain（keyring）；secret/方舟/支付密钥只在可信服务端运行时（短请求 Edge Functions + 受限 VPS Worker），Worker 不持 Supabase `service_role`、不直连数据库；计费表 RLS own-row 只读 + 写仅服务端 RPC；`SECURITY DEFINER` 固定 search_path；webhook 常量时间验签。Entitlement 响应已上线 Ed25519 非对称签名（2026-08-27）：Edge 私钥签发（Secret `ENTITLEMENT_SIGNING_KEY`）、桌面构建期内置公钥验签（`BOWERBIRD_ENTITLEMENT_PUBKEY`，build.rs 注入），验签通过的快照才解锁 7 天离线 Pro 宽限，验签失败/未配置自动降级在线可信（signature_version=0 行为）；密钥对由 `gen-entitlement-keypair.mjs` 生成、成对轮换。H1（Supabase）/H2（方舟）已部署并通过东京节点真实积分出图闭环。**H3 支付延期（2026-08-11 用户决策）**：真实支付需先完成备案/商户资质，前置手续完成前不选/不实现真实 provider，`BOWERBIRD_PAYMENT_MOCK=true` 必须保持；Mock checkout/webhook 只作协议骨架，不能对外收款。恢复时必须重新核对当时的官方渠道文档并取得商户/沙箱凭据，微信/superun/Paddle 均未真实联调。当前线上同步过渡值仍为方舟图片 135 秒、Cloud 代理 140 秒、Cloud 理解 110 秒、桌面 Cloud HTTP 180 秒；图片生成与理解均已走 VPS 异步链路，不再受 Edge 请求 deadline 截断，Cloud 理解 110/120 秒仅在 `UNDERSTAND_ASYNC=false` 回退模式生效。**生图/理解等待铁律（2026-08-18 用户定调）**：只要方舟未返回错误就等待——Worker 调用不设 abort 超时、租约心跳续租、桌面轮询无总 deadline，绝不单方面截断；方舟明确失败才回滚/报错。Mock/真实选择只由可信服务端 secret 控制。详细方案见约定 25 与 [dev-doc/AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md)。

25. **内置 Skill Agent Runtime、Cloud 生成 Worker 与 Bowerbird Agent Kernel（2026-08-12，2026-08-15 VPS 可靠性优先，2026-08-20 首版 Skill 重定向，2026-08-21 统一会话详情）**：Bowerbird 只运行随官方 Worker 镜像发布、版本固定的**内置 Skill**；不接收用户上传/修改 Skill，不做 Skill 市场、任意代码执行、共享 Codex/即梦会员 CLI 或通用 Agent 平台。首版部署为 VPS 常驻 Worker 出站轮询 Supabase 控制面，Edge Function 负责 JWT/Worker Token、任务状态机、短时签名对象 URL、预算与结算，Worker 不持 `service_role`、不直接读写数据库、不开放公网业务端口。**Cloud 单次图片生成先于完整 Agent Runtime 接入 VPS**：它使用独立 `generation_jobs`，不伪装成 Agent Run；但复用 Worker 的 poll/claim/heartbeat、私有临时对象、安全日志和部署基线。Worker 调方舟同步图片接口时并发发送 Bowerbird 心跳；桌面轮询 Bowerbird `job_id`，不得声称能轮询方舟未提供的图片 task id。Harness 固定为自研 **Bowerbird Agent Kernel**：Skill 提供版本化 phase graph，模型后端只能返回当前 phase 的候选 action；`PhaseMachine`/`PolicyEngine`/`ToolDispatcher` 确定性掌握转换、审批、预算和副作用，所有外部调用使用 Kernel 派生的稳定 `call_id + args_hash` 与 prepare/submitted/complete ledger，Run 由版本化 snapshot 恢复且供应商隐式 session 不是权威。模型只可调用 Skill allowlist 中的确定性工具，不提供 shell、浏览器、任意 HTTP 或跨 Run 文件读取；首版单容器按 Run 隔离工作目录，不预先建设不受信代码沙箱。**不植入 OpenClaw、不复现 Claude Code**；未来 Claude backend 优先使用直接模型 API，Agent SDK 只有能关闭通用工具、降为相同 `ModelBackend` contract 并通过同一 eval 时才采用，不能接管控制面、计费和工具。Agent Run 使用独立云端状态源，不并入本地 generation `task_queue`；桌面呈现则与普通生成共用会话详情主区、侧栏会话入口和消息布局，不建立第二套窗口。 每次 Agent 发送必须创建新的 `run_id + conversation_id`，桌面按 Run 独立保留、恢复和切换，不得以“最新 Run”单值覆盖旧会话。最大预算先 hold，usage 逐项幂等记录且最终积分由服务端计算，审批暂停时释放 Worker 租约。个性化长期偏好留在桌面本地，单次 Run 只接收用户允许的只读 `PreferenceCapsule`；Agent 只能返回偏好候选，不能直接修改长期记忆。**模型 provider 分工**：Agent 文本回合（意图分析/计划/反馈诊断中的文本决策）走 **DeepSeek `deepseek-chat`**（支持 tool calling；`deepseek-reasoner` 不支持、不可用），本机出图/用户反馈后定向看图分别复用现有 GenProvider / UnderstandProvider，未来 VPS 分别为方舟 Seedream / 豆包 vision（DeepSeek 无视觉）；首次意图分析与计划阶段禁止看图。**开发顺序**：G0 Cloud 异步图片生成与 VPS 可靠性闭环**已完成上线**（0015 generation_jobs + 0019 understand_jobs，单容器双循环 Worker）；桌面 Agent 当前仍是约定 28 的 prompt 预处理基线，后续为 A2（VPS Agent Kernel）→ A3（约定 37 的 `bowerbird-controlled-image-edit` 动态规划执行闭环）→ A4（桌面接 Agent 会话/审批/反馈）。

26. **Agent 对话与独立视觉规范（2026-08-13；2026-08-20 对齐首版 controlled-image-edit）**：Agent 只支持三个结构化交互节点：计划前有限澄清、计划审批/修改、结果接受/重试反馈；工具运行期间不开放聊天。澄清模型只能提议，Kernel 按问题必要性、重复、次数和 intent field 影响决定是否询问；回答编译为 `IntentPatch`，变更已批准计划时必须使旧 hash 失效并重新审批。结果反馈若产生新增/换序/额外成本，同样必须形成 revision plan 并重新审批。**视觉规范按 2026-09-10 用户决策独立于项目**：用户在集合内点击“视觉规范”，再点击“开始提炼”，不要求创建、保存或选择所属项目。来源就是该集合内的素材，弹窗不新增上传入口，创作选择器不创建集合。开始后，已有 v2 品牌观察可复用，旧版或缺失观察由现有理解队列补齐，再由 Cloud 文字服务归纳视觉共性；仅处理本次明确选择的图片，不扫描项目或全库，不监听变化自动重算。开始前明示图片分析额度与总结费用；用户无需理解反推、覆盖率或规则强度；集合素材直接展示，不设折叠开关；规范详情、微调、试画与历史默认收起。结果经“保存规范”确认后在本地独立保存，仅刷新可选列表，不自动选用或替换已有选择；用户随后在创作对话框中选择，任何生成均可调用已确认版本；项目和来源集合删除不删除规范，项目物理清理保护规范引用的素材。生成只读冻结的 `VisualProfileCapsule`，当前明确要求优先，Agent/生成结果不能反写规范；重新总结创建新 draft，确认后才成为可调用版本。可选试画只用文字规则，未采用图片不入库。详细当前契约见本文件“视觉规范独立于项目”及 `dev-doc/AGENT-RUNTIME-PLAN.md` §8；旧“不读图/不自动补反推/归当前项目”约束已废止。

27. **本机 Agent 预览先行（2026-08-14；series-director 方向 2026-08-15 已被约定 28 取代，对应 checkpoint/审批/复检代码已删；本条仍有效的规则：`local_agent_runs` 隔离、ProseMirror 结构化输入为权威、DeepSeek key 不进 React）**：checkpoint 必须独立落 `local_agent_runs`，不得把 Agent phase/审批/工具账本塞进 generation `task_queue`；本机 Agent 复用现有 `GenProvider` 与 `UnderstandProvider`，但该预览不冒充 cloud lease、跨设备恢复或 Agent 统一积分结算已经完成。创作板 Agent 输入必须来自 ProseMirror 的原始意图 prompt、显式图片引用及其结构化连接，禁止把模板展开后的长 `expandedPrompt` 重新当作约定 37 的权威意图输入；模型负责语义判断与策略候选，引用绑定、计划 schema/依赖、禁止串扰、审批 hash、预算和实际工具调用均由确定性代码控制。DeepSeek key 仅从 gitignored `apps/cloud/.env` 由本地 Node 子进程读取，React 不持 key，release 构建不开放该入口；真实本机闭环验收后再移植 VPS。

28. **当前 Agent A/B 仍是常规生成的可选 prompt 预处理（2026-08-15，2026-08-18 拆为 A/B 双方案；多步骤首版目标由约定 37 另行覆盖）**：现有 dev 入口为互斥三态——**Agent A（子句挑选）**：模型只挑维度原文子句索引 + 职责归属，确定性编译器拼合（不改写任何反推正文）；**Agent B（skill 审查修复）**：输入含模板展开后的完整 prompt（`expandedPrompt`），按官方 `bowerbird-prompt` skill 审查修复；关闭时沿用原编辑器 prompt 直发。现有 A/B 只返回一段 prompt 并走一次原 GenProvider 生成，没有独立 Run、审批、工具 loop 或过程 artifact；prompt agent 只发送已选维度的文字反推数据，不读取图片。它们保留作 dev 基线，不得被描述为已经实现约定 37 的 VPS Agent loop。React 不持 DeepSeek key，开发态仍由本机 Node Worker 从 gitignored `apps/cloud/.env` 读取。

29. **Agent 模式不设参考图最低数量或固定职责维度（2026-08-15）**：Agent prompt 预处理允许 0 张参考图，也允许参考图未选择任何维度；选择维度时接受编辑器中的任意既有或自定义维度名，不要求凑齐“主体 / 构图 / 类型 / 风格”等固定角色。模型只能逐字回传实际存在的 `(assetId, dimensionKey)`，不得新增、遗漏或换绑；没有参考数据时只优化用户原始 prompt。当前仅保留每次最多 8 张参考图的输入体积上限，不构成最低数量或职责门槛。

30. **Agent 模式入口 release 门控：条件渲染隐藏，功能开发完还原两处即可（2026-08-16）**：发布安装包不含 Agent 对外入口——[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) 与 [GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) 的「Agent」开关包在 `{agentAvailable && (...)}` 条件渲染内。release 构建下 `local_agent_health` 被 `ensure_preview_enabled()`（`cfg!(debug_assertions)`，[commands/agent.rs](apps/desktop/src-tauri/src/commands/agent.rs)）直接拒绝 → 前端探活失败 → 开关不渲染；详情页 LocalAgentPanel 同理由 `if (!available) return null` 不渲染；agent-worker 也不进安装包（tauri bundle resources 只含 `extension/` 与 `samples/`）。dev（有 `apps/cloud/.env`）下开关照常可用，Agent 开发不受影响。**Agent 功能开发完毕后，只需把这两处 `{agentAvailable && (...)}` 包装还原为无条件渲染即可恢复对外入口**，无需剥离代码或维护发布分支。

31. **Cloud 生图档位数据驱动：service_costs 是菜单唯一权威，上新零桌面发版（2026-08-17）**：桌面创作板/编辑坞下拉的 Cloud 档位从 entitlement 的 `generation_services` 动态渲染——数据源是 `service_costs` 中 active 且 `parameters.label` 非空的 `image_*` 行（`parameters.sort` 排序、`unit_cost` 即积分）；**parameters 无 label = 不进菜单但保持可计费**（遗留 `image_sd` 即此形态，旧安装包依赖它）。上新档位只需：① `service_costs` 插行（label/sort/unit_cost）；② 需要独立模型时 VPS `.env.generation` 加 env 并 `--build` 重启（Worker 对未知 service 兜底 `ARK_IMAGE_MODEL`，不崩任务）；③ 桌面零改动。provider key 规范 `bowerbird-cloud-<service>`，桌面/云端全部按 `bowerbird-cloud` 前缀识别；遗留 key（裸/`-fast`/`-lite`/`-standard`）映射见 Rust `cloud_service_for_key` 与前端 `canonicalProviderKey`，新代码不得再引入枚举式档位定义。generate-proxy 侧校验恒为「`image_*` 形状 + active 行」双查——形状检查防的是把 `video_*` 等高价 service 当生图扣费，不可去掉。

32. **图片标注：analyses(kind=annotation) + 库根 annotations/ 临时缓存 + featureFlags 未完成功能门控（2026-08-18）**：标注是「画在图上的指令」，不是反推数据——坐标一律**火山 Seedream 交互编辑格式**（0-999 归一化整数；rect `<bbox>x1 y1 x2 y2</bbox>`、arrow 双 `<point>`；坐标相对最终输出图 = 发给模型的参考图）。两条出口语义不同：**入库** = ingest（source=annotation、命名「原名-标注」、跳过 auto-analyze）+ 坐标 JSON 落 `analyses(kind=annotation)`（payload schema 以前端 [types.ts](apps/desktop/src/lib/types.ts) `AnnotationMeta` 为权威，Rust 只读 `shapes[].token` 合成「标注」维度、格式异常静默跳过；caption 并存时「标注」追加在反推维度之后，多条取最新）；**不入库插创作板** = `<库根>/annotations/<ulid>.<ext>` + sidecar `{name,ext,annotation}` 临时文件（不写 DB、不自动清理——板草稿引用着；`generation_history` 参考反查未命中时从缓存 + sidecar 合成兜底）。`read_image_data_url` 只放行库根内文件（canvas 防污染 + 防任意本地图读取，canonicalize 防 `..\` 逃逸）。未完成功能统一走 [featureFlags.ts](apps/desktop/src/lib/featureFlags.ts) 条件渲染关闭 UI（首个：`PRESET_FEATURE_ENABLED=false` 隐藏「用途」入口），完成后改回 true 恢复——与约定 30（Agent release 门控）同款「条件渲染隐藏」模式。

33. **远程 prompt 配置：内置默认永远保留，远程只是覆盖（2026-08-18）**：桌面内置 agent 指令（首个：`understand_autoname` 生成图命名）可经 Supabase `prompt_configs` 表（0020）云端热改——entitlement 权益快照随 `generation_services` 同模式下发 enabled 行，桌面按 key 查找；**缺 key / disabled / 值空白 / 离线一律回落代码内置默认，内置默认不得删除**（远程是覆盖不是迁移，删行即回内置而非功能失效）。编辑 = Supabase Studio UPDATE 行，无 Edge 重部署、无桌面发版；RLS 拒绝全部客户端直读，仅 service-role entitlement 函数可读。校验：[check-prompt-configs.mjs](apps/cloud/scripts/check-prompt-configs.mjs)。

34. **生成会话续轮语义：会话共享状态 = 图片流，参考图/比例后端权威（2026-08-19）**：续轮（resume 同一 session）实际下发的参考图与比例由 `codex_create_image` 权威决定，前端只传显式挑选图与显式选档（`job.turns` 是易失内存，不得作为续轮参考图依据）。规则：① jimeng/Cloud 续轮**始终合并**会话「最后一个有图轮」的产出图（修改主体，产出在前、与显式挑选图去重截前 10）——「挑了新参考图就完全替代」是被实测否定的旧语义（见踩坑）；② 「自动」比例按**第一参考图**（续轮 = 上一轮产出）对数距离吸附 7 档显式下发（即梦 omit `--ratio` 固定回退 16:9）；③ **轮级重试/编辑 = 精确重放**（`exact_references=true`）：用该轮当时实发的完整参考图列表（`started` 事件回填 `GenTurn.refs`、meta 按轮 `references` 重建），不取会话最新产出——重试第 N 轮的基图就是当时的基图；④ **跨引擎切换 = 图片交接**：codex thread 看不到别家引擎的轮，上一产出轮非 codex 时显式附最新产出图；非 codex 原生会话切 codex 开新 thread（instruction 用首轮包装），meta `codex_thread` 字段为续接句柄（与即梦 submit_id 对称）使连续 codex 轮共享 thread；⑤ 簿记 session id 恒为会话首轮 id（meta / 前端 sessionId / 重启时间线 / 会话分组不因新 thread 或恢复续查撕裂）。

35. **维度车牌：CaptionSection.id 是维度引用的稳定身份（2026-08-20）**：反推 parse 签发 ULID（一次反推 = 一批新车），编辑保号（`rebuild_payload` 按 id/标题继承），标注维度 `anno:{analysis 行 id | 文件名 ulid}`。创作板维度 chip / 复用 sidecar 一律**车牌优先寻址**取「当下」title/body（改名/改正文跟随、跨图借用不断链；车牌全局唯一可全库扫），无牌旧数据回退「图 + 标题」寻址；「图 chip 被删、只借维度」的源图随 generation_meta `dimension_sources` 落库、复用时经 `dimension_assets` 回绑。text 序列化不携带车牌——复用重解析按 sidecar title 或「title+正文」全等回绑。

36. **Agent Z：dev-only 的 Claude Code TUI 互通实验，不进生图链路（2026-08-20）**：Bowerbird 侧只做「唤起终端 + 按键注入 + MCP 桥回传」，对话全部发生在 Claude Code TUI 里——**不建对话 UI、不落库、不占生成 job/ratio/provider/entitlement**；生图由 Claude Code 经 RPC `dreamina_generate` 回 Bowerbird 即梦通道（复用 provider 信号量与入库），反推经 `understand_asset` 复用反推链路。凭据/登录全在 TUI 内，Bowerbird 不经手。门控：`cfg!(debug_assertions)`（约定 30 同款 dev-only）+ `AGENT_Z_ENABLED` flag + `agent_z_health` 探活；实现仅 Windows（AttachConsole + WriteConsoleInputW）。`.agent-z/`（MCP 桥 + inbox）gitignore；桥脚本仅缺失时写（不覆盖手工调整）、mcp.json 每次重写。真机 e2e 测试 `#[ignore]`（需交互桌面会话），常规基线不含。

37. **首版 VPS Agent loop Skill 定为 `bowerbird-controlled-image-edit`，固定的是规划审批通路而非图片步骤数（2026-08-20，2026-08-21 补充交付规则；覆盖旧 `series-director` 首版顺序）**：这套用户侧系统的统一称呼是 **Bowerbird Controlled Image Edit Agent（Bowerbird 受控图像编辑 Agent）**，跨会话代码检索标识固定为 `bowerbird-controlled-image-edit`；底层通用基础设施称 **Bowerbird Agent Runtime / Bowerbird Agent Kernel**。行为基准为会话 `01a01dbf-72da-7cc1-b213-e69e44788b6b` 被用户认可的结果与方法，但其“2 个控制参考 + 3 个编辑阶段”只是该案例的 Agent 决策，不能固化为五步模板。用户在 Bowerbird 对话框开启 Agent 模式并发送**意图 prompt + 显式参考图**后立即建立一个 Bowerbird Agent 会话；Agent 的意图分析和计划回合都加载同一钉死版本的 Skill，但只读原始文本、引用 token/顺序和安全元数据，不看图、不反推、不生图；Skill 辅助识别最终主体/底图、保持/迁移/禁止项以及人物/产品/动作/服装/饰品/构图等高一致性信号，再选择 direct / controlled / staged-controlled 策略并输出可单步或多步的完整计划。未显式选择比例时，Kernel 在意图分析后使用最终主体引用的比例，不能按最后一张参考图决定；显式比例始终优先。用户批准后 Kernel 只执行批准的 `PlanStep[]`，任何新增/换序/成本增加必须重新审批；控制参考、中间图、最终图、事件和反馈都按 `conversation_id + step_id + role` 归入同一会话。桌面以成熟 Agent 时间线展示可审计的判断摘要、操作状态和每张过程图，但不暴露模型隐藏思维链；用户接受后，全部用户可见生成产物以同一 `generation_session_id=conversation_id` 组图入本地素材库，最终仍只有一张当前 final。初次结果后不主动质检或自循环；只有用户重试/反馈后才定向反推、回退到最早失败步骤并提出 revision plan。当前 Agent A/B prompt 预处理与 Agent Z/G 只是基线/实验，不替代该正式通路；权威任务卡见 `dev-doc/AGENT-RUNTIME-PLAN.md` v1.23。

38. **Controlled Image Edit Agent 的生图 provider 只替换执行器，不替换 Agent Kernel（2026-08-21）**：创作板当前选择 Cloud 时，批准步骤由 VPS 方舟 Seedream 执行；选择 Codex / 即梦时，仅把批准后的 `generate_image` 步骤通过 `agent_local_tasks` 停车交给桌面本机 CLI。意图分析、动态计划、计划 hash、审批、步骤 DAG、checkpoint、预算、artifact/usage ledger、反馈修订与恢复仍由 Bowerbird Kernel/控制面掌权，不把 Bowerbird Skill 安装进 Codex，也不复用 Codex thread 作为 Run 权威。每个本地步骤必须绑定稳定 `call_id`、只回一张图片并上传确定性 artifact key；Codex 用 `$imagegen` 显式触发生图、比例写进指令，上一步产物作为下一步附图。Codex/即梦图片生成本身记 0 Bowerbird 生图积分，但 Agent 的 DeepSeek 文本回合与反馈后方舟 Vision 仍按账本结算；Codex 同时消耗用户自己的 ChatGPT/Codex 订阅额度。本机 provider 仅 Pro/Studio 可用，服务端必须复核权益。

39. **Codex 与正式 Bowerbird Agent 暂时互斥（2026-08-25；覆盖约定 38 中“新建 Codex Agent Run”部分）**：真实 Codex Agent CLI 全链路已成功，但实测发现 Bowerbird Agent 先做意图分析/计划，Codex 执行时又进行自身思考与对话，形成重复编排并显著拉长耗时。当前产品选择：Codex 只走直接生成；正式 Agent 只允许 Cloud 或即梦。创作板在 Codex 下禁用 Agent，Agent 开启后切到 Codex 自动退出；Rust `cloud_agent_start` 与 Edge `agent-run` 同时拒绝新建该组合，不能只靠按钮置灰。Codex 本机任务协议、历史 Run 展示及已登记任务恢复代码保留，便于历史收尾与未来重新评估；恢复组合时必须先明确性能收益和交互价值，再同时撤销 UI/Rust/Edge 三层门控。

40. **Dreamina Agent CLI 真机 E2E 暂时跳过（2026-08-25）**：本次只跳过“即梦作为正式 Agent 批准步骤执行器”的真实 CLI 全链路验证；`agent_local_tasks`、确定性结果缓存/上传、checkpoint/ledger 恢复、历史任务收尾及即梦直接生成能力均保留。该未执行链路不得标记为已验证，但不再作为 A6/A7、发布或后续编码的阻塞项；后续会话不得自行要求用户登录、消耗即梦额度或恢复测试，只有用户明确提出时才重新启用。Agent Runtime A0–A7 按此范围收口；没有 A8 对外开放授权时，默认编码接续点为 `AGENT-RUNTIME-PLAN.md` 的 V1 本地来源文件夹与快照。

41. **HTML 排版只引入受限离线 renderer，不开放浏览器 Agent（2026-08-27）**：后续在 VPS 上增加独立、无公网入口和外网出口、无业务 secret 的 Chromium renderer，作为确定性 `render_html` 工具把当前 Run 内受限 HTML/CSS 与显式 artifact 渲染为视口/整页 PNG，并可从同一次整页像素结果纵向切片；禁止 URL、导航、点击、登录、Cookie、下载、JavaScript、shell、任意脚本、跨 Run 文件和宿主路径。能力可由版本钉死的官方内置 Skill 通过 Global/Skill/Run/Feature 四层 allowlist 调用，但不开放用户 Skill、热加载、插件或 workflow DSL。截图完成后不调用 Vision、不自动评分/修订/重渲染，只等待用户接受或放弃；用户若要调整需显式发起新 Run。权威任务卡见 `dev-doc/HTML-RENDER-PLAN.md`。

42. **未来内容能力统一接入一个云端 Agent，DSH + DeepSeek API 以可回滚方式渐进验证（2026-08-28；U1 技术入口通过）**：用户明确 HTML 长图、视觉受控和未来小红书等都应是同一 Bowerbird 云端 Agent 可调用的工具/能力，而不是各自拥有 Agent、Runner、会话、审批与恢复。此前真实验证表明：Codex 与 Bowerbird Agent 叠加会重复思考并显著耗时；HTML 首版虽完成安全 renderer 和正式 Run，却因独立 Skill 被限制为不看图、不用视觉设定、不生图、一次 compose/render，真实产品图 + 完整推文只能得到“原图 + Doc 式长文”。根因是通用认知/编排能力被切碎到各 Skill Runner，而非 renderer 失败。后续以 **DeepSeek Harness（DSH）+ DeepSeek 官方 API**作为通用 Agent loop 首选候选：DSH/DeepSeek 只负责文本模型循环、上下文、工具选择与取消；任何图片理解、结果检查等视觉能力一律通过 Tool Gateway 调用 Bowerbird 现有火山方舟 Vision，DeepSeek 代理必须拒绝图片输入，不启用 DeepSeek Vision 产品路径。Supabase/Bowerbird 继续唯一掌握账号、FeaturePolicy、积分、Run、计划审批、Policy、`call_id + args_hash` 幂等账本、Artifact/TTL、checkpoint 和终态。DSH 通过本机 stdio ACP 由 Worker 驱动，使用精确版本和最小 Profile，默认移除 shell/web/fs/subagent/任意 MCP/插件；所有副作用只经 Bowerbird Tool Gateway 二次校验。现有 Agent Runtime 与 HTML Runner 在迁移验收前保留为兼容/回退，不一次性重写；新能力默认只能新增 Tool 或输出配方/Skill，若要新增独立 Agent Runner，必须先证明不同信任域/所有权边界并重新取得架构决策。**U1 已用现有 Bowerbird Cloud DeepSeek key 实测双轮真实文本 tool loop 与在途取消；历史 DeepSeek Vision inline base64/multi-turn 结果只作兼容性记录，不进入产品选型。当前 npm `@deepseek-ai/dsh-acp@0.1.1-rc.2` 虽缺少 `session/list/resume/close` 和 usage/工具事件 wire，但这不再构成等待新版的总停工条件：rc.2 使用 connection-scoped fresh session，Worker/DSH 重启一律由 Bowerbird checkpoint + 已完成 Tool Ledger 结果重建新 session；不得把 DSH session 变成业务事实源。通用计划不得接受模型或 Worker 自报 credits；审批成本必须由服务端按可信 Policy、Run provider 与版本化 `service_costs` 计算，实际结算仍以逐 call usage ledger 为准，计划估算不能替代真实计量。** U2 只获准做隔离 Adapter / Tool Gateway 合同与重建幂等验证；全程不改生产 FeaturePolicy、不部署生产，失败再按专项止损。权威任务卡见 `dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md`。

43. **本项目 DeepSeek/火山方舟真实调用采用持续授权 + 事后透明报告（2026-09-01）**：用户已明确允许后续项目内 DeepSeek 与火山方舟/Seedream 调用，不再要求每次调用前重复询问；代码中的显式费用双闸仍保留，执行者可依据该持续授权开启。每轮调用后必须报告 runtime/Run、模型回合或图片数、token、Bowerbird credits、`provider_cost_micros` 与失败/`outcome_unknown` 探针，不能只报告最终成功样本。该授权只覆盖 provider 调用及其正常测试数据，不自动扩大到公开 DSH、永久删除账号、生产破坏性操作或其他外部变更。

44. **项目与画板合并为同一用户对象，创作会话降为项目内线程（2026-09-03；替代旧“一画板一会话”约定）**：用户侧“一个项目 = 一块无限画板”，创建、打开、命名、归档和删除均以项目为唯一一级生命周期；一个项目首版不得拥有第二块画板，也不再创建长期 `project_id=NULL` 的全局画板。画板保存项目内自由素材、便签、素材组、空间布局和多条创作线程；无父 prompt 创建线程，从结果继续、重试、跨 provider 或普通/Agent 互转沿用原线程。线程只负责本地因果归组和时间线聚焦，不是侧栏对象，也不得复用 Codex thread、即梦 submit id、Cloud generation job、普通 provider session 或 Agent `run_id/conversation_id`。普通生成和 Agent 各自执行/恢复状态机、FeaturePolicy、积分/usage、审批、TTL 与 Tool Gateway 保持原权威，只通过显式 thread link 向项目画板安全投影。项目素材成员、画板节点实例、中央库文件夹/分类/标签和画板素材组是四种不同关系；拖入、分组、隐藏节点不改变中央资产的整理或物理文件。删除项目默认删除其画板布局、线程和本地 links，保留中央资产；2026-09-06 显式可选物理清理扩展见约定 47。账单或低层执行审计始终保留，运行中任务必须先阻止。旧 CS0–CS7 和副本 191+24 来源回填仅作为未发布实现证据，旧 CS7-T6/T7 暂停，正式库保持 schema v20、legacy flag 开启；当前权威任务卡见 `dev-doc/PROJECT-CANVAS-PLAN.md` v1.0。

45. **桌面素材发现浏览器是主窗口内的工作区面板，复用来源站原生推荐且不扩大 Agent 浏览权限（2026-09-03）**：素材详情页根据 `source_url` 识别来源；Pinterest 首版以“在 Pinterest 发现更多”从详情页切入同窗面板，打开原 Pin 并由来源站自身提供相关推荐，普通站点只表述为浏览原始来源，不抓取、镜像或伪装成 Bowerbird 自有推荐。面板保留 Bowerbird 顶栏与侧栏，提供返回、前进、刷新、地址、系统浏览器回退和关闭后回原素材详情；网页区由主窗口中的原生 `source-discovery` 子 WebView 承载，仅允许无凭据的 HTTP(S)，拒绝下载，`target=_blank` 回收到同一面板，并使用持久浏览数据目录。默认 capability 必须按本地 `main` **webview** 精确授权而非按 `main` window 授权，使远程子 WebView 不获得文件、对话框、shell 或 Bowerbird IPC。此能力是用户主动打开的桌面浏览功能，与云端 Agent/DSH 的无浏览器、无任意 HTTP 边界及离线 HTML renderer 无关，不得借此向模型开放网页访问。

46. **统一 Agent 图片 Run 允许多个最终结果，同层生成不设额外并发上限（2026-09-03）**：覆盖约定 42 中“所有生成分支汇入唯一 final result”的旧限制。统一计划仍只保留一个 `finalize_output` 收束步骤，但它可以依赖多个生成步骤；这些直接依赖全部作为 `final_result` 交付，反馈停车、原子结算、桌面展示与本地组图入库必须保留完整结果集合，不能只选第一张。批准后执行按依赖 DAG 分层推进，每层所有已就绪的 `generate_image` 同时启动，不再增加 Run 内图片 semaphore 或按图片数量人为串行；测试账号立即适用，Pro 账号在获得 unified 权限后适用同一策略。已有计划最大步骤、预算预授权、人工审批、稳定 `call_id + args_hash`、durable ledger、Artifact/TTL、供应商容量与账号级 `max_parallel_agent_runs` 继续有效，这些不是图片分支并发上限。legacy `bowerbird-controlled-image-edit` 的单 final 与反馈修订语义保持不变；当前 DSH test-only 开放范围也不因本决策扩大。

47. **DSH 开发阶段优先通用编排与迭代，放宽流程约束（2026-09-05）**：按用户要求，同一个云端 Agent 依据意图发现/读取内置 Skill、按需看图和澄清，并组合生图、HTML 排版、渲染与检查；取消关键词触发的固定四步/禁止生图策略。信息区块与执行步骤分开计数（64/12），无输入图片允许规划；同一素材不同观察 focus 分槽、同 focus 幂等复用；模型参数错误应返回可修正反馈。开发代理每 phase 默认 32 个模型回合，规划/HTML 执行超时各 10 分钟；统一 Run 澄清上限 12 次。结果反馈在同一 Run 重新规划/审批，轮次进入调用与事件身份，保留历史产物。账号/Run 隔离、父进程凭据、预算审批与计量、幂等账本、离线 renderer 边界继续有效；不扩大公开 DSH 账号范围。本次源码实现与本地回归已完成，2026-09-05 已部署 Worker/Profile、两 Edge 与 0053/0054；旧失败 Run 不自动重跑，新版真实 provider 质量仍待实测。

> **约定 42 最新执行状态（2026-08-30）**：U2 的本地控制面、父进程能力桥、正式 planning processor/dispatch、真实 DSH/DeepSeek/方舟 Vision 旧纵切及只读候选均已通过。DSH 模型调用现改经每 Run 父进程计量代理：子进程只持 64 位短期 capability 与 loopback endpoint，真实 DeepSeek key/base/model 留在父进程；模型回合按稳定身份进入既有 durable ledger，SSE/usage 先落私有 diagnostic artifact，精确 token 再进 usage ledger，相同请求不重复上游，未知结果最小计量并停车。候选镜像 `sha256:b02ff28f…d8ba931` 已完成两个真实 DSH 模型回合、两个 durable succeeded model call、精确 12/4 + 12/4 usage、闭集工具、当前 Run 素材、审批停车和临时 home 清理；agent-worker **228/228** + TypeScript，Profile **13/13**。用户授权的真实-provider smoke 在首个模型回合收到旧代理统一映射的 HTTP 502，未进入 Vision 或输出最终摘要；配置结构正常，但无法从旧输出判定实际上游是 4xx 还是 5xx。代理现已保留原始上游状态并继续隐藏正文，测试与无网络候选复跑通过；未经用户再次明确授权不得重跑或标记真实新计量纵切通过。部署环境未开启闸门；migration `0047`–`0049`、Edge、VPS 与 FeaturePolicy 均未部署。下一步接其余工具。

---

> **约定 42 手动诊断补充（2026-08-30）**：最新真实输出确认前两个 DeepSeek 文本回合和一次方舟 Vision 已成功，第三文本回合失败；这纠正了此前“首回合/尚未进入 Vision”的判断。首次 safe code 被 reconcile 覆盖、fake usage 重复累计及成功合同少算一个文本回合三处已修复，当前基线 Worker 231/231、Profile 13/13、候选 `sha256:b84e9a7e…206d8`。下一次手动诊断应显示第三回合首次具体 safe code。视觉能力固定复用现有火山方舟 Vision，DeepSeek/DSH 不接图片。

> **约定 42 大 SSE 与视觉单路径补充（2026-08-31）**：第三回合首次具体码已确认为旧 `deepseek_response_invalid`，但该码同时表示空正文或超过旧 60 KiB，不能仅凭摘要断言根因。父进程代理现把完整 SSE 上限提高到 512 KiB，拆分空/超限安全码，并以 gzip+base64、原始长度和 hash 写入仍不超过 64 KiB 的私有 diagnostic artifact；恢复时有界解压并复核 SSE/usage，超过 64 KiB 的本地流已逐字节回放且只调用一次上游。现役 Profile 已删除 DeepSeek Vision 模型声明、专用 patch 与 smoke，视觉统一经 Tool Gateway 调用现有火山方舟 Vision。当前基线 Worker 234/234、Profile 13/13、候选 `sha256:fb9f6a6d…26a110`；真实 3+1 纵切仍待用户一次手动复验，未部署生产。

> **约定 42 正式验收与批准计划恢复补充（2026-08-31）**：真实 3+1 纵切已完整通过，结果为 `modelUsage/modelDiagnostics=3`、`visionUsage=1`、`durableSucceededCalls=4`、审批已保存、结构化视觉结果有效，DeepSeek/方舟 secret 均只留父进程。批准后执行不能只凭 `approvedPlanHash + plannedToolCount` 猜测步骤：fresh claim 必须同时提供控制面已批准 proposal 的短期签名 URL，Worker 下载后复核对象 SHA-256、闭集 schema、canonical hash 与步骤数；不得接受 DSH 或模型在批准后重述。该合同与本地 Edge E2E 已通过，Worker 236/236、Profile 13/13、候选 `sha256:7ac2b761…176503`；仍未部署生产。

> **约定 42 批准后首个执行工具补充（2026-08-31）**：统一 Agent 的 `generate_image` 不接受模型在执行期重述参数；Worker 必须从已签名且 hash/步骤数复核通过的批准计划实例化工具定义，固定 goal/prompt、输入 artifact、依赖、stage/final 角色与当前批准 hash，模型参数严格为空对象，call id 由父进程按计划槽派生。Gateway 必须精确比对工具定义绑定的批准 hash；所有付费生成步骤必须经依赖链汇入唯一 final result，unsupported tool 或游离分支在首个 provider 副作用前拒绝。provider 执行继续复用现有 Ark Seedream durable executor 与同一 Artifact/usage/restore/reconcile 账本。当前只开放该受限生图子集，最终结果停车等待接受，retry、HTML、检查与通用完成工具尚未开放。本地 Supabase/Edge 已用现有 Ark executor mock 模式跑通批准计划恢复、durable call、唯一 final artifact、单次 image usage、结果停车、accept 与 succeeded；生产 HTTPS 校验未放宽。基线 Worker 238/238、Profile 13/13、候选 `sha256:72e2cda4…09dd63`；未调用真实 Seedream、未部署生产。

> **约定 42 崩溃恢复补充（2026-08-31）**：provider 返回结果但 durable complete 尚未落库时，进程重建不得因内存索引丢失而盲目重做付费调用。Worker 只允许从当前 Run 的 `outputs/<64-hex-call-id>.<png|jpg|webp>` 确定性闭集路径恢复，必须重新校验图片 MIME、SHA-256 与扩展名，不扫描目录、不接受模型或外部传入路径。恢复后继续使用相同 call id 完成 Artifact/usage/durable complete；若 artifact 已完成但执行 checkpoint 尚未保存，processor 也必须从旧 checkpoint 派生同一 call id 并重放已有 durable 结果。两处进程死亡故障注入均证明上游调用、Artifact 上传和 usage 不重复；Worker 基线 241/241。含本修复的新候选镜像尚待 Docker 环境恢复后重建，旧 `sha256:72e2cda4…09dd63` 不代表当前源码；未部署生产。

> **约定 42 HTML 执行补充（2026-08-31）**：批准后的 HTML 执行使用独立 DSH session/Profile，只暴露 `compose_html` 与 `render_html`，不得把二者加入规划 session 的常驻工具面。当前批准 shape 严格为 `compose → render → finalize`，compose/render 必须绑定同一有序当前 Run 资源；不支持或漂移的计划在首个执行 checkpoint/renderer 副作用前拒绝。模型只生成经闭集安全校验的 HTML 正文，`render_html` 参数仍必须为 `{}`；HTML artifact、Run/lease/call identity 和批准 hash 由父进程绑定。用户可通过统一 input 的闭集 `htmlOutput` 指定 viewport/capture/background；旧输入补原安全默认，二者都在首次 checkpoint 冻结，批准后只读该值，不能由模型自然语言或部署配置决定。renderer 继续复用既有断网/sanitizer/sandbox/durable executor。崩溃重放与真实钉版 DSH + 假 SSE + renderer wire 组合 E2E 均通过，当前基线 Worker **249/249**、Profile **15/15**。

> **约定 42 HTML 检查与完成补充（2026-08-31）**：HTML execution Profile 的最终闭集为 `compose_html / render_html / inspect_artifact / finalize_output`，顺序只能是 `compose → render → [可选一次 inspect] → finalize`；规划 session 工具面不变。`inspect_artifact` 和 `finalize_output` 的模型参数都必须严格为 `{}`。检查时父进程只选择当前 Run 刚渲染的 full-page（无则 viewport）可见截图，把 Artifact id/SHA-256、`focus=layout` 和批准 step goal 绑定到既有火山方舟 Vision durable call；DeepSeek 不接图片，Ark key 不进 DSH。完成时 primary/visible Artifact 由父进程从 renderer 输出派生，模型不得提交 id、路径或 URL；该工具只产生完成候选，checkpoint、用户 accept/discard 与控制面事务仍是业务终态权威。真实钉版 DSH + 假 SSE + renderer wire + Mock Ark 四步 E2E 和 processor checkpoint 前故障恢复均证明 renderer/Vision 各执行一次。当前基线 Worker **252/252** + TypeScript、Profile **15/15**；未部署生产。

> **约定 42 视觉设定注入补充（2026-08-31）**：统一 Agent 使用的视觉规范只能来自 Run 启动输入中的 `VisualProfileCapsule`；父进程必须在打开 DSH 前复核现有 capsule 结构及去除 `hash` 后 canonical JSON 的 SHA-256，并把规范化值冻结进首次 checkpoint。规划和批准后 HTML compose 只读取该冻结值，明确目标优先，must/prefer 仅补任务未说明项，avoid 作为排除项，contentThemes 不得自动成为主体；capsule 始终是不可信只读上下文，模型和结果都无权修改或回写。首次 checkpoint 同时写来源/影响事件，至少包含 profileId/version/sourceScopeHash/hash 与 must/prefer/avoid。篡改测试和 prompt/event 断言均通过；当前基线 Worker **254/254** + TypeScript、Profile **15/15**。

> **约定 42 结构化计划 v2 补充（2026-08-31）**：统一 Agent 新规划使用闭集 `schemaVersion: 2 + contentPlan`；旧 v1 仅保留历史审批恢复兼容。v2 必须恰好为当前 Run 全部素材声明职责，信息架构必须显式绑定来源素材与文案来源，缺失素材必须选择生成/复用/不需要且生成项绑定批准的 `generate_image` 步骤；有冻结视觉档案时必须精确回写 profileId/version/hash，并列明实际采用约束及未误作主体的 contentThemes。Worker 在审批前复核完整覆盖、当前 Run 归属和档案一致性；Edge 使用同形闭集 parser 并再次查询所有计划引用素材归属。模型不得自报成本，Cost Policy v1 仍只按可执行 `steps` 估算。当前基线 Worker **256/256** + TypeScript、DSH Profile **16/16**；本机缺 Deno，Edge 原生测试尚未补跑，未部署生产。

> **约定 42 当前候选与 U3 视觉调用补充（2026-09-01）**：`understand_asset` 对每个当前 Run 素材只分配一个 durable observation slot；同参数重放复用已存结果，换 focus 必须在方舟调用前按 args drift 拒绝，避免 Agent 通过改焦点重复产生视觉费用。真实 U3 smoke 固定产品 `general`、风格 `style` 各一次，并仅对该 test-only ACP 将整轮时限有界提高为 180 秒；生产默认不随之放宽。包含该修正的本地只读候选固定为 `sha256:b238d6ef77c8a53707b7986ebf55e33be9113f2c19df02f51f3def356fe11864`（Docker inspect 165,741,401 bytes，用户 `node`），已在 768 MiB、1 CPU、128 PIDs、rootfs read-only、network none、`no-new-privileges:true`、`cap_drop: ALL` 和两个 32 MiB tmpfs 下连续两轮通过正式入口探针。探针自身也属于兼容合同：所有新规划 fixture 必须使用 schema v2；若继续发送 v1，被 Policy 拒绝后 fake model 无限重放造成的 OOM 不得误判为需要放宽运行内存。前一候选 `sha256:3a6b9f0a…59fd4a5` 不再代表当前源码；当前镜像未推送 registry、未部署生产。

> **约定 42 U3 真实计划验收补充（2026-09-01）**：真实类型产品规划第三次尝试已成功，使用 4 个 DeepSeek 文本回合、2 次火山方舟 Vision 与 6 个 durable succeeded call 提交完整 schema v2；产品图为唯一产品事实来源，独立排版图仅提供大字/留白节奏，参考图汉字、主体和黑白配色未泄漏，不可核验功效/成分不进入计划，视觉档案精确绑定。自动质量门和源图人工对照均通过，DeepSeek/方舟 secret 保持父进程隔离。审批显示的 9 credits 是后续 `compose/render/inspect/finalize` 执行增量估算，其中 1 次 Vision 是成品检查；已发生的规划 usage 继续按真实 ledger 独立结算。该成功只证明计划质量，本次 `generated/rendered/deployed=false`；真实 HTML 执行、盲评与成本/耗时比较仍需另行批准。

> **约定 42 U3 执行与盲评收口补充（2026-09-01）**：真实新链路已以 4 个 DeepSeek 回合、1 次 renderer、1 次方舟 Vision、50.499s 和 5 credits 完成 `compose → render → inspect → finalize`，产出 1080×4320 整页 + 4 切片。旧单-compose 同素材基线只花 5.947s/1 credit，但因模型写入 3 处 CSS 注释被 sanitizer 拒绝、无用户产物；该失败不得按成功基线美化。仅删除注释的视觉等价样本和新 U3 产物随机编为 A/B，映射 commitment `bf560f7d…697b1` 复算匹配；用户盲选 A，揭盲 A 为新 U3，因此 U3 “相对旧专项有实质提升”验收通过。新链额外 44.552s/4 credits 换取了可渲染、经 Vision 检查且用户盲选胜出的完整产物。该结论只关闭 U3 test-only 验收，不改变生产部署闸门。

> **约定 42 U6 统一入口与精确详情页补充（2026-09-02）**：DSH 是测试账号可选择的统一 Agent runtime/能力入口，不是“受控生图”按钮的另一种执行器。选择 `DSH · 自动选工具` 后桌面必须创建 `bowerbird-unified-agent`，由 Agent 根据目标选择受控工具；旧“受控生图”和“HTML 排版”只作为 legacy 专用 Skill 保留，不能影响 unified DSH 的能力决策。对含冻结长文的产品详情页，父进程策略必须要求 `compose_html → render_html → inspect_artifact → finalize_output`、拒绝 `generate_image`，并在 compose side effect 前逐行验证原文；模型没有权限通过选择图片模型来排长字。该策略已由两个真实 succeeded Run 证明，仍保持 test-only，不表示所有目标都必须走 HTML，也不表示当前视觉质量已达产品标杆。用户已为当前连续开发的 test-only 联调明确提供真实 DeepSeek、火山方舟与远端 test-only 部署的持续授权；后续在相同范围内不重复索取业务授权，只在调用和费用发生后汇报，范围扩大或生产发布不包含在该授权内。

47. **项目即画板：一个项目只有一块无限画板，创作会话降为项目内线程（2026-09-03）**：项目是用户侧唯一一级创作对象，也是标题、素材成员、生命周期和画板身份的唯一权威；视觉规范独立于项目，项目创作只引用所选版本；侧栏不得再列独立 creative session，也不得在项目内再创建或选择画板。无父 prompt 新建线程，继续、重试、历史轮编辑、跨 provider 与普通/Agent 互转必须沿用父输出所属线程；provider session、generation job、Agent `run_id/conversation_id` 只作底层执行/恢复身份。provisional 项目在首次拖入素材、非空有效草稿、手动命名、建组或发送前只存在前端，原样退出不落库；默认“请参考”、焦点/选区和平移缩放不算有效修改，首个 prompt 可自动命名但永不覆盖手动标题。删除项目**默认**只删除其画板、线程与 project-local links，中央素材保留。**2026-09-06 明确扩展**：在同一危险确认中提供默认不勾选的“物理删除独有文件”，仅在用户勾选后删除已确认的独有中央资产及安全文件；不恢复旧 MoveOut/写回 workspace。候选取持久 `project_assets`、画板资产节点及普通生成 session/线程映射、Agent 最终/产物关系的并集；其他项目成员、隐藏节点、归档线程/项目、草稿与节点 payload、生成归属/线程 links、保留执行记录中的输入引用、全局收藏/提示词绑定、所有独立视觉规范的关系或规则 JSON（包括历史上由当前项目创建的规范）、所有 local Agent 审计目标，以及其他资产共用的 store/thumb/origin 路径均受保护。`reference_count` 累计计数、当前筛选、可见列表、文件目录或单独 project_id 均不能证明独有；不明/损坏引用数据保守保留。文件只限当前中央库 images/thumbnails 中的安全普通文件：路径缺失、外部路径、目录、软链接/junction、与用户 origin 重合的资产整项保留；仅清理该资产明确登记的 store/thumb，不扩展到标注缓存、导出件或目录。确认显示素材数与去重文件数、共享/受保护数及“不进回收站、无法恢复”；后端在写事务内复查任务与确认集合/文件指纹，变化即要求重新确认。文件按独立恢复清单暂存后提交 SQL，失败回滚并恢复；提交后 unlink 失败返回 cleanup_pending，前端不得宣称全部完成，下次启动在 worker 前恢复/继续清理。未完成恢复前不得继续默认删除该项目。账单和底层执行审计始终保留（沿用资产外键置空契约），运行中任务先阻止；单素材的移出/物理删除行为不扩大。当前执行权威为 [PROJECT-CANVAS-PLAN.md](dev-doc/PROJECT-CANVAS-PLAN.md)，旧 [CANVAS-SESSION-PLAN.md](dev-doc/CANVAS-SESSION-PLAN.md) 只作实施证据。

**生成引用的局部落点（2026-09-06）**：普通图片/视频生成和 Agent 自动补入当前画板缺失的参考图时，只排列本次新增引用；先确定对应线程的指令/执行卡位置，再按卡片实际坐标和节点尺寸在附近分行放置，避开已有节点与素材组。新卡片初次移入当前视区时同步处理这些新引用；Agent 提示卡与执行卡分批到达时保留同次导入身份，用户已经移动、锁定或分组的图片不再跟随。恢复使用持久化卡片坐标，重复事件/重载不重排已有引用，不复制已有明确引用节点，不修改画板视口，也不改变普通拖入/导入路径。历史已经落在远处的节点不追溯搬动。

**次级任务与详情入口（2026-09-06）**：Status 收敛为顶栏最右侧的 28px 紧凑状态图标，不显示常驻文字与计数；与素材视图控制分组留距，图标与视图按钮保持同一水平中心线，小标题不参与按钮行对齐，状态明细通过 tooltip、可访问名称及展开面板呈现，不再在侧栏自动展开常驻任务列表；任务中心按需展开并避让画板缩放工具，卡片点击仍为项目详情主入口。项目检查器按需覆盖于画板右上侧，打开不压缩画板或移动缩放工具，编辑坞仍沿用原交互。运行/空闲使用品牌蓝与中性灰，待处理/失败有独立图标、文字和可访问名称；Esc 先关闭任务浮层，再服务详情或创作模式，关闭恢复入口焦点。底层执行、归属、计费与生命周期不变。

**提醒清除（2026-09-06）**：任务中心支持一次清除当前失败/待处理提醒，以素材库与账号为范围将提醒回执保存在本机 WebView localStorage；按稳定任务/轮次、审批/澄清、结果或失败身份识别，轮询重复推送和重载不恢复同一提醒，新轮次失败、新审批/澄清或结果变化继续提醒。清除只过滤任务中心与侧栏的提醒投影，不删除会话/任务/结果，不取消执行或修改审批、失败、计费、审计状态；画板卡片仍可操作，任务中心「查看已清除」可继续访问旧任务，进行中任务继续显示。写入失败时保留提醒并提示错误。

48. **项目工作区审计收敛：不迁移旧用户会话，保留资产与执行事实（2026-09-04）**：本轮明确放弃旧 `creative_session` 的用户侧列表、独立详情页、标题和历史 backfill，不再用兼容旧会话作为发布门槛；这不授权删除中央资产、物理文件、项目、计费、额度、普通 generation 或 Cloud Agent 的底层执行审计。桌面顶层只允许“素材库”与 `project(projectId)` 两种工作区；画板/时间线、普通与 Agent 共用的项目内检查器、唯一 composer 都归项目内部，全局任务中心只投影运行中、等待用户或失败待处理任务，不能继续充当历史会话导航。页面、选择与继续操作必须以 `projectId + threadId + nodeId` 定位，`assetId` 仅是内容身份；队列状态以 `task_queue.status` 为权威，投影重放不得复活终态任务或清除用户隐藏/布局。当前纠偏任务卡与 UI/架构契约见 [PROJECT-CANVAS-PLAN.md](dev-doc/PROJECT-CANVAS-PLAN.md) v1.5；正式库仍保持零写入，legacy schema 清理仅在新链路通过自动化、升级副本和 Windows 真机验收后另行执行。

49. **项目路由与画板持久化必须 fail-closed（2026-09-04）**：项目 enter/exit/delete/reload 共用串行 route controller；后端 active scope 成功后才能提交前端 route，所有异步完成都要复核 `projectId + routeRevision`。离开前必须先把整个工作区设为 `inert` 并移除编辑焦点，再同步提取编辑器内存草稿，最后按严格 FIFO write journal 落盘；首项失败时后续写入不得越过，后台 snapshot 不得覆盖本地未保存投影，路由必须拒绝切换。初始素材 launch 必须绑定目标 `projectId` 且消费后一次性 ack；持久项目 snapshot 读取失败必须阻断编辑并显式重试，不能降级成空白项目。项目删除必须由后端在同一事务内重新检查未完成 generation/Agent 与待入库结果，不能只信前端确认。对应实现与剩余门槛见 [PROJECT-CANVAS-PLAN.md](dev-doc/PROJECT-CANVAS-PLAN.md) v1.5。
**侧栏项目顺序（2026-09-06）**：收起圆标、展开项目列表及共享项目数据保持当前已有顺序；首次加载沿用既有列表顺序并在本机记忆。点击、进入、异步刷新、重新载入和普通重命名只更新选中状态或元数据，不按最近打开/更新时间重排；新增项目沿用置顶、删除项目移除，provisional 项目仍按原生命周期处理且不写入持久顺序。后端 `last_opened_at` 继续记录打开时间，路由与草稿失败保护保持有效。


50. **统一 Agent 的领域知识按需加载（2026-09-05）**：常驻上下文只提供通用目标、必要工具说明和权限/审批边界；HTML 排版、图片属性迁移及其他创作领域是 Skill 方法和工具能力，不在全局指令里用关键词强制路线，也不追加“某类任务不要用某工具”的案例补丁。Skill 目录只含名称与简短说明，`read_skill` 返回选中的领域方法，不返回 legacy Runner 的阶段限制、独立计划模型或单产物约束。新计划只要求实际执行步骤，不强制所有任务填写 contentPlan/信息架构/缺图分析或回写视觉档案 hash；用户已选且已确认的视觉规范仍是当前任务的只读背景，控制面继续负责其完整性与冻结。渲染默认参数只在批准后的相应工具执行阶段提供；模型恢复上下文必须显式投影所需事实，禁止序列化整个 checkpoint。此约定覆盖约定 42 中旧的强制 schema v2、领域路线和全局方法注入要求，旧批准计划及审计数据保持兼容。

51. **统一 Agent 与 Kernel 的职责（2026-09-05）**：用户确认目标架构为一个 Agent 根据目标、观察与工具结果决定下一步；Kernel 负责授权范围、预算、幂等、持久化、恢复与取消，不预写领域执行路线。HTML、品牌视觉方法及后续能力均为按需工具/Skill，不能通过新增领域 Agent Runner 扩展。审批绑定目标、素材、交付数量、可用能力及调用上限，不冻结后续步骤；旧版精确步骤审批按原契约恢复，不能静默扩大授权。**v3 动态执行主链已于 2026-09-05 部署至测试范围**：统一 DSH Profile 通过 `call_tool` 使用生图、检查、HTML 编排/渲染及交付工具，每次动作与结果持久化，恢复沿用调用身份，同一逻辑 Agent 根据结果继续，无新领域 session。十张场景图并发生成、选择性检查、仅返工一张与完整交付，以及 HTML 检查后重排的模拟模型集成回归通过；真实模型自主选择与质量尚未验证。用户明确“测试期间不需要固定预算”：测试账号服务端按授权资源上限估价、原子追加预授权，30 积分仅为创建时初始占用，不是任务上限；保留账号实际积分、全局成本门控、逐调用计量和失败回滚，不新增手动预算入口。migration `0055`/`0056`、agent-run v48 / agent-worker v54 与 Worker/Profile 已上线，桌面适配保留本地源码、安装包未发布；证据及边界见专项计划。

**画板选择与主动整理（2026-09-06）**：Ctrl/Command + 点击可追加或取消节点选择，Ctrl/Command 框选保留已有选择。节点右键“整理”以当前所选节点为起点（右键未选节点则只取该节点），沿连接方向收集当前可见的后续卡片；素材组成员和 Agent 隐藏提示卡映射到可见容器。按连接层级对齐、留出间距，并整体避开未参与整理的卡片；不移动上游或无关卡片。整理后整组选中，节点/素材组坐标沿用现有画板写入队列持久化；不更改线程、连接、素材归属或执行记录。

## 踩坑记录

### 首轮生成 payload 无 session_id 导致重启后历史为空（2026-09-14）

首轮任务 payload 在 provider 返回前保存，可能没有 session_id，旧恢复入口只按该字段取历史，已完成生成会被误呈现为未开始。现按 job_id 查询已入库 generation_meta 找回实际 session_id，再复用完整会话重建；产物已移除或读取失败时，前端仍保留原始提交轮与失败信息，不伪造生成结果。Rust 临时库测试覆盖首轮找回、续轮合并、无关会话隔离和未知 job。

### 收起项目区域不接收本地拖图（2026-09-11，已随本次重新打包）

`LibraryHome` 有项目时把项目卡片放在 `MasonryGrid` 外，而旧文件导入监听只在瀑布流容器上，所以项目区域与工具栏等处没有拖入提示，也不导入。外部 `Files` 现在由常驻 `FileDropImport` 在窗口捕获阶段统一接收，显示全局提示并阻止嵌套重复导入；松手时冻结目标，项目卡片/侧栏项目优先，否则取当前项目或中央库。集合弹层保留原有集合入口，应用内素材/文本/探索协议拖动继续由各自处理；画板落点复用现有坐标冻结与节点写入接口。已移除瀑布流局部文件监听，空批次/不支持格式/单张失败均反馈。新增 `test:file-drop` 覆盖收起/展开项目、图片子节点、工具栏/搜索/侧栏/空白、切换期间归属、部分失败、离开清提示与内部拖动；原项目拖图、集合界面及 TypeScript/production build 回归通过，未改真实素材库；本次综合存档已重新打包。

### 本地导入、Agent 整组确认与面板拖动修复（2026-09-11，已随本次重新打包）

- 本地文件导入曾共用网页采集的近似 dHash 去重，可能吞掉相似构图/修订图；文件失败又被逐个忽略，顶栏不检查返回数量就提示成功。显式文件/目录/本地字节导入现在仅按完整文件字节合并，缺失库文件不算重复，损坏光栅图不落库；带来源 URL 的网页采集保留近似去重。顶栏按实际返回数量报告，空结果报错，部分失败单独提示，完成后仅在原路由清空筛选；项目关联失败明确告知已入中央库但未加入项目。文件/目录导入补发素材变更事件。
- Agent 后端整组标识曾额外做 SHA-256，前端却拿原始 `runId:artifactId:sha256|…` 比较，导致已落库仍反复报“持久化确认尚未完成”。两端统一排序去重后的原始标识，并用共享 wire fixture 验证；旧哈希 checkpoint 从已有 receipt、资产映射、项目成员和画板节点重建，不重新生成/扣费。任务中心 Agent 行增加独立清除按钮，沿用持久提醒回执，保留执行与产物。
- 面板拖动不再每个 pointermove 更新整棵 React 状态树：主侧栏/画板素材栏即时写布局，松手或丢失捕获时保存；瀑布流在尺寸稳定 120ms 后重新分列，缩略图使用 memo。真实组件合成测试连续 35 次移动为 0 次画板提交，松手宽度与重载恢复通过；该数字不是 Windows 原生窗口帧率。
- 验证：画板/路由/Agent/提醒契约 118 项；Rust 入库 15 项（视频工具项 1 ignored）、Agent 23 项；`desktop-reliability-ui.test.mjs` 与 `canvas-toolbar-ui.test.mjs`、TypeScript/production build 通过。测试使用临时库和合成 IPC，未操作真实用户库或调用 provider；本次综合存档已生成新安装包，原生窗口流畅度待真机验收。

### VPS 视频依赖必须同时包含 ffprobe 与跨包契约（2026-09-11）

本地 Worker 可以导入兄弟目录的 Cloud 视频契约，但旧独立镜像只有 `/app/src`，既没有 `/cloud/supabase/functions/_shared/video-contract.ts` 也没有 ffprobe，直接只同步源码会造成启动或媒体探测失败；原 64 MiB /tmp 还会拒绝规格允许的大文件，已调为有界 640 MiB 并以 500 MiB 合成 MP4 验证。Dockerfile/Compose 新增最小 `cloud-shared` 构建上下文并安装 ca-certificates/ffmpeg；候选与现役镜像用合成视频探测验证生产导入路径。VPS 默认 Debian 源下载缓慢，临时发布层改用腾讯内网 Debian 镜像并保留 APT 签名校验；镜像缺 CA 时先从签名校验的 HTTP 源安装证书，未关闭 TLS 校验。仓库源码测试依赖夹具和可写工作目录，不能将精简只读容器中的夹具缺失误记为功能测试通过或放宽生产权限。

### 画板右键菜单让探索浏览器看似反复刷新（2026-09-11）

- 根因：SourceBrowserPanel 发现任意 `role=menu` 就隐藏原生 WebView，未判断菜单是否与浏览器相交；隐藏后露出恒定的“正在打开”转圈占位。隔离真实 CanvasWorkspace 右键测试复现错误的 `visible:false`，并非代码主动发送 reload。
- 修复：菜单仅在矩形覆盖浏览器 viewport 时临时隐藏，对话框保留整体遮挡保护；临时隐藏使用独立说明，布局/可见性不变时不重复调原生接口。新增连续右键、覆盖菜单移开/隐藏、无导航/刷新及调用去重的前端回归；用户窗口和实际站点尚未复测。

### 探索拖图不能只监听 IMG 的 document dragstart（2026-09-10）

- 用户反馈内置浏览器所有站点拖图松手无反应。隔离 Chromium 复现：图片上方透明链接产生的是 `A` 拖拽，旧脚本未写图片元数据；站点 window capture 又可先于 document 监听取消拖拽。仅合成 IMG DragEvent 的旧测试漏掉了这些路径。
- 修复：按指针位置识别同一卡片内图片，临时启用拖拽并覆盖 CSS 禁拖、结束后恢复；在初始化时注册 window capture 监听，避免站点提前取消。无效采集协议增加通知。普通图、链接/div 遮罩、CSS 禁拖、站点取消 5 类后台回归通过。
- 隐藏 WebView2 验证浏览器生成的元数据经 CDP 传至另一个视图、标准文本兼容及带 Cookie 取图；随后用户复测确认“采集成功了”，故障已闭环。未逐站列明验收范围，不能把这些隔离复现说成所有真实站点的已确认根因。复跑见 [EMBEDDED-BROWSER.md](dev-doc/EMBEDDED-BROWSER.md)。

### 画板复用已归属线程的参考图，生成在本地启动阶段被拒绝（2026-09-06）
- 现象：12:27–12:30 四次普通 Cloud 生成均失败，任务 `b84a88ac…` 等报 `reference node gen-reference:768f8b26… belongs to another creative thread`；12:21 的原任务成功。新任务的画板投影事务回滚，因此提示用户去找任务卡片可能无处可看。
- 根因：新意图创建新线程，但选中的参考节点保留上次生成的线程。普通/Agent 参考校验、输入边 Rust 校验与 SQLite trigger 都把参考复用误当续作归属冲突；旧回归仅覆盖 `thread_id=NULL` 的自由参考。该错误发生在 provider 调用之前。
- 修复：只允许同项目 `asset/reference → input` 跨线程复用，精确节点与唯一素材回退均复用原节点，不改原节点位置、线程或执行身份；其他边和父结果继续严格校验。新增 0024 migration 替换输入边 trigger，不更改既有数据行。`startGeneration` 返回实际启动错误，创作器直接展示；普通生成并发已满时显示禁用原因。
- 验证：修改后的 fixture 在修复前复现同一错误；Rust 画板 **15/15**（含 v23→v24、直接 SQL 拒绝跨项目/错误目标线程/跨线程结果、普通与 Agent 参考复用）、前端画板 **108/108**、TypeScript 与 Vite build 通过。开发 watcher 自动重编译并重启，12:36:53 启动的新进程已运行，实际库只读核对为 v24 且新 trigger 存在；因此不能宣称本轮实际库零变更。复制库重装 trigger 前后全部数据表内容 hash 不变，integrity/foreign_key 检查通过。未重发真实生图或改写失败任务；“点击没反应”尚未独立复现，不能把禁用提示改善当作该现象根因已确认。证据 `.tmp/canvas-generation-fix/`。

**8bf74b07：缓冲代理与客户端超时不一致、持久化异常被遮蔽（2026-09-06）：** 模型代理先收齐上游 SSE、写诊断和usage，才回传DSH；因此原生 streamIdleTimeoutMs=60s 实际覆盖的是整个模型调用及保存，而非上游流空闲。代理默认上游期限90s，客户端可能先退出。原生回归故意延迟首回复61s后仍须完成压缩和交付。执行 Processor 旧catch在proxy.close/drain之前读lastErrorCode，可能拿不到迟到持久化异常，最终用户只见agent_run_failed。现先drain再选错误；response_id/diagnostic/usage分别保留安全错误阶段，对同一callId/hash的明确HTTP500/502/503/504持久化操作只重试一次，不重发模型。历史8bf调用已存provider_request_id但无诊断artifact/usage，原始异常没留存，不能把时间吻合当作已证明唯一超时根因。

**DSH 配置补丁不是逐字段合并（2026-09-06）：** `cordis.bridge.patch.yml` 对 `llm-deepseek.config` 设置 models 时会整体替换原 config，不能假设继承 `cordis.patch.yml` 的 thinking/apiKeyEnv/timeout。03:53 上下文改动因此遗漏原有 `thinking: disabled`，真实复测第4轮返回 finish_reason=length，8,000 completion tokens 全部为 reasoning tokens，无正文或工具。必须以 `--dump-config` 和真实发给代理的请求断言为准。已在 bridge 补齐 apiKeyEnv、thinking、reasoningEffort、maxTokens、streamIdleTimeoutMs，原生上下文 E2E 新增 request.thinking={type:"disabled"} 断言；保留 DSH 会话/工具循环，未新增自动重试或自建思考流程。

### DSH 的父工具并发不等于真实 DSH 调度并发（2026-09-05）

`AdaptiveToolGateway` 的并发单测通过并不能证明 DSH 插件会并发。钉版 dsh-tools 仅在工具 `isConcurrencySafe(args) === true` 时并发，否则同一模型响应里的多个调用也串行。修复为生图/检查显式分类可并发，Kernel 原子额度与 durable slot 仍负责隔离；新增真实 DSH/假 SSE 八调用测试防回归。同时 ACP `prompt` 覆盖完整 Agent 工具循环，不能把 provider 等待计为模型卡死；使用父 Bridge 活动判断超时，工具结束后重置无进展窗口。其他旧专用 Runner 的超时保持原契约。

### 从画板移除缺少撤销与历史卡片恢复入口（2026-09-05）
- 当前约定（2026-09-05 用户纠正）：只保留非编辑状态 Ctrl/Cmd+Z 按移除批次恢复素材、组及生成卡片；不新增撤销按钮或找回下拉菜单。此前下拉菜单挤压工具栏导致文字竖排和高度异常，已移除。素材从素材库重新放入，生成卡片从生成会话查找。项目切换清空本地撤销栈。
- 边界：恢复隐藏节点只清除 hidden_at，不重写执行状态、位置或边；自由素材节点被删除时按移除快照重建，中央资产本身的物理删除不属于此撤销。历史自由素材删除不具备跨重启撤销记录。
- 验证：混合批次/素材组撤销与最新执行状态保持回归；后端恢复校验项目归属，幂等清除隐藏标记。


### 生成对话卡片未纳入框选与混合拖动（2026-09-05）
- 根因：框选命中与选择清理仅遍历素材 UI 节点，生成指令/Agent 执行组使用另一套单节点拖动状态。
- 修复：框选包含可见且未归档的执行卡片；从素材或执行卡片开始拖动均对整组选中项施加相同位移，吸附排除选中项。松手分别保存素材/素材组与执行卡片布局，取消或 Escape 同时恢复两类布局；连线跟随实时位置，混合选择也支持统一移除。
- 验证：实际事件处理回归覆盖从两类节点起拖、保持相对位置、保存所有选中项及取消回退；隐藏/归档执行卡片不参与框选。


### 生成卡片仅取消状态能移除，Agent 执行组缺少入口（2026-09-05）
- 根因：生成指令的移除按钮被限定为 `cancelled`，Agent 执行组无按钮；全局 Delete/Backspace 只处理素材选择集合。
- 修复：两类执行卡片在所有状态显示移除按钮，并支持卡片聚焦时 Delete/Backspace；按钮阻止拖动和详情点击冒泡。继续使用后端隐藏节点接口，保留执行记录且状态刷新/恢复不清除隐藏标记。
- 验证：实际 JSX 与事件处理回归覆盖两类卡片的创建、运行、待审批、失败、成功、取消状态；补充移除生成指令后重放及成功状态更新仍保持隐藏的 Rust 回归。


### Agent 生成仍复制画板参考图并不断向右延伸（2026-09-05）
- 根因：此前仅普通生成传递并复用 `referenceNodeIds`；Agent 的三种入口只传资产 ID，本地 `begin_project_agent_launch` 每次按 launch 创建参考图副本。两种生成的 prompt 初始位置又取整个画板最大右边界，导致重复生成持续右移。
- 修复：Agent 显式传递选中节点并持久化到本地 launch 快照，校验项目、线程、素材与可见性；旧输入仅在唯一匹配时复用。新 prompt 以输入节点/素材组为位置锚点，在右侧纵向寻找空位；恢复沿用既有边并保留手动布局。已被执行引用的自由素材移除时隐藏，避免破坏边或恢复时重造引用图。
- 验证：新增精确实例、跨线程共享自由参考、连续生成不右移、分组位置、隐藏与恢复回归；仅修改本地桌面投影，不迁移既有重复节点。


> 记录已踩过的坑、根因与绕过方案，避免重复。

条目格式：
```
### <简短标题>（YYYY-MM-DD）
- 现象：
- 根因：
- 解决 / 绕过：
- 相关文件：
```

### 全局“移出园丁鸟”把任意项目引用误判为共享，导致刷新后素材复活（2026-09-04）
- 现象：在中央素材库选中图片后执行“删除 → 移出园丁鸟”，界面提示成功，但刷新后图片仍存在。
- 根因：`delete_asset_with_mode(MoveOut, project_id=None)` 的共享判定用 `project_id != COALESCE(NULL, '')`，因此只要素材属于任意项目就进入“共享素材仅移出当前项目”分支；此时又没有当前项目可删，最终是零写入。批量栏同时忽略结构化 `failed_moves`，会把未完成操作提示成成功。
- 解决 / 绕过：共享判定只在项目视图提供明确 `project_id` 时生效；中央素材库的“移出园丁鸟”在恢复原文件后删除中央资产行，并由外键清理全部项目成员关系。批量栏必须检查 `failed_moves` 和全局删除计数。兼容旧数据中 `store_path == origin_path` 的记录时，只删 DB 与独立缩略图，绝不删除用户原文件。
- 相关文件：[projects.rs](apps/desktop/src-tauri/src/core/projects.rs)、[library.rs](apps/desktop/src-tauri/src/commands/library.rs)、[BatchBar.tsx](apps/desktop/src/components/BatchBar.tsx)。

### 字节采集/拖入图的 origin_path 是已清理临时文件，不能执行“移出园丁鸟”（2026-09-04；2026-09-05 补充）
- 现象：浏览器采集图先按 `source=extension` 置灰后，部分拖入图片仍可点击 `move_out`，但执行时报“删除失败”。
- 根因：扩展上传、WebView 拖入/剪贴板等路径先把字节写入 `bowerbird-upload-*` 临时目录，再复用 `ingest_file`；其中拖入图仍标记为 `source=imported`，不能只凭 source 判断。入库后的 `origin_path` 指向随后被清理的临时文件，移动目标的父目录不存在，故文件恢复失败。
- 解决 / 绕过：能力判断同时检查来源与原始路径：`source=extension`、空 `origin_path`，或 `Temp/tmp` 下已知的 `bowerbird-upload-*`、`bowerbird-cloud-*`、`bowerbird-dreamina-*` 临时目录均不可 move out；单图右键置灰，批量选择只要包含不可移素材就整体置灰，Rust 数据层同样拒绝。新字节/URL 入库仅在确认为本次临时源时把 `origin_path` 置空，去重命中既有本地文件时保留其稳定原路径。
- 相关文件：[assetDeletion.ts](apps/desktop/src/lib/assetDeletion.ts)、[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs)、[AssetContextMenu.tsx](apps/desktop/src/components/AssetContextMenu.tsx)、[BatchBar.tsx](apps/desktop/src/components/BatchBar.tsx)、[projects.rs](apps/desktop/src-tauri/src/core/projects.rs)。

### 生成完成事件落在画板监听器重绑空窗，结果刷新后才出现（2026-09-05）
- 现象：项目内生成已经成功、结果也已入库，但当前画板不立即显示输出节点；刷新应用后节点才出现。
- 根因：`CanvasWorkspace` 的 `creative://changed` 监听 effect 依赖 `assetById`。生成收尾先触发素材入库刷新，Map 变化令 React 清理旧监听器并异步注册新监听器；紧随其后的 `status=done` 事件可能落在两者之间。后端图投影已经提交，因此刷新读取 SQLite 时又能看到结果。
- 解决 / 绕过：创作事件监听器只随项目身份切换，在同一项目整个生命周期内保持挂载；事件处理读取 `assetByIdRef` 和当前画板 refs，素材刷新不再重绑监听器。
- 相关文件：[CanvasWorkspace.tsx](apps/desktop/src/components/CanvasWorkspace.tsx)。

### 残留桌面进程会在启动时改写正式 SQLite schema（2026-09-03）
- 现象：计划按只读方式审计正式 `library.db` 时，数据库已从预期 v20 变为 project-canvas v23，容易误以为 backfill v2 已经执行。
- 根因：此前启动的 Bowerbird/Cargo 子进程仍持有正式素材库配置；Tauri 启动会自动执行本地 schema migration，关闭可见窗口不等于相关进程全部退出。
- 解决 / 绕过：任何正式库 preview/备份前先枚举并关闭 Bowerbird、Cargo/rustc 与 dev server 进程，再记录 schema 指纹、文件长度和 mtime；开发运行统一设置 `BOWERBIRD_LIBRARY_ROOT_OVERRIDE` 指向 SQLite Online Backup 隔离副本。schema migration 与 backfill 账本分开审计，v23 不能推导为 v2 已回填；正式回填仍需单独授权。
- 相关文件：[lib.rs](apps/desktop/src-tauri/src/lib.rs)、[project_canvas_backfill.rs](apps/desktop/src-tauri/src/core/project_canvas_backfill.rs)、[PROJECT-CANVAS-PLAN.md](dev-doc/PROJECT-CANVAS-PLAN.md)。

### 统一 Agent 主产物策略只改 Edge、未同步数据库结算（2026-09-02）
- 现象：真实 HTML 四工具链已到 `awaiting_result_feedback`，接受结果后 checkpoint 显示 succeeded，但 `finish` 返回 409，Run 最终按失败路径结算为 `agent_control_http_409`。
- 根因：Edge 等待反馈已允许 `bowerbird-unified-agent` 在没有 `final_result` 时使用唯一整页/viewport 截图，数据库 `settle_agent_run` 仍只对专用 HTML Skill 接受截图，unified 被旧的 `final_result` 规则拒绝。
- 解决 / 绕过：migration `0052` 使原子结算与 Edge 使用同一策略：专用 HTML 只认唯一截图；unified 优先唯一 `final_result`，没有时认唯一截图；其他 Skill 仍只认唯一 `final_result`。迁移 dry-run 确认只应用 `0052`，远端推送后两个真实 Run succeeded 且积分对账。
- 相关文件：[0052_unified_agent_html_run_settlement.sql](apps/cloud/supabase/migrations/0052_unified_agent_html_run_settlement.sql)、[agent-result-artifacts.ts](apps/cloud/supabase/functions/_shared/agent-result-artifacts.ts)、[agent-worker/index.ts](apps/cloud/supabase/functions/agent-worker/index.ts)。

### HTTP socket 关闭不代表计量代理的异步 handler 已结束（2026-09-02）
- 现象：一个 `dsh_acp_prompt_timeout` Run 终态实际结算 9 credits，但约 1 秒后又登记一条 DeepSeek usage，形成 10 usage credits / 9 settled credits 的历史测试差额。
- 根因：`MeteredDeepSeekProxy.close()` 先 `closeAllConnections()` 再等待 HTTP server close；socket 已断开时，已接受的 async handler 仍可在后台等待上游响应并持久化 usage，Worker 却已进入失败结算。
- 解决 / 绕过：proxy 关闭先停接新请求、断开子进程连接，再等待全部已接受 handler 完成；上游 fetch 同时绑定既有 90 秒超时。新增回归明确证明 `close()` 不会早于在途 usage 持久化返回。修复前测试差额保留为证据，不追改历史账单；修复后的真实成功 Run 均逐项对账。
- 相关文件：[metered-deepseek-proxy.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.ts)、[metered-deepseek-proxy.test.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.test.ts)。

### Docker Desktop 按用户安装时 Engine 在运行但 Codex 找不到 CLI（2026-09-01）
- 现象：Docker Desktop/Engine 进程均在运行，但 Codex PowerShell 的 `docker version` 报命令不存在；标准 `C:\Program Files\Docker\...` 路径也不存在，曾误以为只能等待用户修复 Docker。
- 根因：本机 Docker Desktop 安装在当前用户目录，CLI 实际为 `C:\Users\Hins\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`，该目录没有进入当前 Codex 进程的 PATH。
- 解决 / 绕过：先从 `Get-Process` 的 `ExecutablePath` 定位 Docker Desktop 根目录，再以 CLI 绝对路径调用并验证 client/server；不要只检查系统级默认路径或把 Engine running 等同于 CLI 已在 PATH。
- 相关文件：[compose.unified-harness-candidate.yml](apps/agent-worker/compose.unified-harness-candidate.yml)、[UNIFIED-HARNESS-RUNBOOK.md](apps/agent-worker/UNIFIED-HARNESS-RUNBOOK.md)。

### pnpm 11 的项目设置与 run 参数语义会让依赖修复“看似成功、实际未生效”（2026-09-01）
- 现象：把 `pnpm.overrides` 写入 Profile `package.json` 后，pnpm 11 只警告并忽略；另按旧 Runbook 执行 `pnpm run sbom:unified-harness -- <profile> <output>` 时，`--` 被原样传给 Node，脚本把它当成 Profile 路径。直接依赖升级后顶层显示 `js-yaml 4.3.1`，镜像复扫却仍发现 DSH 精确依赖的隐藏 `4.2.0` 副本。
- 根因：pnpm 11/12 已把非 registry 项目设置迁到 `pnpm-workspace.yaml`；`pnpm run` 的参数分隔行为也与旧命令假设不同。只检查顶层链接不能证明 pnpm store 已收敛。
- 解决 / 绕过：在独立 Profile 新增最小 `pnpm-workspace.yaml` override，并把它与 package/lock 一起纳入 Docker COPY 和发布身份；SBOM 命令移除 `--`。最终以 lockfile、镜像 `.pnpm` 存储和 Trivy 复扫共同确认旧版本消失，不能只信安装命令退出 0。
- 相关文件：[pnpm-workspace.yaml](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/pnpm-workspace.yaml)、[Dockerfile.unified-harness-candidate](apps/agent-worker/Dockerfile.unified-harness-candidate)、[UNIFIED-HARNESS-RUNBOOK.md](apps/agent-worker/UNIFIED-HARNESS-RUNBOOK.md)。

### Legacy 与 DSH 不能误用同一个 DeepSeek model 环境变量（2026-09-01）
- 现象：U4 镜像、DSH 断网探针和 Compose 均通过后，首次 production Worker 切换进入重启循环；启动门报 `BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_MODEL_mismatch`。Edge 的 DSH runtime 选择当时仍关闭，三类队列均为 0，没有 Run 或 provider 调用受影响。
- 根因：production legacy/visual 路径固定使用 `DEEPSEEK_MODEL=deepseek-chat`，DSH Profile 则钉定 `deepseek-v4-flash`；部署入口错误地把同一个全局 `DeepSeekConfig.model` 同时交给两条 runtime。把生产全局 model 改成 v4 会暗中改变普通用户与视觉提炼行为，不能作为修复。
- 解决 / 绕过：立即把 controlled DSH flag 恢复 false 并重建容器，四循环恢复；随后新增独立 `BOWERBIRD_DSH_MODEL=deepseek-v4-flash`，只为 DSH 父进程计量代理覆盖 model，key/base 继续由父进程共享，legacy `DEEPSEEK_MODEL` 不变。Worker 283/283、TypeScript、VPS 断网只读双 processor 探针和第二次空队列切换均通过；Edge test-only flag 最后才开启。
- 相关文件：[main.ts](apps/agent-worker/src/cloud-agent/main.ts)、[main.test.ts](apps/agent-worker/src/cloud-agent/main.test.ts)、[.env.example](apps/cloud/.env.example)、[DEPLOY.md](apps/cloud/DEPLOY.md)。

### Provider 结果只记内存索引会在真实进程死亡后失去恢复入口（2026-08-31）
- 现象：Ark 已返回并把图片写入 Run 工作区，但在 durable complete 前模拟进程死亡；新进程能看到磁盘文件，却因 `RunWorkspace` 的 provider result 索引只存在旧进程内存而无法恢复，最终安全停车为 outcome unknown。
- 根因：确定性文件已耐久化，恢复查询却只检查构造期为空的内存 `Map`；单实例重放测试无法暴露这个“磁盘有结果、重建无索引”的窗口。
- 解决 / 绕过：`providerResult(callId)` 先校验 64 位十六进制 call id，再仅探测当前 Run 的 `outputs/<call-id>.png/.jpg/.webp` 闭集路径，读取后重新验证图片 MIME、SHA-256 与扩展名并恢复内存索引。故障注入用全新 workspace/executor 证明 Seedream 上游仍只调用一次，Artifact/usage 各一次；processor 级测试同时覆盖 artifact 后、checkpoint 前死亡并验证相同 call id 重放。
- 相关文件：[run-workspace.ts](apps/agent-worker/src/cloud-agent/run-workspace.ts)、[controlled-image-executor.ts](apps/agent-worker/src/providers/ark/controlled-image-executor.ts)、[unified-planning-run-processor.test.ts](apps/agent-worker/src/cloud-agent/unified-planning-run-processor.test.ts)。

### 批准 hash 不能替代批准计划正文的可恢复来源（2026-08-31）
- 现象：统一 Agent 规划已能停车并在 fresh claim 收到 `approvedPlanHash` 与 `plannedToolCount`，但 Worker 没有被批准的具体步骤正文，无法安全构造批准后的 `generate_image` 调用。
- 根因：hash 只能校验已知正文，不能反推出正文；若让 DSH 在批准后重新生成或重述计划，即使语义相似也不是用户批准的不可变 proposal，会破坏步骤、输入、成本和 call identity 绑定。
- 解决 / 绕过：Edge fresh claim 只选择当前 Run、`approved` 状态、精确 proposal hash 且内容未删除的审批对象，返回短期签名 URL/hash/步骤数。Worker 以 64 KiB 上限下载，验证对象 SHA-256、闭集 plan schema、canonical hash 与步骤数；缺失、非 HTTPS URL、hash/计数/正文漂移全部 fail closed。本地 E2E 真实读取签名对象并逐项验证，不调用 provider。
- 相关文件：[agent-worker/index.ts](apps/cloud/supabase/functions/agent-worker/index.ts)、[approved-unified-plan.ts](apps/agent-worker/src/harness/approved-unified-plan.ts)、[test-unified-agent-approval-local.mjs](apps/cloud/scripts/test-unified-agent-approval-local.mjs)。

### 模型输出 SSE 上限不能与 diagnostic artifact 上限共用（2026-08-31）
- 现象：正式纵切前两个 DeepSeek 文本回合和一次方舟 Vision 均成功，第三回合在接收视觉事实后返回旧 `deepseek_response_invalid`；其 `modelUsage=3`、`modelDiagnostics=2`、`durableSucceededCalls=3` 与阶段完全对应。
- 根因：旧实现用同一个约 60/64 KiB 量级限制约束“内存中的完整 SSE”与“持久化 JSON artifact”。SSE 的逐 token 事件包装会显著放大 wire 字节数，而直接把正文嵌入 JSON 还会增加转义开销；同时旧安全码把空正文和超限合并，真实摘要不能严格区分两者。
- 解决 / 绕过：将完整 SSE 校验上限独立设为 512 KiB，空正文与超限分别返回 `deepseek_response_empty` / `deepseek_response_too_large`；持久化 schema v2 使用 gzip+base64，并保存原始字节数与 SHA-256，artifact 继续限制在 64 KiB。恢复时以 512 KiB 有界解压，验证长度/hash/UTF-8/`[DONE]`/usage/provider request id。新增超过 64 KiB 的精确回放测试，确认只调用一次上游；真实第三回合是否恢复仍以用户下一次手动纵切为准。
- 相关文件：[metered-deepseek-proxy.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.ts)、[metered-deepseek-proxy.test.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.test.ts)、[formal-vision-smoke.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/formal-vision-smoke.mjs)。

### outcome-unknown 重放不能覆盖首次 safe code，测试账本也必须幂等（2026-08-30）
- 现象：正式 smoke 显示 `provider_outcome_unknown`、`modelUsage=8`，表面上既不知道第三个 DeepSeek 文本回合的具体失败类型，又像发生了八次模型计费；但同时只有两个模型 diagnostic artifact、一次方舟 Vision 和三个 durable succeeded call。
- 根因：第三个文本回合第一次失败后，DSH 会重试相同请求；`DurableToolDispatcher` 对既有 `outcome_unknown` reconcile 不到 artifact 时，用通用 `provider_outcome_unknown` 覆盖了首次保存的具体 safe code。smoke fake control 又按 `recordUsage` 调用次数累加，没有模拟生产 ledger 按 call id 幂等，重复 reconcile 的最小 usage 因而被重复计数。成功断言还漏算了“收到方舟视觉事实后提交计划”的第三个文本回合。
- 解决 / 绕过：`PreparedToolCall` 暴露控制面本已返回的 `safeErrorCode`；failed/outcome-unknown replay 保留首次码，HTTP 200 后正文读取失败归一为 `deepseek_transport_unknown`；formal fake usage 按 `kind + callId` 幂等，成功合同修正为 3 个 DeepSeek 文本 usage + 1 个方舟 Vision usage + 4 个 durable succeeded call。新增首次码保留、响应读取失败不泄漏和重放不重复上游回归。
- 相关文件：[durable-tool-dispatcher.ts](apps/agent-worker/src/kernel/durable-tool-dispatcher.ts)、[metered-deepseek-proxy.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.ts)、[formal-vision-smoke.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/formal-vision-smoke.mjs)。

### SSE `[DONE]` 是终止事件，不保证其后还有空行（2026-08-30）
- 现象：DeepSeek/DSH 单回合、两轮真实工具 loop 和取消均成功，但经父进程计量代理的完整 smoke 连续两次在首个模型回合返回 502。
- 根因：DSH 已正确发送 `stream_options.include_usage=true`；代理却只接受正文精确以 `data: [DONE]\n\n` 或 CRLF 双换行结束。真实 SSE 可以合法地以 `[DONE]` 行直接结束，旧解析器因此把成功 200 流标成 `deepseek_stream_incomplete`。
- 解决 / 绕过：按行精确查找唯一终止标记，要求其后不得有非空数据，但允许零个或多个空行；usage 仍必须存在且响应大小继续受限。新增无尾空行回归，Worker 229/229、Profile 13/13、无网络候选复跑通过。用户随后手动运行修复后的完整 smoke 仍在首个文本回合 502，因此这是已修复的真实兼容缺陷，但不是已证明的唯一 502 根因；后续以 durable `safeErrorCode` 继续定位。
- 相关文件：[metered-deepseek-proxy.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.ts)、[metered-deepseek-proxy.test.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.test.ts)、[profile.test.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/test/profile.test.mjs)。

### Provider 代理不能把所有上游 HTTP 错误折叠为 502（2026-08-30）
- 现象：用户授权的首次正式 DSH 计量 smoke 在首个模型回合只显示代理 HTTP 502；配置结构正常，但无法判断 DeepSeek 实际返回的是参数/鉴权类 4xx、限流 429，还是临时 5xx。状态保真修复后的第二次授权重跑仍为 502，说明还可能是实际上游 502，或代理在 200 后判定流/usage/大小不合格。
- 根因：`MeteredDeepSeekProxy` 已在 durable safe code 中保存 `deepseek_http_<status>`，HTTP 边界却把所有 `DurableProviderError` 统一响应成 502；DSH adapter 只呈现 HTTP 状态，不读取代理安全正文，诊断信息因此丢失。
- 解决 / 绕过：对确定性的 `deepseek_http_<status>` 保留原始 4xx/5xx 状态，响应正文仍只含稳定错误码且绝不转发 provider 正文；其他未知/内部错误继续统一 502。新增 429 状态保真、正文不泄漏与 durable failed 回归。真实调用失败不自动重试，仍需用户重新授权。
- 相关文件：[metered-deepseek-proxy.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.ts)、[metered-deepseek-proxy.test.ts](apps/agent-worker/src/harness/metered-deepseek-proxy.test.ts)。

### DSH 被信号终止时 `exitCode` 仍可能为 null（2026-08-30）
- 现象：正式 ACP 回合已完成，父进程调用 `SIGKILL` 收尾后候选容器仍报 `dsh_acp_child_stuck`。
- 根因：Node 子进程被信号终止时以 `signalCode` 表示终态，`exitCode` 可以继续为 `null`；只检查 `exitCode` 会把已结束误判为卡住。
- 解决 / 绕过：退出等待与临时 home 清理统一以 `exitCode !== null || signalCode !== null` 判断终态；候选容器复跑已通过。真实 provider 的前次尝试可能已计费，不能因收尾修复而自动重跑。
- 相关文件：[node-dsh-acp-port.ts](apps/agent-worker/src/harness/node-dsh-acp-port.ts)、[node-dsh-acp-port.test.ts](apps/agent-worker/src/harness/node-dsh-acp-port.test.ts)。

### ACP SDK 必须从不可变 DSH Profile 解析（2026-08-30）
- 现象：本地正式计量 smoke 在任何 DeepSeek/方舟请求前报 `ERR_MODULE_NOT_FOUND`，而候选镜像因 `/app/node_modules` 软链接存在未暴露问题。
- 根因：正式 port 从 agent-worker 自身包解析 `@agentclientprotocol/sdk`，但该 SDK 实际属于钉定 Profile 的依赖闭包；开发树与候选镜像的模块布局不同。
- 解决 / 绕过：`NodeDshAcpPort` 从 `profileTemplateDir/node_modules/@agentclientprotocol/sdk/dist/acp.js` 的不可变钉定入口直接加载，避免借用应用依赖或容器软链接；Profile 完整性检查继续在 spawn 前 fail closed。
- 相关文件：[node-dsh-acp-port.ts](apps/agent-worker/src/harness/node-dsh-acp-port.ts)、[Dockerfile.unified-harness-candidate](apps/agent-worker/Dockerfile.unified-harness-candidate)。

### DSH Profile 启动会自愈 pnpm 软链接，不能直接依赖只读根文件系统（2026-08-30）
- 现象：正式 Vision smoke 在只读开发沙箱启动 DSH 时，尚未调用 DeepSeek/方舟便因尝试 `unlink profiles/.../node_modules/@types/react` 报 `EPERM`；切换到仓库可写后，同一正式链路正常完成。
- 根因：DSH 启动的 Profile module fallback 会检查并重建 pnpm 软链接，即使依赖已经安装，启动阶段也可能写 `profiles/node_modules`；生产 Worker 当前采用只读根文件系统，直接把该 Profile 放进镜像只读层会在启动前失败。
- 解决 / 绕过：实测否决“构建期预组装”：第二次启动会把部分 fallback 目标算成 fallback 自身；只给链接树 tmpfs 也不够，因为 rc.2 还会无条件重写 `cordis.yml`。当前候选把依赖本体留在只读镜像层，每个 DSH 进程在 32 MiB tmpfs 创建独立临时 `DSH_HOME`，复制轻量 Profile 配置并链接只读依赖，退出后只删除该临时 child。同一非 root、只读、无网络容器连续两次启动已通过；正式 ACP port 接线前主入口继续 fail closed。
- 相关文件：[formal-vision-smoke.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/formal-vision-smoke.mjs)、[runtime.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/runtime.mjs)、[UNIFIED-AGENT-HARNESS-PLAN.md](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md)。

### DSH 在 Linux live ACP 启动时会自动补入 Cordis HMR（2026-08-30）
- 现象：同一候选镜像的配置探针通过，但正式 ACP initialize 前子进程关闭；无 secret 的诊断日志显示 `@deepseek-ai/cordis-plugin-hmr` 无法加载 Node internal module。
- 根因：当前钉版 DSH 在 Profile 未提供 `hmr` service 时仍会自动加入 Cordis HMR；配置 dump 不执行 live HMR，因此旧探针漏检。Windows loader fallback 可工作，Linux Node 24 需要显式 `--expose-internals`。
- 解决 / 绕过：正式 `NodeDshAcpPort` 固定在 DSH 入口前加入 `--expose-internals`，并以单测锁定启动参数；该 Node 能力仅提供给只读镜像内钉版的受信 DSH/插件，模型仍无 shell/fs/web、动态插件和业务 secret。候选容器必须跑真实 ACP initialize/new-session/cancel/dispose，不能只做配置 dump。
- 相关文件：[node-dsh-acp-port.ts](apps/agent-worker/src/harness/node-dsh-acp-port.ts)、[dsh-readonly-probe.mjs](apps/agent-worker/scripts/dsh-readonly-probe.mjs)、[Dockerfile.unified-harness-candidate](apps/agent-worker/Dockerfile.unified-harness-candidate)。

### DSH `--patch` 路径相对 `DSH_HOME`，不相对 Profile 目录（2026-08-29）
- 现象：给 DSH 传裸文件名 `cordis.bridge.patch.yml` 时，即使文件实际存在于 Profile 目录，ACP 启动仍会立即关闭；日志显示 DSH 在 Spike 根目录寻找该文件。
- 根因：当前钉版 DSH 的 overlay 路径按子进程 `DSH_HOME` / 工作目录解析，不会自动以 `--profile` 指向的目录为基准。
- 解决 / 绕过：始终传相对 `DSH_HOME` 的完整路径 `profiles/bowerbird-u1/cordis.bridge.patch.yml`；真实启动钉版 DSH/ACP 并加载受信插件的无 provider 测试已锁定该行为，避免只靠静态配置测试漏检。
- 相关文件：[profile.test.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/test/profile.test.mjs)、[dsh-acp-port.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/dsh-acp-port.mjs)、[runtime.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/runtime.mjs)。

### DSH ACP sessionUpdate 不是客户端工具回调通道（2026-08-29）
- 现象：ACP `prompt` 能把最终 committed text 返回父进程，但在 DSH 注册工具后，工具会直接在 DSH 子进程插件内执行，父进程客户端看不到工具名与参数，无法直接交给 Bowerbird Tool Gateway。
- 根因：当前钉死的 `@deepseek-ai/dsh-acp@0.1.1-rc.2` 客户端协议实现只暴露消息/session update，不提供 host-side tool dispatch callback；U1 的 fixture tool 本来就是 DSH 进程内插件，不能据此推断 ACP 会把调用转发给父进程。
- 解决 / 绕过：Bowerbird 父进程继续唯一拥有 `UnifiedPlanningToolBridge`，由它注入 Run、lease、phase、allowlist、revision 与 stable logical slot。现已实现受信 Bowerbird DSH 插件，通过每 Run 32-byte 短期 capability 的 loopback HTTP 只转发 `toolName + arguments`；DSH 子进程不获得 Worker Token、方舟 key、Supabase/service role 等业务 secret，不把 ACP message text 解析成控制协议。真实 DSH + 假 DeepSeek 本地 E2E 已验证该路径。
- 相关文件：[dsh-acp-port.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/dsh-acp-port.mjs)、[bowerbird-planning-tools.mjs](spikes/unified-agent-harness-u1/profiles/bowerbird-u1/plugins/bowerbird-planning-tools.mjs)、[loopback-tool-bridge-server.ts](apps/agent-worker/src/harness/loopback-tool-bridge-server.ts)、[unified-planning-harness-runner.ts](apps/agent-worker/src/harness/unified-planning-harness-runner.ts)。

### 计划审批重放必须先按调用身份收敛，再要求当前租约（2026-08-29）
- 现象：`unified_agent_plan` 首次提交已成功落审批并把 Run 停在 `awaiting_approval`，租约按设计释放；若 Worker 没收到 HTTP 响应而用同一 `callId + argsHash` 重放，Edge 却先执行 `assertLease`，返回 409“租约已失效”，无法确认首次请求是否成功。
- 根因：审批动作沿用了“所有 Worker 写操作都先验租约”的顺序，但停车是特殊的幂等边界：成功提交本身会清空租约。调用身份、规范化 plan hash 和 pending 审批已经足以识别完全相同的响应丢失重放；继续要求旧租约反而破坏 at-least-once transport。
- 解决 / 绕过：统一计划先校验闭集 plan 与 proposal/args hash，再按 `(run_id, source_call_id)` 查询审批。相同参数且审批仍 pending、Run 已停车并无租约时直接返回已存服务端估算与 approval id；同 call 参数漂移、已批准/拒绝调用分别稳定 409。只有首次调用或“审批已写但停车尚未提交”的崩溃窗口继续要求有效租约。本地 Edge E2E 覆盖停车、响应丢失重放、漂移、批准和 fresh claim。
- 相关文件：[agent-worker/index.ts](apps/cloud/supabase/functions/agent-worker/index.ts)、[test-unified-agent-approval-local.mjs](apps/cloud/scripts/test-unified-agent-approval-local.mjs)。

### PostgreSQL CHECK 必须显式封住 NULL，图片元数据不能只验文件签名（2026-08-29）
- 现象：artifact 宽高约束初稿写成“二者都空，或二者都在合法范围”，但只填 `width`、让 `height=NULL` 时未被拒绝；同时仅靠 PNG/JPEG/WebP 文件签名无法为 `list_run_assets` 提供可信尺寸。
- 根因：PostgreSQL `CHECK` 只拒绝 `FALSE`，表达式结果为 `NULL/unknown` 也会通过；图片格式签名只能证明容器前缀，不能证明尺寸头存在、完整且落在安全边界内。
- 解决 / 绕过：`0049` 的非空分支显式要求 `width is not null and height is not null`，再限制 `1..16384` 与图片 MIME；共享解析器按 PNG IHDR、JPEG SOF、WebP VP8X/VP8L/VP8 读取并校验尺寸，Edge 在原有上传字节校验中一次完成 MIME+尺寸提取。SQL 回归专门尝试写入半空尺寸对，真实 Edge E2E 验证登记与 fresh claim 均回传服务端提取尺寸。
- 相关文件：[0049_agent_artifact_image_dimensions.sql](apps/cloud/supabase/migrations/0049_agent_artifact_image_dimensions.sql)、[image-metadata.ts](apps/cloud/supabase/functions/_shared/image-metadata.ts)、[agent_runtime.sql](apps/cloud/supabase/tests/agent_runtime.sql)、[test-unified-agent-approval-local.mjs](apps/cloud/scripts/test-unified-agent-approval-local.mjs)。

### Fresh local Supabase 未必继承 hosted service_role 表级 CRUD（2026-08-29）
- 现象：Supabase CLI 2.113.0 的全新本地库能执行全部迁移和 security-definer RPC，但本地 Edge 在直接读取 `billing_accounts` 时返回 PostgreSQL 42501；检查发现 24 张 public 表的 `service_role` 都缺 SELECT/INSERT/UPDATE/DELETE，导致 Auth 能建号、`claim` RPC 能返回，`agent-run create` 却失败。
- 根因：RLS bypass 只绕过行策略，不绕过 SQL 表权限；本地迁移对象没有继承 hosted 项目已具备的 service_role CRUD 默认权限。既有 SQL 事务测试以 postgres 执行，无法暴露 Edge 运行角色缺 grant。
- 解决 / 绕过：migration `0048` 对当前 public 表显式授予受信 `service_role` CRUD、对序列授予 usage/select，不改变 anon/authenticated grants 与 RLS。`agent_runtime.sql` 新增 Edge 持久化所需权限断言；当前全新 reset 无需手工 grant 即通过 34/34 与真实本地 Edge E2E。以后本地控制面验收必须从 fresh reset 开始，不能在手工修过 ACL 的长寿命容器上得出结论。
- 相关文件：[0048_explicit_service_role_table_privileges.sql](apps/cloud/supabase/migrations/0048_explicit_service_role_table_privileges.sql)、[agent_runtime.sql](apps/cloud/supabase/tests/agent_runtime.sql)、[test-unified-agent-approval-local.mjs](apps/cloud/scripts/test-unified-agent-approval-local.mjs)。

### Skill/runtime 下拉选择与 Agent 开关不能用可分叉状态表达（2026-08-28；2026-09-02 复发补充）
- 现象：测试账号在创作板下拉选择“HTML 排版截图”后发送，结果仍是一张普通生成图；云端 H6 观察窗没有新增任何 HTML Run，并非切片已生成但桌面漏展示。
- 根因：`cloudAgentSkill` 与 `cloudAgentMode` 是两份独立 React state。下拉框只更新 Skill，发送函数却只在 `cloudAgentMode=true` 时创建 Agent Run；因此 UI 可显示 HTML Skill、独立 Agent 按钮仍处于关闭，随后静默落回普通生图链路。
- 解决 / 绕过：正式 Agent 改用 `null | skillId` 单状态建模，派生开关与当前 Skill；选择 HTML 必然激活 HTML Agent，关闭或切换 A/B/Z/G/DS 会清空正式 Skill，发送条件不再可能和显示值分叉。Agent 已激活但登录/余额条件失效时仍允许关闭。新增状态转换回归 4/4，并通过桌面 TypeScript 与 production build；首次误走普通生图的操作不计入 H6 样本，待新版桌面真机复测。
- 2026-09-02 复发：U6 又把独立 `cloudAgentRuntime` 下拉显示在正式 Agent 开关关闭态；选择 `DSH · 自动选工具` 只改 runtime，没有把 `cloudAgentSelection` 从 `null` 原子置为已开启。账号最近三次操作因此实际创建普通 `generation_jobs/image_hd`；最新 Job `500b38d9-f36d-46df-8184-583eab17af44` 为 1 credit 单 PNG，期间没有新建 Agent Run。实际请求把详情页长文直接交给图片模型，成品是带幻写小字的栅格伪网页，不能作为 DSH 质量样本。
- 2026-09-02 修复：runtime 状态转换集中到 `activateCloudAgentRuntimeSelection`；测试账号从关闭态选择 DSH 时必须同时激活正式 Agent，随后服务端 skill 固定解析为 `bowerbird-unified-agent`。发送分支另从 runtime 派生 Agent 开启态，保证任何 DSH 状态都不能落回普通直发生图；切回 Legacy 不会反向偷偷开启 Agent，选择 DSH 同时关闭 A/B/Z/G/DS 互斥模式。状态回归更新为 11/11，桌面 TypeScript 与 production build 通过。
- 2026-09-02 部署补漏：桌面重建后仍提示“账号没有 Agent 权限”，不是测试标记或档位错误，而是 `agent-run`/Worker 已支持 unified，负责签发权限快照的远端 `entitlement v34` 却未随共享 `feature-policy.ts` 更新，形成跨 Function 部署漂移。先下载保存 v34 源码和 digest，再只部署 `entitlement v35`；重启后同一 Pro 测试账号的新签名快照保留 `can_use_agent_runs=true`，并从两个旧 Skill 增为 controlled/HTML/unified 三项。以后新增 Skill 白名单必须把 entitlement 的真实签名响应与桌面缓存刷新列入发布门禁，不能只验 agent-run create。
- 相关文件：[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)、[cloudAgentSelection.ts](apps/desktop/src/lib/cloudAgentSelection.ts)、[cloud-agent-selection.test.mjs](apps/desktop/scripts/cloud-agent-selection.test.mjs)、[HTML-RENDER-PLAN.md](dev-doc/HTML-RENDER-PLAN.md)。

### Agent 批准面板必须按计划 schema 分流，不能把 unified 强转成受控生图计划（2026-09-02）
- 现象：权限修复后第一条真实桌面 DSH Run `6fe0174e-974a-4405-b775-6dc5113f2a28` 已正确创建为 `bowerbird-unified-agent/dsh` 并停在 `awaiting_approval`，前端打开待批准计划时却报错。
- 根因：云端返回已校验的 unified schema v2：顶层为 `title/summary/contentPlan/steps`，步骤为 `kind/inputAssetIds/dependsOn`；桌面 `PendingPlan` 仍把所有 proposal 强转为旧 controlled schema v1，直接读取不存在的 `referenceRoles.length` 与 `step.preserves.length`，类型断言掩盖了运行期协议分叉。
- 解决 / 绕过：新增纯函数 `cloudAgentPlanDisplay`，把 controlled 与 unified 两种可信 schema 规范成 render-safe view；unified 明确展示素材职责、内容结构、缺失素材决策、工具名与依赖，旧受控计划展示不变。所有数组先做运行期收窄，畸形/未知 proposal 返回空态而不让 React 崩溃。实际 v2 形状、legacy 兼容与畸形输入测试 3/3，Agent 选择测试 11/11，production/Tauri debug build 通过；原 Run 未自动批准或重复规划。
- 相关文件：[CloudAgentPanel.tsx](apps/desktop/src/components/CloudAgentPanel.tsx)、[cloudAgentPlan.ts](apps/desktop/src/lib/cloudAgentPlan.ts)、[types.ts](apps/desktop/src/lib/types.ts)、[cloud-agent-plan.test.mjs](apps/desktop/scripts/cloud-agent-plan.test.mjs)。

### Agent 结果呈现必须按实际产物能力分流，不能绑定规划 Skill ID（2026-09-02）
- 现象：unified Run `fc01d798-598f-41e2-8e77-50c27cb256e1` 已完成 `compose_html → render_html → inspect_artifact`，状态为 `awaiting_result_feedback`，时间线显示“结果已准备好”，但页面没有任何结果图，只显示面向普通生图的修订文本框。
- 根因：前端已能从 `renderManifest.outputs` 选出截图并在后台下载预览，但结果网格、过期提示和底部“接受/放弃”交互仍用 `htmlRun`（`skill_id === bowerbird-html-layout-render`）作为条件。unified Agent 自主选择 HTML 工具后 Skill ID 仍是 `bowerbird-unified-agent`，因此 1 张整页图和 5 张切片被 JSX 整块隐藏；这是能力路由完成后仍按旧产品入口渲染的遗留耦合。
- 解决 / 绕过：新增 `selectCloudAgentResultArtifacts/isRenderedDocumentResult`，优先按权威 manifest 顺序选择结果，manifest 暂缺时按 `full_page/viewport/slice` 截图角色兜底；结果网格和反馈动作均以实际产物形态分流。真实六张 PNG 已下载到本地 Run 目录并通过字节/hash/图片解码校验，无需重跑。unified manifest、无 manifest 截图兜底和旧受控结果过滤测试 3/3，plan 测试 3/3，production/Tauri debug build 通过。
- 相关文件：[CloudAgentPanel.tsx](apps/desktop/src/components/CloudAgentPanel.tsx)、[cloudAgentResult.ts](apps/desktop/src/lib/cloudAgentResult.ts)、[cloud-agent-result.test.mjs](apps/desktop/scripts/cloud-agent-result.test.mjs)。

### 不要在 npm 自身工作区里用 `npm install` 原位补 bundled 依赖（2026-08-28）
- 现象：html-renderer 旧镜像可运行，但 H6 仅改健康指标后重新构建，在 `cd /usr/local/lib/node_modules/npm && npm install tar@7.5.22` 阶段请求 `@npmcli/docs@^1.0.0` 并 404，导致同一 Dockerfile 突然不可复现；旧生产容器未被替换，服务未中断。
- 根因：该命令位于 npm 自己的包/workspace 根目录。npm 上游版本与工作区元数据变化后，`npm install` 会解析 npm 的开发/workspace 依赖，而不只是替换 bundled `tar`；`@npmcli/docs` 不是公开 registry 包。
- 解决 / 绕过：在独立临时目录执行钉版 `npm pack tar@7.5.22`，用系统 tarball 解包原位替换 `/usr/local/lib/node_modules/npm/node_modules/tar`，断言 package version 后删除临时目录；不触碰 npm 其余依赖树。生产重建已通过。以后补基础镜像 bundled 包必须避免进入上游包工作区执行依赖解析，并保留旧镜像 tag 后再构建。
- 相关文件：[Dockerfile](apps/html-renderer/Dockerfile)、[README.md](apps/html-renderer/README.md)。

### HTML Run 不能只验证 renderer：Skill 版本、即时 artifact 与终态主角色都要跨层对齐（2026-08-28）
- 现象：VPS renderer 健康且 100 次直调全过后，生产 HTML Run 仍依次暴露 `agent_skill_version_unavailable`、`render_resource_invalid`、停车 409 和 finish 409；另一次模型输出因常见 viewport meta 属性被 renderer 白名单拒绝；加入显式参考图后 compose 又因资源 artifact UUID 不匹配失败。
- 根因：① agent-run 的三元映射把 HTML 版本落成 smart-refinement 的 `0.1.0-m0`；② compose artifact 在当前租约刚上传时尚未出现在 claim 的签名 URL 清单，Workspace 立即按远端读取；③ `await_result_feedback` Edge 与数据库 `settle_agent_run` 都硬编码只认图片 Skill 的 `final_result`；④ 模型提示没有列出 renderer 的精确标签/属性/CSS 闭集；⑤ validator 要求模型原样回显输入 artifact UUID，但 compose 上下文只给了引用序号、hash 和尺寸，没有给 UUID，属于不可满足契约。
- 解决 / 绕过：显式映射 HTML `0.1.0`；当前租约把已校验 HTML 缓存进 RunWorkspace，重领仍走签名 URL；Edge 停车和 `0046` 原子结算按 `skill_id` 要求 HTML 的 viewport/full-page 主截图恰有一个；把 renderer 闭集前置进 compose 系统策略并在纠正回合仅回传稳定 validator reason；把精确 `artifactId` 写入模型 input manifest 上下文并用测试锁定。以后 H0/H5 验收必须包含至少一张显式参考图的真实 `agent-run create→finish`，不能用纯文本 Run 或 renderer `/render` 直调替代。
- 相关文件：[agent-run/index.ts](apps/cloud/supabase/functions/agent-run/index.ts)、[run-workspace.ts](apps/agent-worker/src/cloud-agent/run-workspace.ts)、[model-turn.ts](apps/agent-worker/src/skills/bowerbird-html-layout-render/model-turn.ts)、[agent-worker/index.ts](apps/cloud/supabase/functions/agent-worker/index.ts)、[0046_html_layout_run_settlement.sql](apps/cloud/supabase/migrations/0046_html_layout_run_settlement.sql)、[test-html-layout-agent-e2e.mjs](apps/cloud/scripts/test-html-layout-agent-e2e.mjs)。

### Chromium sandbox 不能靠“没写 --no-sandbox”推断，Playwright 默认值与 seccomp 都要实证（2026-08-28）
- 现象：初版镜像没有传 `--no-sandbox` 但 Playwright 实际默认 `chromiumSandbox:false`；改成显式 true 后，在 `cap_drop: ALL` + 默认 Docker seccomp 下报 sandbox setup 失败。Ubuntu 24.04 同时启用 `apparmor_restrict_unprivileged_userns=1`，单独放开 AppArmor 或 seccomp 都不足以说明最终边界。
- 根因：Playwright launch 的 sandbox 是独立布尔项；官方 seccomp profile 允许 user namespace 相关 syscall，但其中 `chroot` 规则带 capability 条件，`cap_drop: ALL` 时规则被排除，而 Chromium 在新 user namespace 内仍需要该 syscall完成 sandbox 设置。
- 解决 / 绕过：代码钉死 `chromiumSandbox:true`；生产沿用非 root、read-only、no-new-privileges、cap_drop ALL、internal network，只采用 Playwright 官方 seccomp 基线并将 `chroot` 加到无条件 allow 名单（内核仍做 namespace/capability 权限检查），不授予广泛 capability、不用 seccomp unconfined。实机进程确认无 `--no-sandbox`，100 次合成渲染与正式 Run 均通过。
- 相关文件：[renderer.ts](apps/html-renderer/src/renderer.ts)、[compose.renderer.yml](apps/html-renderer/compose.renderer.yml)、[seccomp_profile.json](apps/html-renderer/seccomp_profile.json)、[renderer.e2e.test.ts](apps/html-renderer/src/renderer.e2e.test.ts)。

### agent_runtime.sql 的 DO 块内裸列名与块变量同名同样触发 42702（2026-08-28）
- 现象：远端重跑 `agent_runtime.sql` 在「unleased cancellation expires the pending approval」用例报 SQLSTATE 42702——测试文件 DO 块 declare 了 `run_id` 变量，语句 `where agent_approvals.run_id = run_id` 右侧裸 `run_id` 与输出列歧义。与 `0043` 修复的生产函数同款问题，但藏在测试文件里，此前从未被整跑。
- 根因：PL/pgSQL 凡变量名与查询可见列名同名，裸引用一律歧义报错（默认 variable_conflict=error）。
- 解决 / 绕过：该块头加 `#variable_conflict use_variable`（块内表达式位置的裸 run_id 全部是变量语义；列引用均已表限定或处于列名清单，不受影响）。新增 html-render 用例块采用不同名变量（test_run_id/html_run_id）+ 表限定列，从源头避免。
- 相关文件：[agent_runtime.sql](apps/cloud/supabase/tests/agent_runtime.sql)。

### Playwright 官方 CDN 本机不可达、npmmirror 缺 win64 build，本地 e2e 用已装 Chromium 回退（2026-08-27）
- 现象：`npx playwright install chromium` 长时间零字节挂起；`playwright.azureedge.net` 307 跳转 `playwright.download.prss.microsoft.com` 后只返回 24 字节错误体；npmmirror 的 playwright 镜像 `builds/chromium/1234/` 只同步了 linux-arm64 文件，无 win64。
- 根因：最终下载主机 prss.microsoft.com 在当前网络被阻断；镜像源同步不完整。
- 解决 / 绕过：html-renderer 本地 e2e 支持 `BOWERBIRD_E2E_EXECUTABLE` 指向已装 `%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe` 回退实跑（协议兼容性尽力而为，仅作本地开发信号；8 项 e2e 全过）。生产容器在 VPS 内构建下载钉版 revision，不受本机网络影响；若 VPS 出口也被阻断，用 `PLAYWRIGHT_DOWNLOAD_HOST` 指向镜像的 linux 包（linux x64 镜像齐全）。
- 相关文件：[renderer.e2e.test.ts](apps/html-renderer/src/renderer.e2e.test.ts)、[Dockerfile](apps/html-renderer/Dockerfile)。

### 多参考图只传 ULID 路径，prompt 的 @素材名与附件顺序会失去映射（2026-08-27）
- 现象：创作板同时引用多张素材时，prompt 明明用 `@素材名` 指定主体/参考职责，Codex、即梦、Cloud 或 Agent Z/G 仍可能把不同图片的角色对错。
- 根因：库内附件实际按 `store_path` 传递，文件名是 ULID；provider 只看到图片顺序和 prompt 中的人类素材名，两者没有机器可读的对应关系，只能猜测。
- 解决 / 绕过：Rust 按最终下发顺序以 `store_path → assets.name` 反查，至少两张参考图时在生成 instruction 注入「第 N 张 = 素材名」清单（临时库外文件明确为未命名）；Agent Z/G 同样把同序名称随路径传入 TUI。单图不注入，续轮、重试和跨 provider 均以最终实发 `refs_for_meta` 为准。
- 相关文件：[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)、[library.rs](apps/desktop/src-tauri/src/core/library.rs)、[agent_z.rs](apps/desktop/src-tauri/src/commands/agent_z.rs)、[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)。

### PL/pgSQL RETURNS TABLE(status) 输出列与 WHERE 裸列名歧义，TTL 结算潜伏一周才显形（2026-08-26）
- 现象：VPS Worker `agent_maintenance_failed: agent_control_http_500` 从 2026-08-26 13:34（北京）起每 10 分钟必现；手动调用 `cleanup_expired` 返回 500「过期停车 Run 结算失败」，TTL 清理停滞（积压 14 Run/18→52 对象）。此前该功能一直正常。
- 根因：`0040` 重写 `cancel_unleased_agent_run` 时声明 `RETURNS TABLE(status text, ...)`——PL/pgSQL 会把输出列变成函数体内变量；其新增的 `update agent_approvals ... and status = 'pending'` 中裸 `status` 在解析期即 SQLSTATE 42702（变量 vs 列歧义）。该语句此前从未被执行过：直到两个停车 Run（2026-08-25 13:34/13:36 创建）内容过期、cleanup 首次真正调用该 RPC，bug 才显形；事务原子回滚使 Run/hold 保持原状（无资损），但也永远无法自愈。A8 部署时只跑了 Deno 单测与观察报告，未重跑 `supabase/tests/agent_runtime.sql`（其中既有用例本可暴露此错）。
- 解决 / 绕过：migration `0043` 重建该函数，WHERE 内列引用表限定（`agent_approvals.status`），行为与 0040 仅差这一行；`agent_runtime.sql` 的取消用例补插一条 pending 审批并断言取消后置 `expired` + `decided_at`。规则：**PL/pgSQL 凡 `RETURNS TABLE` 的输出列名，函数体内所有 WHERE/表达式里的同名列必须表限定**；改过 SQL 函数后必须重跑 `agent_runtime.sql`（本地无 Docker 时至少对远端做一次针对性 RPC 实调验证）。部署后两个卡住 Run 已正确结算（一个确认 2 积分、一个全额回滚）、TTL 积压清零、健康探测零告警。
- 相关文件：[0043_fix_agent_cancel_unleased_status_ambiguity.sql](apps/cloud/supabase/migrations/0043_fix_agent_cancel_unleased_status_ambiguity.sql)、[0040_agent_a8_observation.sql](apps/cloud/supabase/migrations/0040_agent_a8_observation.sql)、[agent_runtime.sql](apps/cloud/supabase/tests/agent_runtime.sql)。

### DeepSeek V4 默认 thinking 会拒绝 Kernel 的强制 tool choice（2026-08-25）
- 现象：本地 A3-T7 的全部文本案例都在约 1 秒内返回 `deepseek_http_error`；`/models` 正常且 key 有效，最小 tool-call 请求却返回 HTTP 400。
- 根因：账号模型已切到 `deepseek-v4-flash`。V4 默认开启 thinking，而 Chat Completions thinking mode 不接受本项目使用的 `tool_choice=required`；dev chat 若保留 thinking，还必须在工具续轮回传 `reasoning_content`，现有可恢复协议并未把 provider 隐藏推理作为权威状态。
- 解决 / 绕过：DeepSeek adapter 的 Kernel `turn()` 与 dev `chat()` 均显式发送 `thinking: { type: "disabled" }`；Bowerbird Kernel/Skill 继续负责阶段与规划约束，避免重复思考耗时。增加 request body 回归、真实最小 tool probe 和 18 案例评测，部署后比对远端 SHA-256。
- 相关文件：[backend.ts](apps/agent-worker/src/providers/deepseek/backend.ts)、[backend.test.ts](apps/agent-worker/src/providers/deepseek/backend.test.ts)、[run-controlled-image-edit-eval.ts](apps/agent-worker/src/eval/run-controlled-image-edit-eval.ts)、[AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md)。

### 内容寻址 checkpoint 重放必须在签名阶段允许 upsert（2026-08-25）
- 现象：Codex Agent 在用户批准计划后停在 40% 并报 `agent_control_http_500`；本机任务行已是 `pending`，CLI 尚未调用，Run 却在进入 `awaiting_local_task` 前失败。
- 根因：Worker 会先保存执行阶段 checkpoint，登记本机任务后为了保证“先 checkpoint、再停车”又保存一次；状态未变化时两次内容哈希和对象 key 完全相同。客户端 PUT 虽带 `x-upsert: true`，但 `checkpoint_prepare` 使用的 `createSignedUploadUrl` 没有以 `{ upsert: true }` 签发权限，第二次签发同一对象直接返回 500。
- 解决 / 绕过：checkpoint 上传 URL 在签名阶段显式允许 upsert；控制面回归脚本加入同一 hash/key 的连续 prepare/PUT/commit。生产组合冒烟必须覆盖“同哈希双提交 → 同 seq 事件重放 → local task request → `awaiting_local_task`”，不能只测首次 checkpoint 或空任务停车。
- 相关文件：[agent-worker/index.ts](apps/cloud/supabase/functions/agent-worker/index.ts)、[test-agent-control-plane.mjs](apps/cloud/scripts/test-agent-control-plane.mjs)、[AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md)。

### 续轮「挑了新参考图就完全替代」挤掉上一轮产出图（2026-08-19）
- 现象：即梦会话续轮提修改意见后，即梦没收到上一轮生成图就开始生成（结果与上一轮画面完全脱节）；多次修复「空回退」后仍复现。
- 根因：前端 `sendGenRevise` 曾是二选一——`挑了新参考图 ? 挑的图 : 上一轮产出图`。用户按创作板习惯组稿（修改意见里 @ 素材图选维度描述改动）即触发替换路径，上一轮产出被挤掉（task_queue `references` 与 generation_meta 双重取证：续轮只发了素材图、未含首轮产出）。叠加 `job.turns` 是易失内存（重启恢复的在跑 job 只重建一个空轮），「空时回退」也会落空——两条路径都会静默丢基图，且 prompt 文本不含参考图、UI 又只给首轮画附件缩略图，发了也看不见，问题长期难定位。
- 解决 / 绕过：参考图合并收敛到后端权威（约定 34：从 generation_meta 取「最后有图轮」产出图合并去重）；轮级重试/编辑走 `exact_references` 精确重放；`started` 事件回填本轮最终参考图并在每轮气泡上方画「附件」缩略图——实际下发从此可见，日志 `gen: 续轮合并上一轮产出图` 可核对。
- 相关文件：[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)、[library.rs](apps/desktop/src-tauri/src/core/library.rs)、[store.ts](apps/desktop/src/store.ts)、[GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx)。

### credit_hold 过滤 service_costs.active——下架档位不能靠 active=false（2026-08-17）
- 现象：动态档位改造时想把遗留 `image_sd`（旧安装包固定发送的 service）从桌面菜单隐藏，第一反应是置 `active=false`。
- 根因：`credit_hold` RPC（[0003_billing_rpc.sql](apps/cloud/supabase/migrations/0003_billing_rpc.sql)）查价时带 `and cost.active` 条件，inactive service 直接抛「unknown or inactive service」——旧安装包的全部云生图会在预授权一步 500 失败，等于打断存量用户。
- 解决 / 绕过：**隐藏 ≠ 停用**。`image_sd` 保持 active，靠「`parameters` 无 `label`」从 entitlement 的 `generation_services` 里隐式排除（0018 约定：带 label 才进菜单）；generate-proxy 的动态校验也只查 active，旧 service 永远可计费可路由。真正要停用一个 service 时，必须先确认没有存量客户端还在发它。
- 相关文件：[0003_billing_rpc.sql](apps/cloud/supabase/migrations/0003_billing_rpc.sql)、[0018_dynamic_image_services.sql](apps/cloud/supabase/migrations/0018_dynamic_image_services.sql)、[entitlement/index.ts](apps/cloud/supabase/functions/entitlement/index.ts)。

### PostgREST 把 NULL 复合返回序列化成全字段 null 对象，判空失效（2026-08-15）
- 现象：VPS Worker 上线后每次 claim 控制面都返回 500「服务暂时不可用」，但 RPC 直连 REST 验证正常、空队列 `return null` 语义正确。
- 根因：`claim_generation_job` 声明为 `returns public.generation_jobs`（单行复合类型），空队列 `return null` 时 PostgREST 不返回 JSON `null` 而是返回**全字段为 null 的对象**（truthy）。Edge 侧 `if (!job)` 挡不住，走到 `createSignedUrl(job.request_object_key=null)` 在 storage-js 内部 `null.replace` 崩溃，非 ApiError → 通用 500。
- 解决 / 绕过：判 `!job?.id`（[generation-worker/index.ts](apps/cloud/supabase/functions/generation-worker/index.ts) claim 分支）。所有 `returns <table>` 单行复合的 RPC 空结果都要按「全 null 对象」防御；本仓库 A1 的 claim/heartbeat 已有 scalar 归一，但复合 null 对象这个形态是新的。
- 相关文件：[generation-worker/index.ts](apps/cloud/supabase/functions/generation-worker/index.ts)、[0015_generation_jobs.sql](apps/cloud/supabase/migrations/0015_generation_jobs.sql)。

### node --env-file 不剥内联注释，E2E 脚本需自解析 .env（2026-08-15）
- 现象：`apps/cloud/.env` 大多数行带 ` # 注释` 尾缀，`node --env-file` 会把注释算进值，读到的 key/URL 全带尾巴。
- 根因：Node 的 env-file 解析不识别空格 `#` 行内注释格式（与 Supabase CLI 行为不同）。
- 解决 / 绕过：[test-generation-e2e.mjs](apps/cloud/scripts/test-generation-e2e.mjs) 自带 `parseEnv`（逐行 `KEY=value` + 剥 `\s+#.*$`）；后续新脚本沿用，别信 `--env-file` 读这个文件。
- 相关文件：[test-generation-e2e.mjs](apps/cloud/scripts/test-generation-e2e.mjs)、`apps/cloud/.env`。

### AssetDetail 提前 return 后挂 useMemo，点图偶发整页崩溃（2026-08-15）
- 现象：点瀑布流某图打开详情页时 UI 崩，控制台报 "Rendered more hooks than during the previous render"（Hook 顺序表末尾 `undefined → useMemo`）。
- 根因：组件里「资产不存在」的提前 `return` 写在两个 `useMemo`（`genMeta` 解析 / `generationReferences` 还原）之前；点图瞬间出现一次 `asset` 为空的渲染（守卫生效，Hook 少执行两个），资产到位后再渲染 Hook 数量变多，React 检测到顺序改变直接抛错。属既有结构问题，非本次改动引入。
- 解决 / 绕过：把这两个 useMemo 上移到守卫之前（依赖 `analyses`/`group`/`assets` 均不依赖 `asset` 非空），守卫只拦渲染；原位留注释说明 Hook 不得落在条件分支之后。
- 相关文件：`apps/desktop/src/components/AssetDetail.tsx`

### PowerShell 管道向 Node stdin 传中文会退化为问号（2026-08-15）
- 现象：series-director CLI 合成 smoke 的中文 goal 进入 Node 后变成连续 `?`，prompt 规范化又把问号当句末标点剥离，最终报 `series_director_goal_required`；误看起来像 checkpoint 丢字段。
- 根因：Windows PowerShell 当前管道输出编码不是 UTF-8；对象内中文在 `ConvertTo-Json | node` 边界已损坏，与 DeepSeek 或 JSON parser 无关。
- 解决 / 绕过：管道前显式设置 `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`；桌面 Rust→Node 桥使用 `serde_json::to_vec` + stdin 字节写入，不受此问题影响。
- 相关文件：`apps/agent-worker/src/local/series-director-cli.ts`、`apps/desktop/src-tauri/src/commands/agent.rs`

### DeepSeek 新模型名与当前账号/端点不一致（2026-08-14）
- 现象：相同的两回合 function-calling 合成请求，显式配置 `deepseek-chat` 成功并返回完整 usage；改为官方当前文档推荐的 `deepseek-v4-flash` 后返回 `400 invalid_request_error`（非重试型）。
- 根因：官方文档已进入 V4 命名，但当前 API 账号/端点尚不接受该模型名；仅依据文档静态改名会让刚接入的 Worker 立即不可用。
- 解决 / 绕过：`DEEPSEEK_MODEL` 改为必填，不在代码中静默猜测模型；POC 暂用真实验证通过的 `deepseek-chat`，后续迁移时用同一脱敏 spike 先验收新模型名，再更新 secret/约定。错误日志只保留 HTTP status 与经白名单过滤的 provider code，不记录上游 message、prompt 或响应正文。
- 相关文件：[backend.ts](apps/agent-worker/src/providers/deepseek/backend.ts)、[deepseek-tool-calling.ts](apps/agent-worker/src/spikes/deepseek-tool-calling.ts)、[deepseek-tool-calling.json](apps/agent-worker/src/fixtures/deepseek-tool-calling.json)。

### Tauri bundle resources map+glob 拍平子目录，release 扩展图标加载失败（2026-08-14）
- 现象：新用户加载浏览器扩展时 Chrome 报 `Could not load icon 'icons/16x16.png' specified in 'icons'` / `无法加载清单`；dev 本地一切正常，只有装 release 安装包的新用户中招。
- 根因：[tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json) 的 `bundle.resources` 用了 **map + glob** 写法 `"../../extension/**/*": "extension/"`。Tauri 官方文档明确：map 语法搭配 glob 时**不保留子目录结构**——所有匹配文件被拍平到目标目录，`extension/icons/16x16.png` 被复制成 `extension/16x16.png`（丢 `icons/` 前缀），manifest 引用 `icons/16x16.png` 找不到。dev 不受影响（[collect.rs](apps/desktop/src-tauri/src/commands/collect.rs) `extension_folder_path` 直接读源码 `apps/extension/`，结构正确），只有 release 安装包走 resources 复制才暴露——典型「本地没事、用户炸」。
- 解决 / 绕过：glob 改为**目录源** `"../../extension/": "extension/"`（map + 目录源保留原结构，一行修复）。验证：`cargo build` 后 `target/{debug,release}/extension/icons/16x16.png` 均存在。
- 相关文件：[tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)、[collect.rs](apps/desktop/src-tauri/src/commands/collect.rs)、约定 16。

### 官网 ProseMirror 光标偶发跳到下一行开头（2026-08-02）
- 现象：试用创作板中点击正文、再插入素材或维度时，光标偶发跳到下一视觉行开头。
- 根因：正文点击事件冒泡到 `editor-wrap` 后被重复 `view.focus()`，覆盖 ProseMirror 刚根据点击坐标计算的选区；素材/维度 `<button>` 的 `mousedown` 又会先夺走编辑器焦点，形成第二处选区竞争。
- 解决 / 绕过：正文内点击完全交给 ProseMirror 处理，外层只在真正空白区聚焦；素材网格与动态维度列表在鼠标左键 `mousedown` 时 `preventDefault()`，保留编辑器选区，同时不影响后续 `click` 插入和键盘操作。
- 相关文件：[website/app.js](website/app.js)。

### cargo 运行即 dyld 崩溃（2026-07-05）
- 现象：`cargo --version` 报 `dyld: Library not loaded: libllhttp.9.3.dylib`。
- 根因：Homebrew `libgit2@1.9.2_1` 链接到已被升级删除的 `llhttp@9.3`（系统现装 9.4）。
- 解决：`brew reinstall libgit2`（顺带把 rust 升到 1.96.0）。
- 相关文件：本机环境，非项目代码。

### rusqlite bundled 即默认启用 FTS5（2026-07-05）
- 现象：首版 Cargo.toml 加了 `libsqlite3-sys = { features = ["bundled-full"] }`，但 0.28 版本根本无此 feature，版本解析失败。
- 根因：误以为要单独启用 FTS5。实际上 `rusqlite = "0.32"` 的 `bundled` feature（libsqlite3-sys 0.30）默认就启用 FTS5/JSON1。
- 解决：去掉 libsqlite3-sys 直接依赖，只用 `rusqlite = { version = "0.32", features = ["bundled"] }`；运行时用 `SELECT COUNT(*) FROM pragma_compile_options WHERE compile_options='ENABLE_FTS5'` 校验通过。
- 相关文件：[Cargo.toml](apps/desktop/src-tauri/Cargo.toml)、[db/mod.rs](apps/desktop/src-tauri/src/db/mod.rs)。

### PRAGMA compile_options 的列名不是 `value`（2026-07-05）
- 现象：`SELECT value FROM pragma_compile_options WHERE name='ENABLE_FTS5'` 报 `no such column: value`，导致 setup panic。
- 根因：`PRAGMA compile_options` 返回单列 `compile_options`，每行是一个选项字符串，不是 name/value 对。
- 解决：改为 `SELECT COUNT(*) FROM pragma_compile_options WHERE compile_options='ENABLE_FTS5'`。
- 相关文件：[db/mod.rs](apps/desktop/src-tauri/src/db/mod.rs)。

### img_hash 版本与 image 0.25 冲突 → 自实现 dHash（2026-07-05）
- 现象：`img_hash 3.2` 的 `hash_image(&DynamicImage)` 报 `trait bound image::DynamicImage: img_hash::Image not satisfied`。
- 根因：img_hash 3.2 绑定 `image 0.23`，本项目用 `image 0.25`；两版本不互通，trait impl 落在 0.23 类型上。
- 解决：移除 img_hash 依赖，在 [media/phash.rs](apps/desktop/src-tauri/src/media/phash.rs) 自实现 64-bit dHash（差值哈希），去重场景够用；附 `hamming()` 留作后续按阈值模糊匹配。**这是对开发计划 §2.3（img_hash）的务实偏离**。
- 注意：纯色/均匀图 dHash 会退化为全 0（不同纯色同 hash）—— 测试用渐变图规避；真实照片无此问题。

### 瀑布流缩略图加载抖动（2026-07-05）
- 现象：桌面端网格在滚动/懒加载时图片持续上下跳动，直到所有缩略图加载完才稳定。
- 根因：CSS columns 瀑布流中 `<img>` 加载前高度为 0，加载完成后撑开高度 → columns 反复重新平衡列高 → 整列重排抖动。
- 解决：用 DB 已有的 `width`/`height` 给 `<img>` 设 `aspect-ratio`，占位高度即最终高度，加载后高度不变，columns 不再重排。SVG/PSD（probe 为 0×0）回退不设。
- 相关文件：[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx)。

### 删除图片无 UI 入口（2026-07-05）
- 现象：用户无法删除图片。后端 `delete_asset` 命令、前端 `api.deleteAsset` 都在，但前端无任何调用点。
- 解决：当时在 `DetailPanel.tsx` 顶部加入「删除所选」入口（该历史组件现已移除；当前删除交互由详情页与右键菜单承接），单选/多选通用并采用两段式确认，避开 Tauri 2 WKWebView 对 `window.confirm` 的拦截。
- 注意：`delete_asset` 已物理删除 `store_path`/`thumb_path`（best-effort，忽略 NotFound；去重 SVG 的 thumb==store）；`asset_prompts`/`asset_tags`/`analyses` 由外键 `ON DELETE CASCADE` 自动清理（`foreign_keys` 在连接打开时已启用）。

### 扩展采集后桌面端不实时刷新（2026-07-05）
- 现象：浏览器扩展采集成功，桌面端看不到新图，要点导入按钮触发 refresh 才出现。
- 根因：`ws_server` 入库后没有通知前端；[App.tsx](apps/desktop/src/App.tsx) 仅在 `currentFolderId` 变化时 refresh，无采集事件订阅。
- 解决：`ws_server` 在 `ingest_from_url` 成功后 `app.emit("library://assets-changed", ())`（`AppState` 加 `AppHandle` 字段，`start` 接收 `app` 参数，`lib.rs` 传 `app.handle().clone()`）；前端 listen 该事件，300ms 去抖后 refresh（合并扩展「收集全页」时连发的多条 WS 消息，避免狂刷）。
- 相关文件：[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)、[lib.rs](apps/desktop/src-tauri/src/lib.rs)、[App.tsx](apps/desktop/src/App.tsx)。

### FTS5 同步触发器 + JOIN 列名歧义（2026-07-05）
- 现象：`search_assets` 报 `ambiguous column name: name`。
- 根因：`assets JOIN library_fts` 后两表都有 `name` 列；`ASSET_COLS` 模板不带表前缀 → SQLite 无法决定取哪个。
- 解决：`search_assets` 单独写 SQL，所有列加 `a.` 前缀（其它无 JOIN 的查询仍用 `ASSET_COLS`）。另：FTS5 同步用触发器（`0002_fts.sql`），`UPDATE` 触发器用 DELETE+INSERT 而非 UPDATE（fts5 虚拟表对 UPDATE 的兼容不如 DELETE+INSERT 稳）。
- 相关文件：[core/library.rs](apps/desktop/src-tauri/src/core/library.rs)、[sql/0002_fts.sql](apps/desktop/src-tauri/sql/0002_fts.sql)。

### gpt-image-2 是生成模型，不能做"描述图片"（2026-07-05）
- 现象：spike"反推看图"时考虑 OpenAI `gpt-image-2`，但它无法产出文本描述。
- 根因：`gpt-image-2` 是图像「生成」模型（输入文本/图 → 输出新图）；它"能看图"是为了编辑/生成参考图。"图→文本描述"必须用 vision 模型（`gpt-4o` / `gpt-5.x`，Chat Completions / Responses API）。OpenAI 文档 [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) 明确区分。
- 解决：新增 `OpenAIProvider` 走 Chat Completions + `image_url` data URL（base64 本地图）。与 Bowerbird「v1 不做生成」约定一致。
- 相关文件：原 `codex/openai.rs`（已随 OpenAI HTTP 路线移除）、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)。

### 本地 codex CLI 二进制缺失（2026-07-05）
- 现象：`codex --help` 报 `spawn .../codex/codex ENOENT`。
- 根因：`@openai/codex` npm 包的平台二进制（`@openai/codex-darwin-x64/vendor/.../codex`）未正确安装。
- 解决：暂不依赖 codex CLI；走 OpenAI HTTP API（`OpenAIProvider`）。如需 codex CLI，`npm reinstall @openai/codex`（可能需匹配平台包）。

### OpenAI 调用被 reset + reqwest 不读系统代理（2026-07-05）
- 现象：app 内填好 key、勾「真实看图」点反推，约 2 秒按键恢复但无任何输出（`analyses` 表 0 条）。
- 诊断：curl 测 `api.openai.com` → TLS 握手 `Connection reset by peer`（GFW 封锁）；`baidu.com` 可达；macOS 系统代理配了 `127.0.0.1:7890`，但 `HTTPS_PROXY` 环境变量未设。
- 根因：reqwest 默认只读 `HTTPS_PROXY` 环境变量，**不读 macOS 系统代理**（scutil）—— Bowerbird 直连被 reset；同时前端 `describe` 的 catch 吞了错误，看不到。
- 解决：(1) `OpenAIProvider::detect_system_proxy()` 自动跑 `scutil --proxy` 解析系统代理；(2) Settings 加可选 `proxy` 字段手动覆盖；(3) reqwest client 配 `Proxy::all`；(4) AssetDetail 把命令错误显式显示在 caption 区（红框）。
- 附：经代理可达 OpenAI 后，还可能命中账户 `insufficient_quota`（HTTP 429）—— 这是 OpenAI 账户余额/配额问题，需在 OpenAI 后台充值或绑卡，**非代码问题**。
- 相关文件：原 `codex/openai.rs`、`core/settings.rs`（**已随 OpenAI HTTP 路线移除**，见上文「多模态看图四条路径」）、[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)。解法 (1)(2)（`detect_system_proxy` / Settings `proxy` 字段）随文件失效，本条仅留作「reqwest 默认不读 macOS 系统代理」的教训存档。

### 多模态看图四条路径实测 → codex CLI 胜出（2026-07-05）
- 目标：让「反推」（图→文本描述）真正看图，不再凭空。实测四条路径：
  - **`codex exec --image`** ✅ **采用**：走 ChatGPT 订阅（`chatgpt.com/backend-api/codex`，`provider: openai` / model `gpt-5.5`），**绕过 OpenAI API quota**（不受 insufficient_quota 影响）；国内 `chatgpt.com` 的 WebSocket 被 reset，但 codex 自动回退 HTTPS 慢但成功。
  - **`claude -p` 无头** ❌：`@path` / Read 工具把图上传 CDN 但**不传给模型**（"uploaded it to a CDN without displaying it to me"）；`--input-format stream-json` 的 image content block 也只被识别为"image attached"，Claude 仍说"unable to view"。
  - **DeepSeek HTTP** ❌：官方 API content 不接受 OpenAI 的 `image_url` variant（`unknown variant \`image_url\`, expected \`text\``）—— DeepSeek 多模态消息格式与 OpenAI 不兼容。
  - **OpenAI HTTP** ❌：账户 `insufficient_quota`（429）。
- 结论：看图走 [`CodexCliProvider`](apps/desktop/src-tauri/src/codex/codex_cli.rs)（`codex exec --skip-git-repo-check --image <path>` + stdin 指令 + 解析 `\ncodex\n<answer>\ntokens used`）。Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线随后已清理移除，全链路只走 codex CLI。
- 前置：`npm install -g @openai/codex` 修复本地 codex（0.142.5，之前平台二进制 ENOENT），`codex login` 登录 ChatGPT 订阅。
- 相关文件：[codex/codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)。

### codex exec --json 事件结构 + 会话回看（2026-07-06）
- 需求：反推保留 headless 自动入库（创作板依赖 caption），同时让用户能直观看到 codex 收到的输入与对话。
- 实测：`codex exec --json --skip-git-repo-check` 的 stdout 是 **JSONL 事件流**（逐行 JSON，非整体）：
  - `{"type":"thread.started","thread_id":"<UUID>"}` —— 会话 id（也 = `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<thread_id>.jsonl` 文件名里的 ULID）
  - `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` —— 最终答案正文（可能多条，拼接）
  - `{"type":"turn.completed","usage":{...}}` —— 收尾
  - 注意：tracing 的 ERROR 行（如 `wss reset`）走 **stderr**，不污染 stdout 的 JSONL；但 codex 的提示行 `Reading additional input from stdin...` 在 stdout，解析按「行首非 `{` 跳过」过滤。
- 回看：`codex resume <thread_id>`（位置参数，UUID 直接 parse，绕过 picker）进 TUI 看该次完整对话含图。**Codex.app 的 `codex app` 只接 `[PATH]`、无法定位特定 session**；URL scheme `codex://` 未文档化、靠不住。故会话回看只能走 CLI TUI（macOS 用 osascript 唤起 Terminal.app 跑 `codex resume`）。WS reset 后 codex 自动回退 HTTPS，`codex exec --json` 仍能在 stdout 拿到完整 JSONL，不影响解析。
- 落库：caption payload 存 `{"text":...,"session_id":...}`（不动 analyses 表结构，最小改动）；前端 `parseCaptionSessionId` 取出，渲染「在 codex 中打开」按钮 → `open_codex_session` 命令。
- 相关文件：[codex/codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)（`parse_jsonl`）、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`codex_describe_asset` payload + `open_codex_session`）、[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)（按钮）。

### 创作板多维度序列化只展开第一个维度（2026-07-08）
- 现象：创作板里 `@图片A的【光影】和【类型】，【氛围】`，实际发送的 prompt 只有 `【光影】` 取到了该图 section 正文，`【类型】`、`【氛围】` 都是裸标签无片段。
- 根因：[serializePrompt](apps/desktop/src/components/CreationBoard.tsx) 旧逻辑只让图片 token 通过 `nextSectionTitle` 吞掉**紧跟着的第一个**维度关键词并展开（`@图名 的【维度】：片段`），其余 keyword token 走 `out += 【${t.text}】` 分支只输出裸标签。这是「一张图只点一个维度」时代的逻辑，与新的「面板常驻、连续点多维度」不匹配。
- 解决：遍历时记录 `currentImageId`（最近遇到的图片 token），未被图片吞掉的独立关键词 token 改走新增的 `serializeKeyword`——到这张图 `sections` 里按标题查 body，查到就输出 `【维度】：片段`。第一个维度仍由图片 token 吞掉（保持 `@图名 的【维度】：片段` 不变），后续维度各自取片段。
- 相关文件：[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)（`serializePrompt` / `serializeKeyword`）。

### 连点反推前一张被静默 kill（2026-07-08）
- 现象：详情页对图 A 点反推（几十秒慢任务），返回瀑布流后对图 B 再点反推，A 的反推结果永远不出现（`analyses` 表无 A 的新行）；用户以为 A 在跑、其实早被杀。
- 根因：后端 `DESCRIBE_CANCEL` 是单例 `Mutex<Option<oneshot::Sender>>`（[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_describe_asset` 内）。B 的 `codex_describe_asset` 进 `tokio::select!` 前先 `.replace(cancel_tx)` 把 A 的 sender drop 掉。oneshot sender 被 drop 后 receiver 端立即 resolve 成 `Err(RecvError)`，`tokio::select!` 的 `_ = &mut cancel_rx` 分支被命中 → A 走「已取消」路径、`run_fut` 被 drop、codex 子进程靠 `kill_on_drop` 被终止，A 的 `insert_analysis` 永不执行（且前端无任何提示）。
- 解决：反推执行状态从 AssetDetail 本地 state 提到 store，前端维护单槽队列（`runDescribe` 入队 → `pumpDescribe` 串行 `await`），保证同一时刻只调一次 `codex_describe_asset`，从源头杜绝单例 sender 被 replace。配合后端 `insert_analysis` 后 emit `analyses://changed`（App / 详情页监听自动刷新）+ 瀑布流缩略图角标，反推后台化且全局可见、可取消（详见「已完成」反推后台化条目）。后端 `DESCRIBE_CANCEL` 单例保持不变（不再有第二张能 replace 它）。
- 相关文件：[store.ts](apps/desktop/src/store.ts)（`pumpDescribe` / `runDescribe` / `cancelDescribe`）、[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`DESCRIBE_CANCEL` 单例 + `analyses://changed` emit）、[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx)（缩略图角标）、[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)（改用 store 状态）。

### codex imagegen 产物落 ~/.codex/generated_images/，取图靠快照差分 + ingest 入库（2026-07-08）
- 现象/需求：创作板「生成」要取回 codex 生成的图，但不知 codex 把图写哪、JSONL 哪个字段带路径。
- 根因（spike 实测，codex-cli 0.142.5）：codex exec 调内置 `imagegen` 技能（`~/.codex/skills/.system/imagegen/`）画图，产物固定写 `~/.codex/generated_images/<thread-uuid>/ig_<hash>.png`（实测 1023×1537 PNG），**不在 JSONL 一等字段里**（路径只在 `agent_message` 文本 / `command_execution.aggregated_output` 里被模型提及）；codex exec 默认 `read-only` 沙箱会 **`Operation not permitted`** 阻止把图 cp 到 cwd，故**不能**用「设 cwd + 扫 cwd」兜底。JSONL 的 `error` 事件多是 chatgpt.com WS reset 噪声（codex 自动回退 HTTPS，不影响出图）。`--image <FILE>...` 是可变参数，prompt 必须走 stdin、不能放在 `--image` 之后（会被吞成图片）。
- 解决：`generate_image` 跑前快照 `$CODEX_HOME/generated_images/` 已有文件集，跑完取**差集**（`list_new_generated`，比 mtime 稳——下条踩坑说明 mtime 为何弃用）→ command 层 `ingest_generated` 进库为正式资产（source=codex、不算 pHash 不去重、进瀑布流）；`~/.codex/...` 不在 asset scope（`$APPDATA/**`）内故必须 ingest 进库才能渲染。`generate_image` 借用 tx 推 Delta（`item.completed(agent_message)` 即时发，真流式；旧 `run_stream` 一次性 Done + 前端 done 回调漏渲染 `c.text` 连最终文本都看不见，本次一并修）+ 返回源图路径，command 层 ingest 后以 asset 路径发 `Done` + emit `library://assets-changed`。取图走快照差分而非解析模型文本：稳、不依赖模型是否提及路径。
- 相关文件：[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)（`generate_image` / `list_new_generated` + 单测）、[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs)（`ingest_generated`）、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`codex_create_image`）、[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)（turns 时间线 + 流式回显）。

### 迭代修改看不到后续轮生成图（2026-07-08）
- 现象：生成首版后「提修改意见」续接 codex 出图，但只看到首版，修订图不见。
- 根因（三因叠加，诊断时一度以为是前端 bug，实则后端 + UX + 去重都有份）：① 取图用 `mtime≥start` 扫盘，**偶发漏图**（codex 写盘时机 / 时钟精度，实测 4 张里漏 1 张没 copy 进库 → `Done.images` 空 → 前端不更新）；② UX——首轮后醒目主按钮是「重新生成（新会话）」会**重置 turns**，「继续修改」是次要小按钮，用户易点错重置所以总只看 1 张；③ pHash 去重会让相似的修订版被当重复吞掉（入库路径若复用 `ingest_file` 会触发）。
- 解决：① 取图改**快照差分**（`list_new_generated`，跑前记文件集、跑后取差集）+ 单测；② UX 重构——首轮后「迭代修改」为主操作、「重新生成」降为次要；③ 生成图入库走专门的 `ingest_generated`（不算 pHash、不去重），迭代各版相似图都各自保留。
- 相关文件：[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)（`list_new_generated` + 单测）、[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs)（`ingest_generated`）、[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)（UX 重构）。

### 生成图标记走 source + 智能文件夹，未用 tags 系统（2026-07-08）
- 背景：要给生成图加标记方便后续分类。
- 决策：用 `assets.source="codex"` + 缩略图 ✨ 角标 + 侧栏「✨ 生成图」（`list_assets_smart` 按 `source:codex` 查），**不**用 tags 系统。
- 根因：`tags` / `asset_tags` 表 + FTS5 `tags` 列虽在 [0001_init.sql](apps/desktop/src-tauri/sql/0001_init.sql) / [0002_fts.sql](apps/desktop/src-tauri/sql/0002_fts.sql) 就绪，但 DB 方法 / Tauri 命令 / 前端 UI **全缺**（纯骨架），从零补成本高；而 `source:` 智能文件夹后端 `list_assets_smart` 已支持、生成图天然有 `source=codex`，零成本即可分类。tags 留待真正需要「一张图多标签 / 用户自定义标签」时再补。
- 相关文件：[commands/library.rs](apps/desktop/src-tauri/src/commands/library.rs)（`list_assets_smart` 命令）、[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx)（✨ 角标）、[Sidebar.tsx](apps/desktop/src/components/Sidebar.tsx)（生成图入口）。
- **2026-07-09 更新**：tags 系统已于 P2 补全（`get_or_create_tag`/`set_asset_tags`/`reclassify_all` + 前端类别板块，见「P2 标签 + 自动归类」）。上文根因「tags 全缺」是 2026-07-08 当时的事实、现已过时；**生成图仍用 `source` 而非 tag**——`source` 是结构化枚举，更适合「是否 codex 生成」这个二元属性，tag 留给多值语义分类（人像/风景…）。

### 创作板 codex chunk 监听器泄漏 → 生成图重复（2026-07-09）
- 现象：生成图「一次返回 2 张一样的」——同一张图被 append 多次。
- 根因：`listen()`（`@tauri-apps/api/event`）是**异步**的，返回 Promise。React StrictMode 双挂载 / 开关创作板触发组件卸载时，cleanup 可能在 Promise resolve **之前**先跑：此时 `unlisten` 还是 `undefined`，`return () => unlisten?.()` 啥也没干 → 监听器没被注销 → 下次挂载又 `listen` 一个 → 同一个 `codex://chunk` 的 `Done` 事件被 N 个遗留监听器各收一次 → `setTurns` 把同一张图 append N 次。
- 解决：加 `cancelled` 布尔，cleanup 先置 true；`listen().then(u => cancelled ? u() : (unlisten = u))`——若 Promise resolve 时组件已 cleanup，立即注销这个新建的监听器，杜绝遗留。
- 相关文件：原 [CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)。**2026-07-10 更新**：`codex://chunk` 监听随生成 UI 独立化挪到 [App.tsx](apps/desktop/src/App.tsx)（单次挂载、`alive` 守卫同此理），CreationBoard 不再监听。

### 瀑布流横向滚动（CSS columns 容器设固定高度陷阱）（2026-07-09）
- 现象：瀑布流横向滚动、竖向滚不动（应竖向滚动）。
- 根因：[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) 原把 `columns-*` 与 `h-full overflow-y-auto` 压在**同一个**容器上。CSS 多列布局：columns 容器一旦有固定高度，内容先纵向填满第一列到该高度，溢出部分**横向开新列**（第 N+1 列跑到右侧）→ 横向滚动；`overflow-y-auto` 又令 `overflow-x` 默认 `auto`，横向滚动条现身。竖向因各列被平衡在固定高度内反而不溢出，故竖向滚不动。
- 解决：滚动容器与 columns 容器拆两层——外层 `h-full overflow-y-auto`（固定高度 + 竖向滚动），内层 `columns-*` 不设高度、内容平分到 N 列后纵向自然增长，竖向滚动由外层负责。`boardPickMode` 的 ring/cursor 跟着挪到外层（视觉不变）。与「瀑布流缩略图加载抖动」同属 columns 布局陷阱。
- 相关文件：[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx)。

### 颜色筛选点了没反应：useEffect 依赖漏 colorFilter（2026-07-09）
- 现象：点侧栏颜色块，`colorFilter` state 变了但瀑布流不重新查询、还显旧列表。
- 根因：[App.tsx](apps/desktop/src/App.tsx) 的 `refresh()` useEffect 依赖数组是 `[currentFolderId, searchQuery, smartFilter, boardOpen]`，**没有 colorFilter**。Zustand setState 触发组件重渲染，但 useEffect 依赖未变就不重跑 → refresh 不触发 → 资产不按新 colorFilter 重拉。P3 把颜色筛选从前端精确匹配改成后端 `list_assets_by_color` 查询后才暴露——之前 colorFilter 是前端 `includes` 过滤（不靠 refresh），所以一直没踩。
- 解决：colorFilter 加进 refresh useEffect + `library://assets-changed` useEffect 的依赖数组；refresh 加 `colorFilter ? listAssetsByColor(colorFilter, currentFolderId) : ...` 分支。
- 教训：前端筛选 state 驱动**后端查询**时，承载它的 useEffect 依赖数组必须含该 state，否则「state 变了但查询没重跑」静默失效（从「前端过滤」迁移到「后端查询」时尤易漏）。
- 相关文件：[App.tsx](apps/desktop/src/App.tsx)（refresh useEffect 依赖）、[store.ts](apps/desktop/src/store.ts)（colorFilter）。

### 创作板图片间文字消失（onPick 陈旧闭包）（2026-07-10）
- 现象：用户在创作板编辑框打了一串字（如「请参考」），不按回车直接点瀑布流图，预期：文字 + 图都进 token 流；实际：**文字被丢掉**，只剩图。
- 根因：[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) 的 `bowerbird://board-asset-picked` 监听器注册在 `useEffect([], ...)` 里，闭包捕获的是**首次渲染**的 `flushDraft`，后者关上了首次渲染的 `draft`（初值 `""`）。React 函数组件每次渲染产生新闭包，但 `useEffect([])` 的那个监听器永远指向第一帧——后续 `setDraft` 更新的是新闭包里的 `draft`，监听器读到的仍是初值 `""`，`flushDraft` 判 `draft ? ... : ts` 走 falsy 分支、不 push 文本 token。**典型 React 陈旧闭包陷阱**。
- 解决：加 `draftRef = useRef("")`，每次渲染 `draftRef.current = draft` 同步最新值；`flushDraft` 改读 `draftRef.current`。监听器闭包虽陈旧，但 ref 是**可变容器**、`.current` 永远拿到最新值，绕开闭包捕获。未动 useEffect 依赖（仍为 `[]`，避免重复注册监听器）。
- 教训：`useEffect([])` 里注册的事件监听 / 定时器 / 订阅，其回调访问的 state 必须走 ref；或把回调本身 `useCallback` + 加进依赖。前者更省事。
- 相关文件：[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)（`draftRef` + `flushDraft`）。

### 退格删太多（文本 token 原子删）（2026-07-10）
- 现象：编辑框里退格一次，期望删一个字符；实际**整段文字一闪没了**（或退格一次吞掉一段长文字）。
- 根因：尾部 `<input>` + token 流模型下，未提交的草稿在 input 里，提交后变 text token。退格分支原本无条件 `setTokens(ts => ts.slice(0, -1))`——把最后一个 token（无论 text / image / keyword）**原子删除**。text token 可能是几十字的整段，一次退格就全没，违反「退格 = 逐字」的用户预期。image / keyword chip 反而希望原子删（一次退格删一个引用）。
- 解决：退格分支按 token 类型分流：`text` → `slice(0, -1)` 把它移出 token 流 + `setDraft(last.text.slice(0, -1))` 拉回 input 草稿框（少 1 字），用户继续退格就继续在草稿里逐字删；`image` / `keyword` → 原子 `slice(0, -1)`。这样：文字逐字删、引用一次删，符合直觉。
- 局限（诚实标注）：本编辑器是**尾部 input 模型**（只能从末尾追加 / 删），光标定位到中段编辑不支持。中段编辑需重写为 contenteditable / ProseMirror，本次不做。
- 相关文件：[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)（`onKeyDown` Backspace 分支）。

### BatchBar「移入已有」会污染 folder_id（kind 过滤只排除 smart）（2026-07-10）
- 现象：新增收藏夹（`kind='collection'`）后，BatchBar「移入已有文件夹」下拉把收藏夹也列为可选；选中收藏夹点确认，`moveAssetsToFolder` 把素材 `folder_id` 设成收藏夹 id —— 素材从原文件夹消失、反而被「移动」进收藏夹，污染位置语义（收藏夹本应走多对多 `asset_collections`、不动 `folder_id`）。
- 根因：原下拉过滤 `folders.filter(f => f.id !== 'root' && f.kind !== 'smart')` 只排除 smart，未排除新增的 collection；本意「能作为位置容器」只有 `kind='folder'`。
- 解决：改正向 `(f.kind ?? 'folder') === 'folder'`，只列普通文件夹；收藏夹不进 `folder_id` 选择池。
- 教训：用「枚举白名单」而非「排除黑名单」过滤可放入 `folder_id` 的容器——新增 kind 时黑名单必然漏。
- 相关文件：[BatchBar.tsx](apps/desktop/src/components/BatchBar.tsx)。

### 小红书 DOM 扫描漏轮播图、混头像，且 CDN URL 无扩展名（2026-07-14）
- 现象：发现页通用 `img[src]` 扫描会把头像、Logo、活动图一起采集；图文详情示例标示 10 张，但轮播 DOM 当时只挂 4 张唯一大图，通用扫描漏 6 张。小红书 CDN URL 通常没有文件扩展名，旧下载器把 URL 最后一段直接当 Windows 临时文件名，还可能带 `?` 等非法字符；即使下载内容实际是 WebP，也会得到空/错误扩展名。
- 根因：小红书是懒加载/虚拟轮播，素材权威列表在内嵌 `window.__INITIAL_STATE__`：发现页为 `feed.feeds[].noteCard.cover`，详情页为 `note.noteDetailMap[id].note.imageList`；CDN 格式由响应内容决定，不由路径后缀决定。旧 WS 收到 `page_url` 却未使用，`source_url` 错存成临时 CDN 地址。
- 解决：小红书专用适配器安全解析内嵌状态（只在字符串外把 `undefined` 转 `null` 后 `JSON.parse`，绝不执行页面文本）；站内 SPA 打开详情而首屏 script 未更新时，以 `credentials: omit` 重取当前公开详情 HTML，结构化仍失败再回退限定 DOM。`save_batch` 分开传 `media_url` / 笔记 `source_url`；下载器按魔数/Content-Type 定格式并使用 ULID 临时文件。公开 CDN 实测无需 Cookie，P0 明确不申请 Cookie 权限、不绕过登录/风控。
- 相关文件：[content.js](apps/extension/content.js)、[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)、[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs)。

### PowerShell 单返回值再取 `[-1]` 会退化成路径末字符（2026-07-14）
- 现象：`prepare.ps1` 明明输出 `D:\H\Project\Bowerbird\Windows\.work`，`build.ps1` 随后却尝试 `Push-Location D:\H\Project\Bowerbird\k`。
- 根因：PowerShell 命令只有一条成功输出时，赋值结果是标量字符串而非数组；对字符串做 `$WorkDir[-1]` 取得的是最后一个字符 `k`。只有命令返回多条输出时，同一写法才表现为「取最后一项」，因此问题会随输出数量摇摆。
- 解决：构建与开发脚本统一改为 `... | Select-Object -Last 1`，无论上游返回标量还是数组都取得最后一条完整路径。
- 相关文件：[Windows/build.ps1](Windows/build.ps1)、[Windows/dev.ps1](Windows/dev.ps1)。

### 换 logo 后 Windows 图标不刷新：debug exe 旧 + 资源管理器缓存（2026-07-14）
- 现象：logo3 资源已全量生成并随 `af2dc1c` 提交（`icons/icon.ico` 含 16/24/32/48/64/256 六尺寸、`tauri.conf.json` 的 `bundle.icon` + NSIS `installerIcon` 均正确、安装器 `8D68…` 内嵌图标提取确认 = logo3），但 Windows 桌面快捷方式与任务栏（dock）仍显示旧图标（开发模式下是 Tauri 默认的双指闪电）。
- 根因（两层，均非资源/代码 bug）：
  1. **debug exe 早于新 logo**：`apps/desktop/src-tauri/target/debug/deps/bowerbird_desktop-*.exe` 是上次 `pnpm tauri dev` 编译的产物（mtime 早于 `icons/icon.ico`）。图标由 `tauri_build` 在链接期从 `icon.ico` 注入 exe 资源——**只要没重新 `tauri dev`，debug exe 嵌的还是旧图标**，任务栏运行窗口图标即此旧图标。诊断手法：`[System.Drawing.Icon]::ExtractAssociatedIcon($exePath).ToBitmap().Save(...)` 提取 exe 内嵌图标肉眼核对。
  2. **Windows 资源管理器图标缓存**：桌面快捷方式、固定到任务栏的项会缓存旧 `.ico`（`%LOCALAPPDATA%\IconCache.db` + `Microsoft\Windows\Explorer\thumbcache_*.db` / `iconcache_*.db`），即使重装新版也照显旧图。
- 解决：① 开发模式 → 重新 `pnpm tauri dev`（或 `Windows/dev.ps1`）让 cargo 检测到 `icon.ico` 变化重链 debug exe；若不变则删 `target/debug/` 强制重编。② 跑 [Windows/clear-icon-cache.ps1](Windows/clear-icon-cache.ps1)（停 explorer → 清缓存 db → 重启 explorer）刷新桌面/任务栏固定项，之后**取消固定旧图标 → 重开应用 → 重新固定**。③ 安装版用户重装 `Windows/dist/Bowerbird_0.1.0_x64-setup.exe`（已是 logo3）后再跑清缓存脚本。
- 教训：「图标资源正确」≠「图标显示正确」——Windows 上换 logo 必须经过「重新编译/debug + 清资源管理器缓存」两步，资源层无 bug 时不要再回头改 `icons/` 或 `tauri.conf.json`。
- 相关文件：本条为部署侧经验，资源见 [icons/](apps/desktop/src-tauri/icons/)、[tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)；清缓存脚本 [Windows/clear-icon-cache.ps1](Windows/clear-icon-cache.ps1)。

### dev 在 Windows 检测不到 codex / 插件 WS = 主源码无 Windows 适配 + 端口冲突（2026-07-17）
- 现象：`pnpm tauri dev` 跑的 dev 版检测不到 codex CLI、插件 WS 连不上；同一机器的安装版完全正常。
- 根因（两个独立问题）：
  1. **codex**：dev 跑纯主源码，主源码 `codex_health` 死读 `$HOME`（Windows 无 `HOME`、用 `USERPROFILE`）+ `Command::new("codex")` 找不到 npm 装的 `codex.cmd` shim（Windows `CreateProcess` 不解析 PATHEXT）；`codex_cli.rs` 的 `run`/`generate_image` 同样 spawn 不到 → 整条 codex 链路在 Windows dev 不可用（不只 health 置灰）。安装版用 `Windows/overrides/`（有适配）+ `prepare.ps1` 覆盖主源码 → 正常。**主源码与 overrides 分叉**是根因。
  2. **WS**：`ws_server.rs` 主源码与 overrides 完全相同（都绑 `127.0.0.1:39871`）；dev「检测不到」是安装版正在运行占用 39871，dev 版 `TcpListener::bind` 撞 `AddrInUse` 失败，浏览器扩展连的其实是安装版（`netstat` 可见安装版 `bowerbird-desktop.exe` PID LISTENING 39871 + 几十个 TIME_WAIT）。
- 解决：① codex 适配合并进主源码（`resolve_codex_binary`/`codex_home`/`codex_command` + `codex_health`/`open_codex_session` Windows 分支，见「已完成」）；② WS 关掉安装版（`Stop-Process -Id <PID>`）释放端口后重启 dev。
- 教训：平台分叉（overrides）会让 dev 与安装版行为不一致、开发体验断裂；平台适配应直接进主源码（`#[cfg(target_os=...)]`），overrides 只作过渡、合并后即删。
- 相关文件：[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)、[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)、[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)、[Windows/prepare.ps1](Windows/prepare.ps1)。

### pnpm 11 默认忽略 esbuild 构建脚本 → tauri dev 前置依赖检查失败（2026-07-17，2026-07-27 更新）
- 现象：`pnpm tauri dev` 报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5`，pnpm 11「跑命令前的依赖检查」失败，dev 不启动。
- 根因：pnpm 11 默认拒绝未批准的依赖 postinstall；workspace 同时残留 `onlyBuiltDependencies: [esbuild]` 与自动生成的 placeholder `allowBuilds.esbuild: set this to true or false`，配置来源互相矛盾，且本机旧安装状态曾未真正执行 esbuild postinstall。
- 解决：固定使用项目声明的 pnpm 11.10.0，在根 [pnpm-workspace.yaml](pnpm-workspace.yaml) 只保留 `allowBuilds.esbuild: true`，重新执行 `pnpm install --frozen-lockfile`；pnpm 11 官方设置中 `allowBuilds` 已取代 `onlyBuiltDependencies` / `neverBuiltDependencies` / `ignoredBuiltDependencies`。前端 `pnpm build` 实际调用 Vite/esbuild 成功是最终可用性门禁；若旧 node_modules 仍记 ignored，再清理安装状态后重装，不靠同时保留两套许可键掩盖问题。
- 相关文件：[pnpm-workspace.yaml](pnpm-workspace.yaml)。

### ProseMirror schema 漏 group:"inline" → chip 插入被静默丢弃（2026-07-18）
- 现象：点瀑布流图，创作板编辑框闪一下（`view.focus()` 生效）但 image chip 没插入。
- 根因：[creation/schema.ts](apps/desktop/src/components/creation/schema.ts) 的 image/keyword 节点只写 `inline: true`，漏 `group: "inline"`。ProseMirror 里 `inline: true` 仅表示「按行内渲染」，**不自动归入 `inline` group**；而段落 `content: "inline*"` 只放行属于 `inline` group 的节点 → `replaceSelectionWith` 插入时被 content check 静默丢弃（step 不生效、doc 不变），但 focus 照跑 → 「闪一下没插入」。
- 解决：image/keyword 加 `group: "inline"`。
- 教训：PM 节点的 `inline`（渲染属性）与 `group`（content expression 匹配依据）是两回事；inline 节点要进 `content: "inline*"` 必须显式 `group: "inline"`。
- 相关文件：[creation/schema.ts](apps/desktop/src/components/creation/schema.ts)。

### ProseMirror 集成若干 API 坑（2026-07-18）
- `baseKeymap`（prosemirror-commands）是 `Keymap` 对象（`{[key: Command]}`）**不是 Plugin**，裸放 plugins 数组类型错；需 `keymap(baseKeymap)` 包装。
- `Node` 无 `append` 方法（给段落尾追加节点时）——改收集 `PmNode[][]` 后 `paragraph.create(null, [...inline, ...silent])` 重建。
- `EditorView.clipboardTextParser` 签名 `(text, $context) => Slice`，**返回不能 null**；无匹配时返回纯文本 slice（按 `\n` 分段、每段 `parsePromptToInline`），单段 inline slice（首尾是 text 时 `openStart/openEnd=1` 融入相邻文字）、多段 block slice。
- IME 组合守卫：维度/`@图名` 标点匹配 keymap 需 `view.composing` 为 true 时跳过（中文输入法组字期空格是选词键，拦截会打断输入）。
- Tailwind class 写在 toDOM 的 DOM spec 字面量（`["span", { class: "mx-1 inline-flex ..." }]`）可被 Tailwind 扫描到，无需额外配置。
- 相关文件：[creation/plugins.ts](apps/desktop/src/components/creation/plugins.ts)、[creation/parse.ts](apps/desktop/src/components/creation/parse.ts)、[creation/useCreationEditor.ts](apps/desktop/src/components/creation/useCreationEditor.ts)、[creation/schema.ts](apps/desktop/src/components/creation/schema.ts)。

### reuse 后 preset 重复拼接（2026-07-18）
- 现象：生成面板「📋 复用到创作板」载入 prompt 后，若用途（preset）仍选中，改完再发送会重复拼 preset body（body 出现两次）。
- 根因：`reusePromptToBoard` 载入的是 `genLastPrompt`（= 原本发送的完整文本，**已含当时 preset 的 body**）；载入后不清 `activePresetId`，`startGeneration` 又拼一次。
- 解决：[store.ts](apps/desktop/src/store.ts) `reusePromptToBoard` 载入时 `set({ activePresetId: null })`——载入文本已是完整内容（preset body 内化进文本），不再叠加。
- 相关文件：[store.ts](apps/desktop/src/store.ts)。

### Tauri 2 默认拦截 HTML5 拖拽（dragDropEnabled 反直觉）（2026-07-18）
- 现象：瀑布流拖素材到侧栏文件夹，拖拽时光标显示「禁止放置」、松手无反应（前端 `onDragOver`/`onDrop` 根本不触发）。
- 根因：Tauri 2 [tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json) 的 `app.windows[].dragDropEnabled` **默认 true**，但语义反直觉——true = 「Tauri 原生拖拽启用 **且 HTML5 DnD 被禁用**」：原生层拦截拖拽事件走 `tauri://drag-drop` 用于「文件拖入窗口」，前端 dragover/drop 收不到 → 浏览器判「不允许 drop」显示禁止光标（见 [Issue #14373](https://github.com/tauri-apps/tauri/issues/14373)）。v1 叫 `fileDropEnabled`，v2 改名 `dragDropEnabled`。
- 解决：项目无任何 Tauri 原生 onDragDrop 用法（导入走对话框 / 扩展采集），把 `app.windows[0].dragDropEnabled` 设 `false` 恢复 HTML5 DnD。**注意是 window 级键**（`app.windows[]` 内），不是 app 顶层。改动需**重启** `pnpm tauri dev` 才生效（tauri.conf.json 不热更新）。
- 相关文件：[tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)、[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx)、[Sidebar.tsx](apps/desktop/src/components/Sidebar.tsx)。

### npm.cmd 路径含空格 + cmd.exe /C 引号陷阱（2026-07-29）
- 现象：首启「一键安装」点了立刻报 `npm 安装失败（退出 exit code: 1）`，但终端手敲 `npm install -g @openai/codex` 成功。
- 根因：用户 npm 本体在 `C:\Program Files\nodejs\npm.cmd`（**路径含空格**）。`npm_command` 用标准 `.arg(binary)` 把含空格路径交给 `cmd.exe /C`——Rust 的 arg 转义（给含空格 arg 加引号）与 cmd 自身引号规则冲突，cmd 把 `C:\Program` 当程序名 → 解析失败 exit 1。codex 没踩坑是因其二进制在 `%APPDATA%\npm\`（无空格）。另：失败 reason 最初只拼 stderr（空），npm 错误实际在 stdout，导致看不到真因。
- 解决：① `npm_command` 改用 `raw_arg`（`std::os::windows::process::CommandExt`）拼 `cmd /D /S /C ""<binary>" <args>"`——外层引号包整条命令、内层包路径，`/S` 让 cmd 剥外层引号后正确解析含空格路径 + args；args 随 `npm_command(binary, &args)` 构造时传入（不再 `.arg` 追加）。② `codex_install` 失败 reason 同时拼 stdout+stderr（npm 错误常在 stdout）。
- 教训：Windows 上 spawn 用户机器的 `.cmd`（npm/git/node…）必须假设路径含空格（Program Files），走 `raw_arg` + `/S /C ""path" args"`，别用标准 `.arg`。
- 相关文件：[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)（`npm_command`）、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`codex_install` reason）。

### vite 会拦死引用（不只 tsc）（2026-07-29）
- 现象：`pnpm tauri dev` 报 `Failed to resolve import "./SettingsDialog" from Toolbar.tsx`，前端白屏。
- 根因：SettingsDialog 模块之前删 settings 时删了，Toolbar 的 import/state/⚙按钮/渲染漏清成死引用。误判「vite/esbuild 不跑完整 tsc，类型错误不影响 dev」——**错**：vite 的 import-analysis 插件会**实打实解析 import**，模块不存在直接报错白屏，比 `tsc --noEmit` 更硬。
- 解决：清掉 [Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx) 的 SettingsDialog 残留（import / `useState` / ⚙按钮 / 渲染 + 没用的 `useState` import）。
- 教训：删模块时 grep 全仓 import 别漏；vite 报 import 错是硬阻塞（白屏），不是 tsc 那种「类型警告不影响 dev」。

### AssetDetail 独立 codexHealth 副本不同步（2026-07-29）
- 现象：onboarding 一键登录成功后，CreationBoard/GenerationPanel 的置灰按钮（走 store codexHealth）刷新了，但 AssetDetail 反推按钮还置灰（要关重开详情页才刷新）。
- 根因：[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 有独立的 `const [codexHealth, setCodexHealth] = useState(...)`，**不走 store**，登录成功后没人通知它刷新。
- 解决：`codex_install`/`codex_login` 成功后端 emit `codex://health-changed`；App（写 store）+ AssetDetail（自己的 useState）各自 listen 重取 codexHealth。最小改动（不动 AssetDetail 的 state 结构，只加 listener）。
- 教训：同一份状态（codexHealth）在多个组件有副本时，变更要广播 event 让所有副本自刷新，否则部分组件展示过期。

### tauri.conf resources 路径相对 src-tauri（2026-07-29）
- 现象：`cargo check` 报 `glob pattern ../../apps/extension/**/* path not found`，build script 失败。
- 根因：bundle.resources 路径相对 **tauri.conf.json 所在目录（src-tauri）**，到 `apps/extension` 是 `../../extension`（src-tauri→apps/desktop→apps→extension），多写一层 `apps` 成 `apps/apps/extension`。
- 解决：`"../../extension/**/*": "extension/"`。
- 相关文件：[tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)。

### explorer 不认含 .. 路径 + Chrome 单实例丢 URL → 改「复制 + 教粘贴」（2026-07-29）
- 现象：`open_extension_folder` 用 `CARGO_MANIFEST_DIR/../../extension`（含 `..`）→ explorer 兜底开「文档」；`open_extensions_page` 用 `start chrome URL` → 开新 Chrome 但 URL 丢。
- 根因：① explorer.exe 不认含 `..` 的路径，兜底开默认库（文档）；② Chrome 已跑时 `start chrome URL` 的 URL arg 被单实例吞掉，只开空窗口。即便定位 chrome.exe + `--new-window` 也因用户装位置不一而不稳。
- 解决：放弃自动打开，改**一键复制**——`chrome://extensions` 前端直接复制固定串；扩展文件夹路径后端 `extension_folder_path` 返回（dev 用 `parent().parent()` 拼绝对路径避免 `..`），前端复制 + 教用户粘贴到 chrome「加载已解压」对话框地址栏。
- 教训：Windows 上「自动打开外部程序 + 传参」坑多（路径含空格/`..`、浏览器单实例），引导类功能优先「复制 + 教粘贴」，稳且跨浏览器。
- 相关文件：[commands/collect.rs](apps/desktop/src-tauri/src/commands/collect.rs)、[ExtensionOnboarding.tsx](apps/desktop/src/components/ExtensionOnboarding.tsx)。

### 残留扩展心跳导致引导反复消失（2026-07-29）
- 现象：移除一个浏览器的 Bowerbird 扩展后，ExtensionOnboarding 仍反复消失/出现（绿点亮灭）。
- 根因：扩展跟着浏览器走（不随 git 分支），别的浏览器（如 Edge）或未刷新页面的残留 content script 仍每 15s 心跳连 WS → `collect://extension-connected` → 引导判定「已连」自动关；扩展断开 30s 超时 → 又弹，反复。
- 排查：ws_server 加 `tracing::info!("collect ws: connection opened/closed")` 日志看频率 + `netstat -ano | findstr 39871` 找连接进程。
- 解决：找出并移除所有浏览器的扩展 / 刷新页面清残留 content script。
- 相关文件：[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)（连接日志）。

### tokio Command 的 creation_flags/raw_arg 是 inherent 方法（2026-07-29）
- 现象：`use std::os::windows::process::CommandExt;` 报 unused import，但 `.creation_flags()` / `.raw_arg()` 能调。
- 根因：tokio::process::Command 在 Windows 自带 creation_flags/raw_arg（inherent 方法），不需 std trait 在 scope。
- 解决：删多余的 `use std::os::windows::process::CommandExt;`。
- 相关文件：[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)、[collect.rs](apps/desktop/src-tauri/src/commands/collect.rs)。

### 绕 Windows overrides 打包 → save_blob 退化为桌面 reqwest 下载（2026-07-29）
- 现象：扩展安装/心跳都正常，Pinterest 采集却报 `save_one fail ... error sending request`；尝试给 reqwest 自动读 Windows 系统代理/native roots 后仍复杂且不稳定。
- 根因：原 Windows 可用版不是靠桌面 reqwest，而是**浏览器 background fetch + save_blob 二进制上传**（浏览器天然继承系统代理、Cookie、登录态）。本次为包含小白化而绕过 `Windows/overrides` 打主源码，canonical 仍走 `save_batch`（桌面二次下载），把已验证的 Windows能力回退了。代理问题只是表象，架构分叉才是根因。
- 解决：把成熟 save_blob 主链并入 canonical 主源码：[background.js](apps/extension/background.js) 浏览器 fetch → WS metadata+binary；ws_server `handle_blob` → `ingest_from_bytes`。撤回 Rust 系统代理/native-roots补丁；Windows/mac canonical统一。Pinterest真机恢复。
- 教训：平台 override 中已有关键能力时，绕开 overrides 打包前必须做协议/能力差异审计；不能用网络补丁掩盖架构回退。浏览器登录态资源应在浏览器侧取字节，桌面端只做可信边界后的格式验证/入库。
- 相关文件：[background.js](apps/extension/background.js)、[content.js](apps/extension/content.js)、[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)、[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs)。

### 拖链接包图片会把外层商品页 URL 当图片（2026-07-29）
- 现象：拖商品图到 Bowerbird 时，真实图片可采，但同时出现 `save_one fail: https://.../products/... | download is not a supported image`。
- 根因：浏览器 DataTransfer 对 `<a href=商品页><img src=图片>` 常同时给 `uri-list/plain=商品页` 与 `text/html=<img src=图片>`；旧 canonical `urlsFromDropEvent` 无条件合并三类 URL，把商品页也当图片。且通用批量仅扫 `img[src]`，漏 srcset/lazy/CSS/OG/JSON-LD 等现代网页结构。
- 解决：新增可测试 [candidate-utils.js](apps/extension/candidate-utils.js)：拖拽 **HTML 图片命中即忽略 uri-list/plain**（7个Node回归测试）；统一候选模型/优先级/去重≤100，content 覆盖 currentSrc/srcset/picture/lazy/CSS/meta/JSON-LD/open shadow，background 对 page-or-image/HTML 做一次 OG fallback，最终仍由 Rust 字节 sniff。
- 教训：候选 URL 必须带 `kind/source/priority`，字符串 URL 本身不能隐含“必是图片”；页面发现、浏览器 fetch、字节验证是三层职责，不能只靠末端拒绝 HTML。
- 相关文件：[candidate-utils.js](apps/extension/candidate-utils.js)、[candidate-utils.test.js](apps/extension/candidate-utils.test.js)、[content.js](apps/extension/content.js)、[background.js](apps/extension/background.js)。

### 迁移素材库到自定义位置后全部图片破图（2026-08-01）
- 现象：设置里把素材库迁到 `D:\Tools\BowerbirdLibrary` 后重启，应用能启动、数据库正常读取，但瀑布流与详情页图片全破；终端刷 `asset protocol not configured to allow the path: D:\Tools\BowerbirdLibrary\thumbnails\...`。
- 根因：迁移本身成功（文件在、DB 路径已改写），破图是 **Tauri asset 协议白名单**问题——前端 `convertFileSrc()` 走 `asset://` 协议，其 scope 默认只放行应用数据目录；自定义库根不在白名单内，后端逐张拒绝。
- 解决：在 [lib.rs](apps/desktop/src-tauri/src/lib.rs) setup 里 `app.asset_protocol_scope().allow_directory(&paths.root, true)?`，把**当前实际库根**（默认或自定义）显式加入白名单；随库根走，迁移后天然放行。
- 教训：任何会改变前端图片加载路径目录的功能（库迁移、自定义目录），必须同步考虑 asset 协议 scope；`convertFileSrc` 不是"能读任意路径"，而是受 Tauri 配置的目录白名单约束。
- 相关文件：[lib.rs](apps/desktop/src-tauri/src/lib.rs)。

### 异步入库若实时读取当前项目会发生归属漂移（2026-07-30）
- 现象：用户在扩展上传二进制帧或 codex 续轮生成完成前切换项目，若完成时才读取 `currentProjectId`，素材会被错误归入后来进入的项目。
- 根因：项目选择是界面瞬时状态，而扩展 metadata→binary、生成首轮→续轮都是跨时异步流程；浏览器扩展协议又不携带项目 ID，不能把「任务完成时的当前项目」误当成「任务发起时的项目」。
- 解决：扩展后端用 `ActiveProjectContext`，在收到 save 消息或 blob metadata 时快照项目并随 pending upload 保存；生成前端在首轮 `startGeneration` 时写 `genProjectId`，所有续轮沿用；显式导入命令直接传调用时的 `project_id`。项目在途中被删时，中央库入库仍成功，成员关联失败只告警、不回滚素材。
- 教训：所有跨 await/跨消息边界的项目归属都必须在流程起点快照，禁止在完成回调重新读取 active scope。
- 相关文件：[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)、[projects.rs](apps/desktop/src-tauri/src/core/projects.rs)、[store.ts](apps/desktop/src/store.ts)、[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)。

### 全仓 cargo fmt --check 被既有格式漂移阻塞（2026-07-30）
- 现象：项目 Workspace 改动本身已格式化，但 `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml` 仍在 `codex_cli.rs`、`autoname.rs`、`caption.rs` 等本次未修改文件报告差异。
- 根因：仓库已有未归一的 rustfmt 漂移；直接运行全仓 `cargo fmt` 会产生大量与功能无关的改动，违反外科式修改原则，也会污染本次 diff。
- 解决：只对本次新增 Rust 文件运行 rustfmt，并用 `cargo check`、`cargo test`、`git diff --check` 验证编译、测试和空白错误；既有格式漂移留待独立格式化提交处理。
- 相关文件：[projects.rs](apps/desktop/src-tauri/src/core/projects.rs)、[projects.rs](apps/desktop/src-tauri/src/commands/projects.rs)。

### StrictMode 双挂载泄漏 Tauri 监听器 → 新建项目后瀑布流被旧 scope 覆盖（2026-07-31）
- 现象：新建项目成功、侧栏已进入项目（`currentProjectId` 已变），瀑布流却仍显示全局素材；点击已有项目进入则正常。
- 根因（三层叠加）：
  1. `listen(...).then(u => unlisten = u)` + cleanup `unlisten?.()` 的经典竞态：React StrictMode 双挂载下，第一次 effect 的 `listen()` promise 未 resolved 时 cleanup 已跑（`unlisten` 还是 undefined），promise 随后把注销函数写进**死闭包**——监听器永久泄漏，且冻结着**首帧渲染的 `refresh` 闭包**（`currentProjectId=null`，全局 scope）。App 里 `codex://chunk` / 扩展连接两个监听器早有 `alive` 守卫防此坑，`library://assets-changed` 等其余六个漏了。
  2. 新建项目时 `create_project` 会 emit `library://assets-changed`（点已有项目不 emit，所以只有新建触发）：泄漏监听器以全局 scope 排了 300ms 去抖刷新，它的 cleanup 是死闭包、定时器**清不掉**。
  3. `refreshVersion` 守卫只防「旧请求晚到」，防不了「晚发起的新请求」：泄漏的全局刷新在项目刷新**之后**启动，拿到更高 version，守卫反而保护了它 → 项目结果先正确显示，300ms 后被全局结果覆盖。
- 解决：App.tsx 全部 Tauri 事件监听器统一补 `alive` 守卫（`then(u => alive ? unlisten = u : u())`，cleanup 先置 `alive=false`），与 `codex://chunk` 既有模式一致。**注意：已泄漏的监听器只活在当前页面里，必须重启/重载应用窗口才会消失**，HMR 热更新清不掉。
- 教训：Tauri 前端所有 `listen()` 都必须按「cleanup 可能先于注册完成」写；闭包捕获渲染态（而非 `useStore.getState()` 或 store 稳定函数）的监听器一旦泄漏就是陈旧 scope 炸弹。
- 相关文件：[App.tsx](apps/desktop/src/App.tsx)。

### Windows 前端 overrides 整文件覆盖与主项目分叉 → 出包 tsc 失败（2026-07-20，prod 线）
- 现象：`Windows/build.ps1 -Clean` 出包时 `tsc --noEmit` 报 12 处错——[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) / [CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) / [GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) / [SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 引用 `State` 上不存在的 `presets` / `viewGenerationHistory` / `colorRebuild` / `genRefAssets` / `reusePromptToBoard` 等字段。
- 根因：`Windows/overrides/apps/desktop/src/` 的 `store.ts` / `App.tsx` / `Toolbar.tsx` / `WelcomePanel.tsx` 是早期为加 Windows 专属功能（扩展连接状态、采集提示、环境状态面板）从主项目分叉出的**整文件覆盖**副本。主项目 store 其后大幅演进（presets/activePresetId/reloadPresets 进 store、colorRebuild 进 store、删 boardPickMode、startGeneration 改签名为 `(prompt, references: Asset[], ratio?)`、viewGenerationHistory/reusePromptToBoard 新增），override 副本没跟上。`prepare.ps1` 用 `robocopy overrides .work /E` 把这些旧副本整文件覆盖回 `.work` → `.work` 里「主项目新组件 + override 旧 store」类型对不上。这是「dev 在 Windows 检测不到 codex」同一条教训的又一次复现：**整文件覆盖式 override 与主源码演进必然分叉**。
- 解决：把四个 override 的差异化功能（`extensionConnected` / `collectedNotice` + 环境状态展示）并入主项目源码——[store.ts](apps/desktop/src/store.ts) 加两字段+setter、[App.tsx](apps/desktop/src/App.tsx) 加 `collect://extension-connected` 与 `library://assets-changed`(payload.name) 两 listener、[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 环境状态区加「浏览器扩展」连接行、[Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx) 加「已采集：xxx · 查看」提示条——然后删掉这四个 override（`.work` 直接用主项目源码）。**2026-07-27 最终收敛**：`save_blob` / `ingest_from_bytes` 也合入 canonical，剩余 Rust、扩展和 workspace override 全部删除，`prepare.ps1` 不再 overlay。
- 教训：overrides 只作平台适配过渡，差异化功能应直接进主源码、合并后即删；**整文件覆盖**会在主源码演进时静默分叉，下次出包才以编译或协议错误暴露。当前 `Windows/overrides/` 仅保留退役说明，不应重新加入产品文件。
- 相关文件：[store.ts](apps/desktop/src/store.ts)、[App.tsx](apps/desktop/src/App.tsx)、[components/SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx)、[components/Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx)、[Windows/prepare.ps1](Windows/prepare.ps1)。

### codex 生成失败提示被双重藏匿（2026-07-23，prod 线）
- 现象：创作板发 codex 生成失败时，生成面板只显示「尚未生成。在创作板组稿后点『✓ 发送 codex 生成』。」，用户看不到失败原因、也无重试入口。后端其实返回了可读错误（codex 退出码 + stderr 前 500 字，经 `AppError` 序列化成纯字符串到前端）。
- 根因：前端双重藏匿——① `genHandleError` 把 `[error: msg]` 塞进 `genStreaming` 的**同时删掉失败的占位轮**（设计初衷是避免空轮留在时间线）；② `GenerationPanel` 的 `genStreaming`（含错误）**只在 `genTurns` 非空时渲染**。首发失败 → 占位轮被删 → `genTurns=[]` → 命中空态文案 → 错误永不可见。
- 解决 / 绕过：失败不再「删轮 + 藏 streaming」，改为挂到那一轮——`GenTurn` 加 `error` 字段，未出图的占位轮记 error 成「失败轮」（时间线可见 + 可重试），不追加 streaming 避免与失败态重复。两个守卫：① 取消（「已取消」）仍删轮不留红字（取消非失败）；② **已出图后的后置失败**（done 已到、meta/caption 写库失败）最后一轮已有图，错误降级进 streaming、绝不把成功出图轮误标失败。续轮失败重试先移除失败轮再 resume，避免同 prompt 编号递增的重复轮。两条错误路径（invoke reject 走 `genHandleError` / chunk Error 走 `applyGenChunk`）统一经 `applyGenError`。
- 相关文件：[store.ts](apps/desktop/src/store.ts)（`applyGenError` / `genHandleError` / `retryLastGenTurn`）、[GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx)（`TurnView` 失败态）、[lib/types.ts](apps/desktop/src/lib/types.ts)（`GenTurn.error`）。

### dreamina stdout 是 pretty JSON（多行），不能按 JSONL 行解析（2026-07-23，prod 线）
- 现象：Phase 2 jimeng provider `parse_submit_id` 报「dreamina 提交输出未含 submit_id」，但 stdout 里明明有 `submit_id`（dreamina 实际出图成功，`gen_status=success`）。
- 根因：dreamina CLI 输出**格式化（pretty）JSON**——每字段一行带缩进（`{\n  "submit_id": "...",\n  ...}`），不是 codex 那种单行 JSONL。`parse_submit_id` 照搬 codex JSONL 习惯用 `stdout.lines()` 逐行找 `{` 开头——pretty JSON 只有第一行是 `{`（不完整，serde 解析失败），其余字段行（`"submit_id": ...`）不以 `{` 开头被跳过 → 解析不到。
- 解决：整体解析 stdout 为一个 JSON 对象——`stdout.find('{')` 取首个 `{` 起，`serde_json::Deserializer::from_str(&stdout[start..]).into_iter().next()` 流式取首个值（容忍前导提示行 + 尾随文本），不按行。
- 教训：新 CLI 输出格式不能假设（codex JSONL vs dreamina pretty JSON）。spike 时看到多行但手动读 submit_id 没踩坑，写代码按行解析才暴露——spike 应顺手验证「代码打算用的解析方式」对不对。
- 相关文件：[codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs) `parse_submit_id`。

### dreamina OAuth app spawn 不写 token（2026-07-24，2026-07-25 定位根因，prod 线）
- 现象：app spawn `dreamina login`（无论 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE / 非 headless / headless+checklogin / stderr null）授权后**都不写登录态**（`dreamina user_credit` 仍未登录），但命令行 `dreamina login` 一次成功（写 token）。
- 根因（2026-07-25 定位）：**`dreamina login` 非 headless 依赖 `isatty(stdout)`**——stdout 是真 TTY 时才走「打印授权材料 + 阻塞等授权 + poll checklogin + 写 token」完整流程。app spawn 时 `stdout(Stdio::piped())`（为读 verification_uri 透传前端）把 stdout 接成 pipe → dreamina 判定非 TTY → 进程在打印 `[OAuthLogin] start login flow` 后静默早退，token 永不写入。`CREATE_NO_WINDOW`/`CREATE_NEW_CONSOLE` 都无效——它们只控弹不弹黑窗，**不改 `isatty(stdout)`**；真正的 TTY 判定由 `Stdio::piped()` 决定，与 creation_flags 无关。
- 证据：① `~/.dreamina_cli/logs/` 日志时序——终端跑 dreamina login 进程持续 poll **2 分 24 秒**到 `query current user success`（token 写入）；app spawn 每次只有 `[OAuthLogin] start login flow` 一行后再无任何日志（没请求 device_code、没 poll、没报错，进程消失）。② git 时间线——`dreamina_login` 命令在 commit `ac5e171`（2026-07-23 13:28）才引入，而日志里唯一一次成功登录在 2026-07-23 00:31（早 13 小时），那次 100% 是终端手动跑，app spawn 从未成功过。③ `dreamina login --help` 原文「By default … waits for authorization to complete」+ 官方 SKILL.md + 社区共识「stdout redirected breaks because it depends on a TTY」。④ `user_credit`/`text2image` 等非交互命令在 app spawn（CREATE_NO_WINDOW + stdout piped）下完全正常——问题仅限 login 的交互式 OAuth 路径。
- 解决：新增 [`open_dreamina_login`](apps/desktop/src-tauri/src/commands/jimeng.rs) 命令，**拉起真正的系统终端窗口**（Windows `cmd.exe /D /C start "" cmd.exe /K "dreamina login"`、macOS `osascript`→Terminal.app `do script`）跑 `dreamina login`——真 TTY 保证 dreamina 完整走完 OAuth + 写 token。对称 [`open_codex_session`](apps/desktop/src-tauri/src/commands/codex.rs)（codex「在终端打开会话」已验证同模式）。当前 [DreaminaOnboarding.tsx](apps/desktop/src/components/DreaminaOnboarding.tsx) 的主按钮「打开终端登录」调用该命令，并以复制命令作为兜底。端到端实测通过。**未采用的备选**：方案 B（`--headless` + `checklogin` 纯 in-app，UX 更好不弹终端）——headless 不依赖 TTY、机制可行（SKILL.md 证实 device flow 打印 verification_uri/user_code/device_code 后退出，checklogin 跨进程补完写 token），但 device_code 时序敏感（2026-07-24 踩过「过期」）+ headless 输出格式 / checklogin 在 app spawn 写 token 未实测，且即梦登录一次性、方案 A 已够用；保留 dead 的 `dreamina_login`/`dreamina_check_login` 命令备方案 B 复用。
- 教训：① CLI 的交互式 OAuth（渲染二维码/链接 + 等 authorization）常依赖 `isatty(stdout)`，GUI app `Stdio::piped()` 会破坏 TTY 身份触发早退——先查 isatty，别往 console/credential store/DPAPI 方向猜。② 命令行验证通≠app spawn 通；登录类操作若必须交互式，拉起一个真终端窗口（真 TTY）是最可靠的 app 内方案。③ 实测 CLI OAuth 时优先翻 `~/.dreamina_cli/logs/`，进程「持续 poll 到完成」vs「早退」一眼可辨。
- 相关文件：[commands/jimeng.rs](apps/desktop/src-tauri/src/commands/jimeng.rs)（`open_dreamina_login`）、[DreaminaOnboarding.tsx](apps/desktop/src/components/DreaminaOnboarding.tsx)、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`open_codex_session` 模板）。

### website 跑 npm install 破坏 pnpm 的 node_modules/.bin（2026-08-04）
- 现象：`pnpm --filter @bowerbird/website dev` 报 `'vite' 不是内部或外部命令`；查 `website/node_modules/.bin` 目录不存在，但 vite/prosemirror 等软链还在（指向根 `.pnpm` store）。
- 根因：项目是 pnpm workspace（`pnpm-lock.yaml` + `pnpm-workspace.yaml`），但 `website/` 下出现 `package-lock.json`（npm 产物）——为给 Render 的 `npm ci` 生成锁文件，曾在 website 目录跑过 `npm install`。npm 接管 node_modules 时未正确重建 pnpm 的 `.bin` shim 目录（软链还在、`.bin` 被清），pnpm 又认为依赖「已是最新」不主动重建（`pnpm install` / `--force` 都提示 up to date、无效）。
- 解决：删除残缺的 `website/node_modules` 后 `pnpm install` 重建 `.bin`；并从根本上让 Render 也用 pnpm（删 `package-lock.json`、[render.yaml](render.yaml) 改 pnpm 构建），消除「为 Render 生成 npm lock 而本地跑 npm」的诱因。
- 教训：pnpm workspace 项目里任何子包都不要跑 `npm install`——会生成 `package-lock.json` + 破坏 pnpm 的 node_modules 结构。若必须给 npm 环境提供锁文件，用 `npm install --package-lock-only`（只生成 lock 不动 node_modules）。
- 相关文件：[website/package.json](website/package.json)、[render.yaml](render.yaml)。

### Render 构建环境 /usr 只读，corepack enable 与 npm i -g 都失败（2026-08-04）
- 现象：Render 部署官网，buildCommand 依次试 `corepack enable && pnpm install` 与 `npm i -g pnpm@11.10.0 && pnpm install` 都失败：① corepack 报 `EROFS: read-only file system, unlink '/usr/bin/pnpm'`；② npm 报 `EROFS ... rename '/usr/lib/node_modules/pnpm'`。
- 根因：Render 的 Node 运行时把整个 `/usr`（预装 Node 全局目录 `/usr/lib/node_modules` + `/usr/bin`）挂成只读。`corepack enable` 要在 `/usr/bin` 创建 pnpm shim、`npm i -g` 要写 `/usr/lib/node_modules`，两者撞同一堵墙。`COREPACK_HOME` 环境变量只重定向 corepack 的包缓存目录、**不改 shim 安装位置**，故无效。
- 解决：buildCommand 把 pnpm 装到用户主目录（POSIX 保证可写）并用绝对路径调用：`npm i -g pnpm@11.10.0 --prefix $HOME/.npm-global && $HOME/.npm-global/bin/pnpm install --frozen-lockfile && pnpm build`。`--prefix` 让 npm 全局装到 `$HOME/.npm-global/{lib/node_modules,bin}`，绝对路径调用不依赖 PATH、不碰 `/usr`。备选（未采用）：`npx pnpm@11.10.0 ...`（npx 下载到用户缓存 `~/.npm/_npx`，同样可写）。
- 教训：PaaS 构建环境（Render / Heroku 类）常把系统 Node 目录设只读，任何全局安装（`corepack enable` / `npm i -g`）都要指定可写 `--prefix` 或用 `npx`（下载到用户缓存）。`COREPACK_HOME` 不解决 shim 写系统目录的问题。
- 相关文件：[render.yaml](render.yaml)。

### `HashMap::new()` 非 const，static 初值必须用 LazyLock（2026-08-06）
- 现象：`static GENERATE_CANCEL: Mutex<HashMap<String, _>> = Mutex::new(HashMap::new())` 编译报 E0015「cannot call non-const associated function `HashMap::new` in statics」。
- 根因：`HashMap::new()` 不是 const fn（HashMap 无 const 构造），不能进 static 初始化表达式（static 仅允许 const fn / tuple struct / variant）；`Option::new(None)` 能进 static 是因为 `None` 本身是 const。
- 解决：改 `std::sync::LazyLock<Mutex<HashMap<...>>> = LazyLock::new(|| Mutex::new(HashMap::new()))`，首次访问时初始化；访问处 `.lock().unwrap()` 不变（LazyLock 自动 deref）。同模式适用于 `Semaphore::new` 等非 const 内部。
- 教训：Rust static 放 `Mutex<HashMap>`/`Mutex<Vec>`/`Semaphore` 等非 const 内部，一律用 `LazyLock::new` 包。
- 相关文件：[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`GENERATE_CANCEL` HashMap、`JIMENG_FLY` Semaphore）。

### 同步命令模型下 currentGenJobId 时机：生成中取消失效 → started 事件（2026-08-06）
- 现象：Task 2 per-job 取消手测发现——生成中点取消无反馈，即梦取消后仍出图。
- 根因：保留同步 invoke 模型（`codex_create_image` 阻塞到完成才返回）时，前端 `startGeneration` 的 `set currentGenJobId` 在 `await codexCreateImage` **完成后**才执行——生成中 `currentGenJobId` 仍为 null → `cancelGeneration` 的 `if (jobId)` 不执行 → 取消没调后端。
- 解决：后端 enqueue 后立即 `emit("codex://chunk", {kind:"started", job_id})`，前端 `applyGenChunk` 加 `started` 分支 set `currentGenJobId`——生成开始就拿到 job_id，生成中可取消。取消命中后走既有 `genHandleError("已取消")`（streaming 显示「—— 已取消」+ 删空轮 + generating 停）。
- 教训：同步 invoke 模型下「命令返回值」要到完成才到前端；生成中需要的信息（job_id）必须用**事件**尽早下发，不能只靠返回值。完整异步化（命令立即返回 + 后台 spawn）留后续，本坑用 started 事件最小修复。
- 相关文件：[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（emit started）、[store.ts](apps/desktop/src/store.ts)（applyGenChunk started 分支 + currentGenJobId）、[types.ts](apps/desktop/src/lib/types.ts)（CodexChunk started 变体）。
- **演进（2026-08-06 Task 3+6）**：上述「started 事件 set currentGenJobId」是同步模型下的最小修复。Task 3+6 改用「前端 `crypto.randomUUID()` 生成 jobId」——创建 `GenJob` 时即知 id（不依赖命令返回值或事件），`currentGenJobId` 单字段整个删除（多 job 改 `genJobs: Record` + 按 `c.job_id` 路由），`applyGenChunk` 的 started 分支改 noop。从根上消除了该时机问题，started 事件保留但前端不再消费。

### 续轮复用 job_id 致 task_queue 主键冲突 → upsert（2026-08-06）
- 现象：Task 3 多 job 重构后，续轮（`sendGenRevise` resume 同一 codex session）传同一 job_id 给 `codex_create_image`，后端 `enqueue_gen_job`（INSERT）报主键冲突。
- 根因：spec 的 `GenJob` 模型是「1 job = 1 会话 = 多 turn」（续轮是 job 内新 turn，复用 job_id）；而 `task_queue` 每次 CLI 调用 INSERT 一行（主键 = job_id）。前端 GenJob（会话级）与 task_queue 行（调用级）若硬共用同一 id，续轮同 id 再 INSERT 必撞 UNIQUE。
- 解决：[task_queue.rs](apps/desktop/src-tauri/src/core/task_queue.rs) 加 `upsert_gen_job`（`INSERT ... ON CONFLICT(id) DO UPDATE`：刷新 payload/status/started_at/provider，清 error/finished_at），[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) 改用 upsert。续轮 = 会话级 job 重新 active，task_queue 行随会话级 job_id 复用、刷新回 running（语义自洽）。
- 教训：前端「会话级 id」复用到后端持久层时，要把「每次 INSERT 新行」改「upsert 同一行」，否则续轮/重试同 id 必撞主键。
- 相关文件：[task_queue.rs](apps/desktop/src-tauri/src/core/task_queue.rs)（`upsert_gen_job`）、[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)。

### submit_id 持久化时机：同步模型下不能等命令返回（2026-08-06）
- 现象：Task 5 启动恢复需要 submit_id 续查，但 submit_id 在 jimeng provider `generate_image` 内部拿到，command 层只有整个 `generate_image` 返回（含下载完成）才拿到 outcome —— 若 app 在下载完成前被杀，submit_id 只活在内存没落库，恢复无 submit_id 可用。
- 根因：同步 invoke 模型下，命令返回值（含 outcome.submit_id）要到生成完全结束才到；但恢复需要的信息（submit_id）在生成中途（submit 后、下载前）就已产生。等返回值落库 = 下载中崩溃则丢 submit_id。
- 解决：provider 拿到 submit_id 瞬间经 mpsc `Chunk::Submit` 回传，command 的 chunk 转发 task（唯一 rx 消费者，与主 future 并发跑）收到后立即 `try_state::<Arc<Database>>()` + upsert GenJob.submit_id + status=querying。即「事件回填」替代「返回值回填」—— 与 de60544 的 started 事件同模式（生成中需要的信息用事件尽早下发，不等返回值）。
- 教训：同步模型下，生成中途产生、恢复所需的状态（submit_id 等）必须经事件尽早持久化，不能只靠命令返回值；返回值要到完成才到，窗口期崩溃就丢。
- 相关文件：[types.rs](apps/desktop/src-tauri/src/codex/types.rs)（`Chunk::Submit`）、[jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs)（tx.send Submit）、[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（转发 task 持久化）。

### query_result 对 querying 任务行为未知 → bounded poll loop（2026-08-06）
- 现象：Task 5 启动恢复要对未完成即梦 job（submit_id 在、远端仍 querying）调 dreamina `query_result` 续查下载，但 spike 未实证 query_result 对 querying（未 success）任务的行为（阻塞等待？一次性空返？报错码？）—— spike §2.4「未取得 success 样例」。
- 根因：正常路径 `generate_image` 用 submit `--poll 120` 等到 success 才调 query_result（此时必 success）；恢复路径只有 submit_id、无 submit --poll 阶段，query_result 撞 querying 任务行为未知。
- 解决：`poll_query_and_download` 用**策略 B** bounded poll loop（30 次 × 10s，每次新临时目录）：向下兼容——若 query_result 实际阻塞等待，首次调用就在 timeout 内拿到结果、循环早退；若一次性空返/报错，循环重试。致命错（submit_id 无效/fail）早退，querying 类继续轮询到上限。真机验证 query_result 实际行为后可微调错误分类。
- 教训：对接未实证的 CLI 行为时，用「向下兼容的轮询循环」对冲两种可能（阻塞 vs 一次性），比单假设稳；致命错与临时错要分类（前者早退、后者重试）。
- 相关文件：[generation_worker.rs](apps/desktop/src-tauri/src/core/generation_worker.rs)（`poll_query_and_download`）。

### dev 模式 spawn cmd 不开新窗口：Bowerbird 是 console 子系统（2026-08-07）
- 现象：`open_dreamina_login` 点击「打开终端登录」后报「✓ 终端已打开」，但没弹出独立终端窗口——oauth 输出流进 `npm run tauri dev` 的终端，且本地无登录态。
- 根因：Tauri 项目的 `windows_subsystem` 只在 release 生效——**dev 模式下 Bowerbird 是 console 子系统**，attach 到 `npm run tauri dev` 的终端。spawn `cmd.exe /K` 时 cmd 默认**继承父进程 console**（不开新窗口），dreamina login 输出流进 dev 终端、且无独立交互环境。release 包因 `windows_subsystem=windows` 是无 console 的 GUI，spawn cmd 会自动开新窗口，故只有 dev 踩到。
- 解决：给 cmd 加 `creation_flags(0x00000010)`（`CREATE_NEW_CONSOLE`）强制开独立终端窗口，dev/release 行为一致。
- 教训：dev 与 release 的 console 子系统差异会导致「spawn 子进程是否开新窗」行为分叉；需要独立窗口的子进程显式 `CREATE_NEW_CONSOLE`。
- 相关文件：[commands/jimeng.rs](apps/desktop/src-tauri/src/commands/jimeng.rs)（`open_dreamina_login`）。

### dreamina login --headless 输出稳定 → 方案 B 转正（2026-08-07）
- 背景：方案 A「打开终端」曾因 dev console 继承（见上条）+ 终端操作对小白不友好（OAuth 链接要手动 Ctrl+点），用户要求「点一下自动打开浏览器一步化」。
- spike 实测：`dreamina login --headless` 打印后即退出（不依赖 TTY），输出稳定可解析——`verification_uri:` / `user_code:` / `device_code:` / `poll_interval:` / `expires_at:`（一行一个 key: value）。**已有本地登录态时仅输出「已复用当前本地 OAuth 登录态。」**（前端应先 recheck 判定，或命令里识别该文案）。这正是 2026-07-25「方案 A 决策」里搁置的方案 B 所需输出，实测证明可行。
- 落地：`dreamina_login_headless` 命令解析返回 device flow → 前端自动 `open(verification_uri)` 开浏览器 + 展示 user_code → 复用 `dreamina_check_login`（device_code）补完写 token。翻篇方案 A。
- 教训：当年因「未实测 headless 输出格式 / checklogin 写 token」搁置的方案 B，实测后完全可行——CLI 的 headless 路径通常就是为无人值守设计的，值得优先 spike 而非直接否定。
- 相关文件：[commands/jimeng.rs](apps/desktop/src-tauri/src/commands/jimeng.rs)（`dreamina_login_headless`）、[DreaminaOnboarding.tsx](apps/desktop/src/components/DreaminaOnboarding.tsx)。

### 火山方舟真实契约两个 400（2026-08-10）
- 现象：真实方舟联调时两路各踩一个 400——① Seedream 出图带 `sequential_image_generation` 参数报「not supported by the current model」；② Vision 理解发 1×1 测试像素报「Image dimensions too small (min 14px)」。
- 根因：① 方舟 `/images/generations` 的 Seedream 模型（`doubao-seedream-5-0-pro-260628`）**不支持** `sequential_image_generation` 字段（与部分文档/其他型号不符），多图只能靠 prompt 驱动或多次调用；② Vision `/chat/completions` 对 `image_url` 有最小边长约束（≥14px），1×1 占位图被直接拒。
- 解决 / 绕过：adapter 请求体移除 `sequential_image_generation`；契约测试改用程序合成的 32×32 PNG（而非 1×1，也避免上传仓库素材到外部 API）。两路随后 `VISION_OK` / `IMAGE_OK`（98 KB）。
- 相关文件：[apps/cloud/supabase/functions/_shared/ark.ts](apps/cloud/supabase/functions/_shared/ark.ts)。

### 方舟内容安全拒绝被通用 422 / 传输误报掩盖（2026-08-14）
- 现象：Cloud 参考图生成高概率提示“内容未通过模型校验或请求参数无效”；上线错误细分后，一次长请求又显示“无法连接方舟服务”。桌面控制台没有业务错误，容易把问题误判为 Seedream 参数变化、WebP 不兼容或 Supabase 网络异常。
- 根因：最终用户对照提示词实测确认，主要失败来自文本触发方舟内容安全规则，移除相关措辞即可生成。与此同时，旧 adapter 把所有方舟 `400/422` 折叠成同一句提示，无法区分安全审核、图片和参数；另一次请求在 135.45 秒被运行时取消，异常类型未被识别为超时，才误显示为连接失败。WebP 直传虽不是最终主因，但不在当前方舟参考图保守兼容范围内，仍属独立风险。
- 解决：桌面按图片真实内容解码，参考图仅在请求内存中缩放、铺白并转 JPEG；Edge 校验 JPEG/PNG 魔数、单图 10 MB 与总请求大小。adapter 安全解析上游错误码/request id，区分提示词/参考图/生成结果安全审核、图片格式、参数、限流、超时及 DNS/TLS/连接重置，绝不回传上游原始正文；`AbortError`/`TimeoutError` 与接近 deadline 的取消统一映射为超时。生产超时收紧为 120 秒，`generate-proxy` / `understand-proxy` 已上线 `ACTIVE v8`。
- 教训：**同一个 HTTP 422 既可能是内容安全，也可能是输入图片或参数；不能用一条通用文案代替上游错误分类。** 排障时以安全过滤后的 provider code/request id 和 Edge elapsed time 为准，先用最小提示词/无参考图做变量隔离，不记录或上传用户提示词正文到日志。
- 相关文件：[ark.ts](apps/cloud/supabase/functions/_shared/ark.ts)、[limits.ts](apps/cloud/supabase/functions/_shared/limits.ts)、[cloud_image.rs](apps/desktop/src-tauri/src/codex/cloud_image.rs)。

### Supabase 新 key 体系（publishable/secret 取代 anon/service_role，2026-08-10）
- 现象：Supabase 控制台的 API Keys 页不再直接给旧 `anon`/`service_role`，而是 `publishable`（`sb_publishable_…`）/ `secret`（`sb_secret_…`）。
- 根因：Supabase 2025 起推新 API key 体系（见 GitHub discussion 29260），旧 key 沿用至 2026 年底；新 key 经 Project Settings → API Keys 签发，Functions 侧可读 `SUPABASE_PUBLISHABLE_KEYS`/`SUPABASE_SECRET_KEYS` JSON 或直连 `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY`。
- 解决：全仓命名迁移到 publishable/secret，并保留旧名回退（`_shared/auth.ts` `namedKey()` 三级解析；桌面 `cloud_supabase_publishable_key` 带 `#[serde(alias="cloud_supabase_anon_key")]`）。**职责不变**：publishable=客户端公开（桌面/官网持有），secret=服务端机密（只在 Edge Functions，等价旧 service_role，**永不下发桌面端**）。
- 相关文件：[apps/cloud/supabase/functions/_shared/auth.ts](apps/cloud/supabase/functions/_shared/auth.ts)、[core/settings.rs](apps/desktop/src-tauri/src/core/settings.rs)、[cloud/config.rs](apps/desktop/src-tauri/src/cloud/config.rs)。

### Supabase 部署迁移的三处 PostgreSQL 陷阱（2026-08-10）
- 现象：① `0007` 在云端因 `CREATE TRIGGER/POLICY IF NOT EXISTS` 语法失败；② 修正后注册用户仍失败，且计费表 RLS 不可读；③ 注册修复后 `credit_hold` 报 `record "lot" is not assigned yet`。
- 根因：① PostgreSQL 不支持这两类对象的 `CREATE ... IF NOT EXISTS`；② `0007` 覆盖注册初始化函数时漏写 `billing_accounts`，并把通过账户映射的 RLS 错写成直接比较 Auth uid；③ PL/pgSQL 的 `lot record` 变量与 SQL 表别名 `lot` 同名，变量遮蔽别名。
- 解决：`0007` 改为 `DROP ... IF EXISTS` 后重建；`0008_repair_auth_initialization.sql` 恢复账户初始化、授权与映射 RLS；`0009_repair_credit_hold_shadowing.sql` 把循环 record 改名为 `credit_lot`。三项均已推送，真实注册与预授权闭环通过。

### Supabase Edge 默认区域导致方舟出图超时（2026-08-10）
- 现象：默认区域真实出图在 120 秒后返回 `504 upstream_timeout`；无鉴权探测显示 Edge 实际落在新加坡 `ap-southeast-1`。
- 解决：正式桌面/官网与 E2E URL 增加 `forceFunctionRegion=ap-northeast-1`，方舟上游超时调为 140 秒、调用端调为 145 秒。东京重试 76.3 秒成功，返回 111,058 字节图片并正确扣除 5 积分。
- 相关文件：[cloud/config.rs](apps/desktop/src-tauri/src/cloud/config.rs)、[cloud/client.rs](apps/desktop/src-tauri/src/cloud/client.rs)、[website/server.mjs](website/server.mjs)、[test-cloud-e2e.mjs](apps/cloud/scripts/test-cloud-e2e.mjs)。

### Magic Link 回退到 localhost:3000（2026-08-10）
- 现象：桌面端能收到 Magic Link，但验证后地址变成 `http://localhost:3000/?code=…`，浏览器无法访问，Bowerbird 也收不到 deep link。
- 根因：桌面 PKCE 请求的真实回调是 `bowerbird://auth/callback?state=<动态值>`；托管项目 Redirect URLs 未匹配这个完整 URL时，Supabase 会回退到 Site URL，而新项目默认 Site URL 是 `http://localhost:3000`。
- 解决：本地 `config.toml` 与部署文档改用范围受限的 `bowerbird://auth/callback**`，并要求在 Dashboard → Authentication → URL Configuration 同步；邮件模板保持 `{{ .ConfirmationURL }}`。Windows debug 版补 `app.deep_link().register_all()`，让 `tauri dev` 也注册协议（安装版仍由安装过程注册）。旧 Magic Link 已消耗，配置完成后必须重新发送。
- 联调续发注意：Supabase Auth 有三层独立限制——同一邮箱默认 60 秒内不可重发、`/auth/v1/otp` 默认 30 次/小时，以及**内置 SMTP 整个项目仅 2 封/小时**；取最先命中的限制。连续收到两封后即使等待超过 60 秒，第三封仍会 429，需等小时额度恢复或配置自定义 SMTP。桌面端现解析 `Retry-After`/Auth JSON；无明确秒数时直接提示内置邮件服务 2 封/小时，不再误报只需等 60 秒。

### Cloud 熔断配置存在但未接执行路径（2026-08-10）
- 现象：部署文档与 Secrets 已有 `DAILY_COST_LIMIT_CNY` / `RATE_LIMIT_PER_USER_PER_MIN`，错误契约也定义 429/503，但 `generate-proxy` / `understand-proxy` 实际没有读取或调用这些配置；同一幂等键虽不重复扣积分，却可能重复提交上游，成本熔断形同虚设。
- 根因：P2 初版只完成请求体/超时边界，预留了用量表与配置名，却没有把“上游调用认领、单用户速率、全站成本”放进一个原子数据库事务；同时 `service` 直接信任客户端，使成本估算也可被低价服务名污染。
- 解决：`0010_managed_usage_guard.sql` 用 `credit_holds.reserved_cost_micros` 原子认领同一 hold，并在同一 RPC 内更新 `usage_minute` / `system_usage_daily`；任一限额失败整笔回滚。Edge 在 hold 后、上游前调用守卫，成本按服务端预扣积分 × `COST_CNY_PER_CREDIT` 计算，service 按媒体白名单校验。东京真实 E2E 验证 5 分预留 235,000 微元、幂等重放不再进上游、分钟限流和日熔断均返回稳定 detail。
- 教训：**配置项、表结构和错误码存在，不等于安全控制已生效**；发布审计必须从 Function 入口追到原子写路径，并用真实请求验证拒绝分支。
- 相关文件：[0010_managed_usage_guard.sql](apps/cloud/supabase/migrations/0010_managed_usage_guard.sql)、[usage.ts](apps/cloud/supabase/functions/_shared/usage.ts)、[generate-proxy](apps/cloud/supabase/functions/generate-proxy/index.ts)、[understand-proxy](apps/cloud/supabase/functions/understand-proxy/index.ts)。

### 每日积分快照跨日后仍显示旧余额（2026-08-11）
- 现象：Free 账号应用和 `user_credits` 都显示 25 分、当天反推次数为 0，但 Cloud 反推在 `credit_hold` 阶段返回 402“积分不足”。
- 根因：25 分所在的 daily lot 已在上海零点过期；`user_credits` 只是 RPC 维护的读取快照，不会随时间自动清零。原实现只有注册 trigger 发首日 30 分，虽存在 `grant_daily_credits`，却没有 cron 或请求路径调用它，导致第二天既不刷新旧快照，也不发当天额度。
- 解决：`0011_ensure_daily_credits.sql` 新增 service-only 幂等 RPC，`entitlement` / `generate-proxy` / `understand-proxy` 在读余额或预授权前调用；按 `daily:<Asia/Shanghai date>` 唯一键发放，重复请求不叠加。迁移与三个 Function 已上线。
- 教训：**到期规则存在于账本查询，不代表余额快照会自行变化；周期额度必须有明确的定时或请求时触发路径，并同时测试跨日读取与直接扣费入口。**

### 方舟 Vision 突发保护返回 429（2026-08-11）
- 现象：积分补发后反推仍失败，桌面 Console 显示“方舟请求繁忙，请稍后重试”。
- 根因：方舟原始响应为 `429 RequestBurstTooFast`（系统突发流量保护）；用合成图直连同一模型可复现，排除用户图片、Free 10 次额度与 Supabase 节点。间隔后有效 32×32 合成图返回 200，确认是瞬时上游保护。
- 当前处理：`understand-proxy` 会回滚 1 分 hold 并撤销本次 Free 反推计数；远端核对失败记录为 `rolled_back`、次数回到 0。服务恢复后用户重试成功，hold `confirmed`、实际扣 1 分、余额 29、次数 1。
- 后续优化：只针对 `RequestBurstTooFast` 做少量随机退避重试，避免重试风暴；同时把 store 目前只写 Console 的反推错误正式显示到 UI。

### 桌面 access JWT 陈旧导致 Cloud Function 网关 401（2026-08-11）
- 现象：同一 Free 账号曾成功反推，稍后再次反推却返回“云理解失败（HTTP 401）”；远端计费表没有对应 hold，说明请求未进入 `understand-proxy` 业务逻辑。
- 根因：桌面只按本地推算的 `expires_in` 判断 token，并由各调用点直接拼 Bearer；缺少 JWT `exp` 校验、并发刷新协调及 401 后强制刷新重放。长时间运行或边界时序下可能继续发送陈旧 access token，Supabase Functions 网关直接拒绝。
- 解决：认证请求收口到 `AuthClient::send_authorized`：JWT `exp` + 60 秒提前刷新、singleflight 刷新锁、首次 401 强制刷新并只重试一次、并发失败复用新 token，同时固定发送 `apikey` + Bearer。Cloud 反推、生成、轮询、权益同步均已迁移；第二次仍 401 时明确提示重新登录，避免无限重试。

### 复用编辑框素材名后缀是 chip 外纯文本（ext=null 致解析漏吃）（2026-08-13）
- 现象：右键复用生成提示词后，编辑框素材 chip 名后仍有 `.webp`/`.jpg`；多轮改 chipName/toDOM display 剥 chip 内后缀均无效。
- 根因：F12 查 chip 外 HTML 发现后缀是 chip **外面**的纯文本节点，不在 chip 内 display。序列化输出 `@name.ext`，但即梦生成图等 `asset.ext=null`，`buildAssetByName` 只在 ext 有值时才注册 `name.ext` 键 → 解析 `@name.ext` 只匹配 `name`，`.ext` 漏成纯文本残留 chip 后。前几轮误判为 chip 内后缀，方向错。
- 解决：[parse.ts](apps/desktop/src/components/creation/parse.ts) `parsePromptToInline` 匹配 `@name` 后，若 matched 本身不以图片后缀结尾，吃掉紧跟的 `.ext`。chipName/toDOM/CreationGraph 仍剥 chip 内显示名后缀（兜底 name 字段本身含后缀）。
- 相关文件：[creation/parse.ts](apps/desktop/src/components/creation/parse.ts)、[creation/schema.ts](apps/desktop/src/components/creation/schema.ts)、[creation/CreationGraph.tsx](apps/desktop/src/components/creation/CreationGraph.tsx)。

### ProseMirror schema 改动 HMR 不重建 EditorView（2026-08-13）
- 现象：改 schema.ts 的 image node toDOM（剥后缀）后，dev server 热更新不生效，chip 一直用旧 toDOM。
- 根因：EditorView 在创作板挂载时（[useCreationEditor.ts](apps/desktop/src/components/creation/useCreationEditor.ts) `useEffect([])`）创建一次，捕获挂载那一刻的 `creationSchema`。schema.ts 是模块非组件，Vite HMR 重载模块不触发 React Fast Refresh remount → EditorView 不重建，旧 schema 的 toDOM 仍在跑。
- 解决：改 toDOM/node spec 后需**硬刷新页面或重启 dev server** 让 EditorView 重建。parse.ts 等纯函数模块改动经 ES module live binding，HMR 能生效（不需重启）。
- 相关文件：[creation/useCreationEditor.ts](apps/desktop/src/components/creation/useCreationEditor.ts)、[creation/schema.ts](apps/desktop/src/components/creation/schema.ts)。

### 右键菜单 z-60 高于 ConfirmDialog z-50 致物理删除点不到（2026-08-13）
- 现象：右键「物理删除」后菜单不消失，确认弹窗在菜单之下点不到「确认」。
- 根因：菜单 createPortal 到 body 且 z-index:60，ConfirmDialog（约定 13 全屏 Modal z-50）渲染在菜单 portal **内部**，被菜单盖住；物理删除按钮原只 setPendingDelete 没关菜单。
- 解决：套用「重命名」既有模式——点物理删除 `setPendingDeleteId(assetId) + closeContextMenu()`（收菜单 + 记 id），ConfirmDialog 从菜单 portal 内移到 `if (!menu)` 分支独立挂载；`runDelete(id, mode)` 接收 assetId；reset useEffect 不重置 pendingDeleteId（跨菜单关闭存活）。同一模式适用任何「右键菜单内弹 Modal」场景。
- 相关文件：[AssetContextMenu.tsx](apps/desktop/src/components/AssetContextMenu.tsx)。

### 隔离 dev 实测：vite 端口残留 / bowerbird-desktop.exe 锁 target（2026-08-13）
- 现象：临时 identifier 隔离 dev（`pnpm tauri dev --config '{"identifier":"com.bowerbird.desktop.iso"}'`）启动失败——「Port 1420 is already in use」（vite）或「failed to remove bowerbird-desktop.exe 拒绝访问 os error 5」（cargo 无法覆盖 exe）。
- 根因：前一次 dev 的 node（vite，占 1420）+ bowerbird-desktop.exe（跑着锁 target exe）没杀干净；TaskStop 只停 pnpm 顶层，子进程残留。
- 解决 / 绕过：先 `powershell Get-NetTCPConnection -LocalPort 1420 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` + `Stop-Process -Name bowerbird-desktop`，确认端口 free + 进程 0 后再重启 dev。
- 相关：隔离实测用临时 identifier（`com.bowerbird.desktop.iso`），app data 在 `%APPDATA%/com.bowerbird.desktop.iso/`，不动正式库；`release_preset_pack` 复制到真实 `Documents/Bowerbird/初始引导/`（首启产物，正式首启也会建同一目录）。

### understand-proxy 分发漏认 action:"create"：E2E 与桌面请求形状不一致的测试盲区（2026-08-18）
- 现象：`UNDERSTAND_ASYNC` 翻 true 后桌面反推报「cloud: 未知 action」，且 VPS Worker 无任何日志。
- 根因：桌面 `CloudUnderstandProvider` 建任务显式发 `action:"create"`，而 understand-proxy 的分发只把「不带 action」当建任务，`"create"` 落进未知 action 分支被 400 拒绝；请求在 Edge 就被拒、任务从未入队，Worker 自然无日志。上线前 E2E 全绿没暴露，是因为脚本建任务恰好没带 action 字段，走的是另一条路径。
- 解决：分发显式接受 `action === "create"`（无 action 的旧式建任务仍兼容）；**E2E 脚本的请求形状必须与桌面端逐字段一致**（createJob 已改为带 action:"create"），并以 guard 场景在真实链路回归。
- 相关文件：[understand-proxy/index.ts](apps/cloud/supabase/functions/understand-proxy/index.ts)、[test-understand-e2e.mjs](apps/cloud/scripts/test-understand-e2e.mjs)。
