# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 文档索引

开工前先读对应文档，避免重复推导。

| 文档 | 内容 | 何时读 |
|---|---|---|
| `dev-doc/VIDEO-API-PROVENANCE.json` | 视频增量原始快照/补丁哈希、冲突处理与最终文件哈希 | 审查或合入视频 API 隔离工作树时 |
| `dev-doc/VIDEO-API-INTEGRATION.md` | 国内方舟视频 Cloud 实现、恢复/结算、离线验收与 CLI 前置归因 | 接续视频 API 接入、核验 2.5 模型与异步任务/计费边界时必读 |
| `dev-doc/VIDEO-API-INTEGRATION-PREP-V2.md` | 视频历史集成演练及下一次实测操作准备 | 追溯 v2 或安排鉴权实测之前 |
| `dev-doc/VIDEO-API-INTEGRATION-V2.json` | 已废止的 v2 快照归因；由 v3 manifest 接续 | 仅追溯历史，不再用于应用补丁 |
| `dev-doc/VIDEO-API-INTEGRATION-V3.md`、`dev-doc/VIDEO-API-INTEGRATION-V3.json` | 视频与 FFmpeg 主目录集成、0058 迁移归属、回滚及阶段哈希 | 接续视频集成或安排 GUI 验收之前 |
| `dev-doc/LOCAL-CLASSIFICATION.md` | 本地动态分类模型包、标签发现/自定义匹配、人工保护与验证记录 | 本地分类、自动标签、分类模型下载与运行时相关工作前必读 |
| `dev-doc/EMBEDDED-BROWSER.md` | 探索内置浏览器、登录资料持久化、网页拖图入库与隔离 WebView2 验证 | 内置浏览器、探索工作区、网页拖图与登录状态相关工作前必读 |
| `PROJECT.md` | **活文档（项目内容唯一权威）**：项目说明 / 目前进展 / 关键约定 / 踩坑记录 | 每次开工前先读「目前进展」与「关键约定」 |
| `dev-doc/Bowerbird开发计划.md` | 完整开发计划 v1.3（定位 / 技术栈 / 数据模型 / Roadmap / 风险）；同名 HTML 是其渲染版 | 任何实现工作之前必读；作为基础设计源，若与 `PROJECT.md` 的较新决策或专项计划冲突，以后两者为准 |
| `dev-doc/Bowerbird定价方案v2-订阅积分制.md` | 商业模式与定价（免费+订阅+积分混合制 / 四档结构 / 积分消耗表 / 毛利测算；已取代 PRICING.md v1 买断制） | 商业化、定价、积分、功能门控相关工作前必读 |
| `dev-doc/ARCH-ADJUST-PLAN.md` | 收费化架构调整开发计划（账号 / 积分 / 托管 provider / 支付 / 门控，P0–P9 阶段任务卡 + 验收标准；agent 执行用） | 收费化 / 账号 / 积分 / 云端任何实现工作前必读 |
| `dev-doc/ARCH-ADJUST-PROGRESS.md` | 收费化架构调整跨会话进度、部署状态、测试基线与剩余阻塞 | 接续收费化任务或核对线上状态时必读 |
| `dev-doc/AGENT-RUNTIME-PLAN.md` | Bowerbird 内置 Skill Agent Runtime 开发计划（Agent Kernel / 有限澄清 / 独立视觉规范 / VPS Worker / Supabase / 方舟，A0–A8 + V0–V4） | Agent loop / 内置 Skill / 独立视觉规范 / VPS Worker / Agent 临时云工作区实现前必读 |
| `apps/agent-worker/src/prompts/brand-visual/README.md` | 品牌图片观察/文本提炼提示词、VPS 维护目录及标注保留格式 | 修改品牌视觉提示词、色号提取或维护 VPS 提示词文件前必读 |
| `dev-doc/CREATIVE-MEMORY-PLAN.md` | 创作记忆与常用提示词库开发计划（复用记录、候选提炼、用户确认、只读注入，CM0–CM7） | 提示词复用统计、常用库、个人偏好学习、记忆设置或生成偏好注入工作前必读 |
| `dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md` | **通用云端 Agent Harness 新专项**（一个 Agent + 多种受控工具；DSH + DeepSeek API Spike；Tool Gateway；HTML/小红书复用边界，U0–U6） | 新 Agent 能力、DSH/ACP、通用 Tool Gateway、HTML 智能编排、小红书或任何可能新增 Agent Runner 的工作前必读 |
| `dev-doc/HTML-RENDER-PLAN.md` | 受限 HTML 离线排版、整页/切片截图、独立 renderer 容器与内置 Skill 接入开发计划（H0–H6） | HTML 排版/截图、Chromium/Playwright renderer、`render_html` 工具或第二个官方 Skill 实现前必读 |
| `dev-doc/PROJECT-CANVAS-PLAN.md` | **项目即画板当前专项**（一项目一块无限画板 / 项目内多创作线程 / 普通生成与 Agent Run 归属 / 历史合并，PB0–PB7） | 画板、项目、创作入口、生成时间线、版本分支、历史迁移或相关 SQLite 模型实现前必读；当前执行权威 |
| `dev-doc/CANVAS-SESSION-PLAN.md` | 已被替代的“一画板一会话”CS0–CS7 实施、测试与旧迁移演练记录 | 仅在追溯旧 `creative_session` 实现和对账证据时阅读；不得作为当前产品契约 |
| `dev-doc/进展归档.md` | PROJECT.md「目前进展」历史里程碑全量归档（append-only 只进不改；PROJECT.md 只留最近 3 条） | 追溯旧里程碑 / 查历史实现细节时 |
| `dev-doc/FRAMEWORK_ADJUST.md` | 为收费的架构调整清单（7 项，ARCH-ADJUST-PLAN.md 的依据） | 收费化架构溯源时 |
| `dev-doc/研究报告-服务器化CLI与API化改造可行性.md` | 服务器套壳 CLI vs 官方 API 可行性结论（推荐火山方舟官方 API） | 托管算力 / 远程化方向决策前必读 |
| `dev-doc/AI-PROVIDERS.md` | AI provider 可切换方案（泛化 GenerationPanel + codex/即梦首批 + 即梦接入调研 + 关键约定 1 演进；草案） | provider 切换 / 即梦接入 / 生成能力多 provider 解耦相关工作前必读 |
| `dev-doc/SEEDANCE-2.5-INTEGRATION.md` | 即梦 Seedance 2.5 视频接入、官方 CLI 四模式契约与验收证据；历史规划见 `dev-doc/VIDEO-GENERATION.md` | 视频生成、参数、任务恢复、视频入库与播放相关工作前必读 |
| `dev-doc/Eagle类创意收集工具调查报告.html` | 前序竞品调研，计划的依据 | 需要背景/对标时 |
| `dev-doc/draft.md`、`reference/theory.md` | 早期 UX 路径与素材分类（A–F 类）草稿，部分已被计划取代 | 仅在追溯原始意图时 |
| `dev-doc/桌面端UI设计.html` | 桌面端 UI 面板与入口设计稿（三区外壳 + 创作板拟文本编辑器 + 现状对照） | 桌面端 UI 工作前必读 |
| `dev-doc/analyse-panel-todo.md` | 详情页「反推」面板待优化清单（P0–P2 分级） | 反推面板 / AssetDetail 相关工作前 |
| `Windows/README.md` | Windows x64 开发、构建 NSIS 安装包与环境要求 | Windows 运行 / 打包前 |
| `Windows/Windows-edited.md` | Windows 适配修改清单、交付产物与升级注意事项 | 维护 Windows override / 排查平台差异时 |

