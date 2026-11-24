# AGENTS.md

## 文档索引

### 开工必读

| 任务 | 入口 |
|---|---|
| 所有任务 | 先读 [PROJECT.md「目前进展」](PROJECT.md#目前进展) 和 [「关键约定」](PROJECT.md#关键约定)。项目状态与产品决策统一在 PROJECT.md。 |
| 设计讨论、新增跨模块概念、重命名界面或领域术语 | 先读 [GLOSSARY.md](GLOSSARY.md) 对齐用词。发现口径冲突时，立即向用户确认。 |
| 实现工作 | 读 [开发计划与架构入口](dev-doc/Bowerbird开发计划.md)。新增功能或界面先查 [复用地图](dev-doc/Bowerbird开发计划.md#复用地图)，再核对源码、导出和调用。 |
| 对话、Agent 或执行器 | 先读 [Agent 与对话架构](dev-doc/Bowerbird开发计划.md#agent-与对话)，再按通路查下表。 |
| 桌面界面设计、修改或审查 | 读 [UI 设计与验收](dev-doc/UI-DESIGN-SPEC.md)。 |
| 云端实现与交付 | 开始和交付前读 [PROJECT.md「关键约定」中的云端修改交付规范](PROJECT.md#bcoin权益与云端边界)，并读 [部署手册](apps/cloud/DEPLOY.md)。 |

### 按领域查阅

| 任务 | 入口 |
|---|---|
| 桌面对话、Agent 卡片、模型选择、原生会话、待答与恢复 | [CHAT-PROVIDERS.md](dev-doc/CHAT-PROVIDERS.md) |
| DSH · Cloud v2、试用准入、用量、报价、付费候选 | [Cloud CHAT.md](apps/cloud/CHAT.md) |
| 异步 Agent Run、DSH/ACP、Tool Gateway、扩围与退役恢复 | [统一 Harness](dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md) · [Worker README](apps/agent-worker/README.md) · [运维与回退](apps/agent-worker/UNIFIED-HARNESS-RUNBOOK.md) |
| Agent Kernel、内置 Skill、独立视觉规范与临时工作区 | [Agent Runtime](dev-doc/AGENT-RUNTIME-PLAN.md) · [品牌提示词维护](apps/agent-worker/src/prompts/brand-visual/README.md) |
| 受限 HTML 排版、离线 renderer、整页和切片 | [HTML Render](dev-doc/HTML-RENDER-PLAN.md) |
| 源码只读分享、本机分支控制台、GPT 隧道、Gemini OAuth、快照脱敏及刷新 | [代码 MCP](apps/code-reader-mcp/README.md) |
| 画板、项目、线程、历史迁移及 SQLite 模型 | [项目画板](dev-doc/PROJECT-CANVAS-PLAN.md) |
| 工作流卡片、端口、发条、循环及运行恢复 | [画板工作流](dev-doc/CANVAS-WORKFLOW.md) |
| 本机目录、连接、分身、随图资料、共享原件与删除 | [文件工作区](dev-doc/FOLDER-MODE.md) |
| 快传、跨应用拖动和原件交付 | [LocalSend](dev-doc/QUICK-TRANSFER.md) · [外部拖动](dev-doc/EXTERNAL-DRAG.md) |
| 本机模型包、Jev 判断、自动分类及补标签 | [分类](dev-doc/LOCAL-CLASSIFICATION.md) |
| 探索、网页登录、网页采集或浏览器扩展配置与打包 | [内置浏览器](dev-doc/EMBEDDED-BROWSER.md) · [扩展](apps/extension/README.md) |
| 入门引导、任务失败提示 | [入门](dev-doc/ONBOARDING.md) · [错误展示](dev-doc/USER-FACING-ERRORS.md) |
| Cloud 路由、签名文件、网络恢复或新 Edge 请求 | [Cloud 传输](dev-doc/CLOUD-TRANSPORT.md) · [Cloud 开发](apps/cloud/README.md) · [Cloud 部署](apps/cloud/DEPLOY.md) |
| 账号、Bcoin、门控、商业化与托管架构 | [收费化计划](dev-doc/ARCH-ADJUST-PLAN.md) · [收费化进度](dev-doc/ARCH-ADJUST-PROGRESS.md) · [定价](dev-doc/Bowerbird定价方案v2-订阅积分制.md) |
| 支付、发码、退款、回调、对账 | [微信支付](apps/cloud/WECHATPAY.md) · [支付宝订阅](apps/cloud/ALIPAY.md) · [Pro 兑换](apps/cloud/PRO-REDEMPTION.md) |
| 托管算力与远程执行选型 | [服务器化可行性研究](dev-doc/研究报告-服务器化CLI与API化改造可行性.md) |
| 视频生成、即梦与方舟参数、恢复及计费 | [方舟视频 Cloud](dev-doc/VIDEO-API-INTEGRATION.md) · [即梦 Seedance 2.5](dev-doc/SEEDANCE-2.5-INTEGRATION.md) · [本机 ComfyUI H3](dev-doc/COMFYUI-LOCAL-VIDEO.md) |
| 视频播放、转录、截帧、复刻与轻剪辑 | [视频素材](dev-doc/VIDEO-MEDIA.md) · [视频复刻](dev-doc/VIDEO-REPLICATION.md) · [独立复刻 Demo](spikes/video-replication-demo/README.md) · [轻剪辑调研](dev-doc/FILMCRAFT-RESEARCH.md) |
| HyperFrames、可续改视频工程与 Studio | [Skill 视频](dev-doc/VIDEO-SKILL.md) |
| 透明图层、音频详情、波形、裁剪与转录、声音克隆或办公文档 | [分层](dev-doc/LAYER-EDITING.md) · [音频](dev-doc/AUDIO-LIBRARY.md) · [声音](dev-doc/VOICE-STUDIO.md) · [文本和办公](dev-doc/TEXT-LIBRARY.md) |
| 提示词复用、常用库、偏好与记忆 | [创作记忆](dev-doc/CREATIVE-MEMORY-PLAN.md) |
| Windows 或 macOS 本地运行、构建、打包和排障 | [Windows](Windows/README.md) · [Windows 平台适配](Windows/Windows-edited.md) · [macOS](macOS/README.md) |
| 双端更新、签名、通道、回滚与正式验收 | [桌面自动更新](dev-doc/DESKTOP-UPDATES.md) · [Mac 发布验收](macOS/RELEASE-READINESS.md) |
| Mac 草稿工程与画笔编辑 | [草稿编辑器](dev-doc/DRAFT-EDITOR.md) · [源码调研](dev-doc/PHOTOSUITE-DRAFT-RESEARCH.md) |

### 历史归档

| 追溯目标 | 入口 |
|---|---|
| 项目变更、复审流水、被替代的约定与验收 | [项目日期日志](project_logs/README.md) · [里程碑归档](dev-doc/进展归档.md) |
| 跨端同步和旧版本交接 | [Windows 历史交接](Windows/) · [Mac 11 月 24 日累计存档](macOS/CROSS-PLATFORM-SYNC-2026-11-24.md) · [macOS 收口至 dev 验证](macOS/DEV-CONVERGENCE-2026-11-24.md) · [Mac 历史交接](macOS/) · [发布证据](dev-doc/DESKTOP-UPDATES.md) |
| 视觉确认稿、早期调研与视频原始增量 | [UI 研究与恢复点](dev-doc/ui-studies/) · [素材分类草稿](reference/theory.md) · [早期桌面稿](dev-doc/桌面端UI设计.html) · [竞品调研](dev-doc/Eagle类创意收集工具调查报告.html) · [视频 provenance](dev-doc/VIDEO-API-PROVENANCE.json) · [历史 0058 集成](dev-doc/VIDEO-API-INTEGRATION-V3.md) · [阶段哈希](dev-doc/VIDEO-API-INTEGRATION-V3.json) |

## 常用验证命令速查

从仓库根执行，依赖与工具版本见各包配置。按变更选择定向用例。

| 范围 | 命令 |
|---|---|
| Desktop TypeScript／Vite | `pnpm --filter @bowerbird/desktop exec tsc --noEmit` · `pnpm --filter @bowerbird/desktop build`（含 Cloud 路由契约） |
| Desktop Rust | `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` · `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`（命令末尾可加用例过滤） |
| Agent Worker | `pnpm --filter @bowerbird/agent-worker typecheck` · `pnpm --filter @bowerbird/agent-worker test`（运行包内 Node 测试） |
| Cloud Edge | `deno check apps/cloud/supabase/functions/chat-proxy/index.ts apps/cloud/supabase/functions/chat-worker/index.ts` · `deno test --allow-env apps/cloud/supabase/functions/_shared/wechatpay_test.ts` |
| Cloud 本地账务夹具 | `node apps/cloud/scripts/chat-db.test.mjs "<PGlite dist/index.js 的本地路径>"`。按专项用独立 PostgreSQL 核验事务、并发与租约。 |
| 只读 MCP | `pnpm --filter @bowerbird/code-reader-mcp test`。PowerShell 启动与浏览器授权用例见 [MCP 验证](apps/code-reader-mcp/README.md#本轮验证与限制)。 |

源码检查、隔离回归、正式构建、实机及线上核验分别报告。涉及真实账号、供应商调用、生产数据或发布时，从对应专项选择验收入口。

## 文档维护

- PROJECT.md 保留现行状态、有效约定、活跃缺口和最近 3 条里程碑。规则变化覆盖更新，在对应历史记录保留原文及替代关系。
- 测试计数、镜像 SHA-256、逐轮复审和临时证据路径进入项目日志或专项的历史区。专项开头先给当前协议和入口。新增、迁移或废弃公共能力时同步维护复用地图。
- [GLOSSARY.md](GLOSSARY.md) 只维护纯领域定义与 `_Avoid:_` 排除词。概念边界敲定或术语更名时立即更新。实现细节、技术规格与过程日志分别维护在专项文档和历史记录。
- 索引维护阅读入口、触发条件和验证命令。项目内容在 PROJECT.md 更新，技术细节沿链接维护。

### 用户要求存档时

1. 更新 PROJECT.md 对应章节。新里程碑插入顶部，仅保留最近 3 条，被挤出的整条原样移入 [进展归档](dev-doc/进展归档.md#归档条目) 顶部。已定位故障写根因、处理和剩余缺口。
2. 新增、删除、改名或移动重要文档时同步索引。
3. 核对本次测试和最终 diff 后，把相关代码和文档放进同一个 Git commit。

用户说【存档并推送】时，先完成上述本地存档和提交，并核对远端 `mac` 上次推送基线；在 `macOS/` 附上自该基线以来的完整更新说明、平台差异和验证结果，再向用户展示本次待推送内容。**必须等用户明确确认后才推送 `mac`，不得把调用该简称本身视作推送确认。** 确认后只推送已展示范围；若出现新改动或远端新增导致范围变化，先说明差异并重新确认。默认不包含打包、安装包上传或服务部署。

## Working principles

### **Tradeoff:**
These guidelines bias toward caution over speed. For trivial tasks, use judgment.
### **User-Friendly**
Avoid unnecessary secondary label and descriptions. Let the layout do the explaining.

### 复用检查

- 用户说“检查复用”时，先检查并直接补齐、修正复用地图；将需要业务开发的细项、范围和验证方式交用户确认，确认后再调用子代理实施修复。

- 涉及新增功能或 UI 时，先查[复用地图](dev-doc/Bowerbird开发计划.md#复用地图)，再核实当前源码、导出入口和实际调用方式。
- 地图未收录不代表仓库不存在；仍须按相关功能词和同义词跨板块检索，不限于 `shared`、`common` 或 `lib` 目录。
- 实现前简要说明相关候选路径、复用决定，以及确需新建的原因。
- 优先使用合适的公共接口，遵守模块和运行时依赖边界；不强行抽象，不直接跨模块导入内部专用实现。
- 修改公共实现后检查现有调用方；新增、迁移或废弃公共能力时同步更新地图。

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
