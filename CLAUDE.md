# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 文档索引

开工前先读对应文档，避免重复推导。

| 文档 | 内容 | 何时读 |
|---|---|---|
| `PROJECT.md` | **活文档（项目内容唯一权威）**：项目说明 / 目前进展 / 关键约定 / 踩坑记录 | 每次开工前先读「目前进展」与「关键约定」 |
| `Bowerbird开发计划.md` | 完整开发计划 v1.3（定位 / 技术栈 / 数据模型 / Roadmap / 风险）；同名 HTML 是其渲染版 | 任何实现工作之前必读，技术权威源 |
| `PRICING.md` | 商业模式与定价策略（架构张力 / 竞品定价实测 / 免费·付费功能切法 / 价位卡位） | 商业化、定价、license 功能门控相关工作前必读 |
| `AI-PROVIDERS.md` | AI provider 可切换方案（泛化 GenerationPanel + codex/即梦首批 + 即梦接入调研 + 关键约定 1 演进；草案） | provider 切换 / 即梦接入 / 生成能力多 provider 解耦相关工作前必读 |
| `VIDEO-GENERATION.md` | 生成系统总规划（并行生成前置 + 视频生成 / dreamina 视频 CLI 真机 spike 实证 / 多 job 模型 + 即梦并发=1 队列 + submit_id 持久化恢复 / 协议泛化 image→media / 创作板视频模式 / 分阶段 Roadmap；草案） | 生成系统（并行 / 视频）相关工作前必读 |
| `Eagle类创意收集工具调查报告.html` | 前序竞品调研，计划的依据 | 需要背景/对标时 |
| `draft.md`、`reference/theory.md` | 早期 UX 路径与素材分类（A–F 类）草稿，部分已被计划取代 | 仅在追溯原始意图时 |
| `桌面端UI设计.html` | 桌面端 UI 面板与入口设计稿（三区外壳 + 创作板拟文本编辑器 + 现状对照） | 桌面端 UI 工作前必读 |
| `analyse-panel-todo.md` | 详情页「反推」面板待优化清单（P0–P2 分级） | 反推面板 / AssetDetail 相关工作前 |
| `Windows/README.md` | Windows x64 开发、构建 NSIS 安装包与环境要求 | Windows 运行 / 打包前 |
| `Windows/Windows-edited.md` | Windows 适配修改清单、交付产物与升级注意事项 | 维护 Windows override / 排查平台差异时 |

## 文档维护规则

> **单一权威源**：项目内容（说明 / 进展 / 约定 / 踩坑）只落在 `PROJECT.md`。本文件除「文档索引」表外不存放任何项目内容；项目内容变更一律改 `PROJECT.md`，不要写入本文件。

> 当用户说**存档**时，进行下面步骤

### git commit

### 更新 `PROJECT.md`（不更新即信息遗漏）

- **关键约定/决策变化**（技术栈、范围、优先级、架构、是否做某模块）→ 改 `# 关键约定`。
- **阶段或里程碑变化**（开工、进入新 Phase、完成里程碑、发布版本、关键 spike 出结论）→ 改 `# 目前进展`。
- **踩坑并已定位根因/绕过方案** → 写入 `# 踩坑记录`。
- **项目定位/说明变化** → 改 `# 项目说明`。

### 在本文档更新索引（若有）

- 新增或删除重要文档 / 板块 → 加行或删行。
- 文档改名、移动，或其「何时读」定位变化 → 改对应行。

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