## 文档维护规则

> **单一权威源**：项目内容（说明 / 进展 / 约定 / 踩坑）只落在 `PROJECT.md`。本文件除「文档索引」表外不存放任何项目内容；项目内容变更一律改 `PROJECT.md`，不要写入本文件。

> 当用户说**存档**时，在同一次存档流程中按下面顺序完成

### 1. 更新 `PROJECT.md`（不更新即信息遗漏）

- **关键约定/决策变化**（技术栈、范围、优先级、架构、是否做某模块）→ 改 `# 关键约定`。
- **阶段或里程碑变化**（开工、进入新 Phase、完成里程碑、发布版本、关键 spike 出结论）→ 改 `# 目前进展`：新条目插「近期里程碑」顶部，**只保留最近 3 条**；被挤出前 3 的旧条目整条移入 `dev-doc/进展归档.md`「归档条目」区顶部（原样搬运，不改文字、不删内容）。
- **踩坑并已定位根因/绕过方案** → 写入 `# 踩坑记录`。
- **项目定位/说明变化** → 改 `# 项目说明`。

### 2. 在本文档更新索引（若有）

- 新增或删除重要文档 / 板块 → 加行或删行。
- 文档改名、移动，或其「何时读」定位变化 → 改对应行。

### 3. 复核并提交

- 先检查与本次任务相关的测试结果和最终 diff，确认没有夹带无关修改。
- 将代码与上述文档更新放进同一个 `git commit`，避免先提交代码、再把文档留在工作区。

---

## Working principles

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

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
