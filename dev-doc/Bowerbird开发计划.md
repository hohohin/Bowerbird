# Bowerbird 开发计划与架构入口

本页用于选择架构、源码与复用入口。当前项目进度和产品决策见 [PROJECT.md](../PROJECT.md)，按任务阅读见 [AGENTS.md](../AGENTS.md)。

## 产品与范围

Bowerbird 是本地优先的 AI 多类型素材库与创作工作台：收集、浏览、搜索、整理、反推和生成。一个项目对应一块无限画板，内部组织多条创作线程；中央素材、项目成员、画板实例与底层生成任务身份分离。

素材和长期资料以本地为权威。云端承担账号、积分和托管算力，只接收用户授权的任务输入；不上传整库，不共享用户 CLI 订阅。大库与重项目的当前验证边界见 [PROJECT.md](../PROJECT.md#未闭环事项)。

## 技术栈与目录

| 层 | 当前实现 | 入口 |
|---|---|---|
| 桌面 UI | React 18、TypeScript、Vite、Tailwind、Zustand；ProseMirror 创作输入 | [apps/desktop](../apps/desktop/) |
| 本机后端 | Tauri 2、Rust、Tokio；SQLite/rusqlite，FTS5 | [src-tauri](../apps/desktop/src-tauri/) |
| 媒体 | image / fast_image_resize、LAB 提色、64-bit dHash；FFmpeg/ffprobe 统一发现 | [media](../apps/desktop/src-tauri/src/media/) |
| 浏览器采集 | MV3 扩展、axum WebSocket；Windows 内置 WebView2 探索 | [extension](../apps/extension/)、[探索契约](EMBEDDED-BROWSER.md) |
| 云控制面 | Supabase Auth/Postgres/Storage + Edge Functions | [cloud](../apps/cloud/) |
| 云执行 | VPS 常驻消费者，负责生成、理解、对话与异步 Agent Run；DSH/ACP 使用受控工具 | [agent-worker](../apps/agent-worker/) |
| HTML 渲染 | 独立、断网、资源受控的 Chromium renderer | [HTML 契约](HTML-RENDER-PLAN.md) |
| 官网 | 统一 Cloud 代理网关、桌面更新、共享账号权益、兑换码后台 | [website](../website/) |

依赖版本以 package.json、Cargo.toml 与锁文件为准；平台共用 canonical source，不维护整文件 Windows override。构建见 [Windows](../Windows/README.md) 和 [macOS](../macOS/README.md)。

## 复用地图

按“我想实现什么”查入口，再沿分类页的实际调用核实源码。地图是导航，不替代 [UI 规范](UI-DESIGN-SPEC.md)、专项协议或模块边界；没有收录时仍需跨板块检索。

| 我想实现什么 | 分类入口 |
|---|---|
| 使用主题变量、按钮／选择器、弹窗／菜单、滚动容器；统一媒体反馈和创作界面 | [UI、样式与交互](reuse/UI.md) |
| 管理素材与多栏状态、选择／拖动／预览；复用标注、文本、生成草稿和项目恢复逻辑 | [桌面状态、工具与业务逻辑](reuse/DESKTOP.md) |
| 调用本机命令、处理媒体／文件、接入 provider；检查权益、Cloud 请求与 Agent 工具边界 | [接口、本机与云端服务](reuse/SERVICES.md) |
| 检测原件缺失、自动清理失效展示、保留创作身份与恢复原件 | [文件契约](FOLDER-MODE.md#自动检测与清理2026-11-04源码待发布)；[分批检测](../apps/desktop/src-tauri/src/core/missing_originals.rs) 复用 `Database::cleanup_missing_original`，不调用文件回收接口 |
| 复用图片标注与截图的绘制、文字、撤销和平移 | [标注专项](reuse/ANNOTATION.md) |
| 确认哪些板块已查、理解多实现差异、复查三个常见任务的查找路径 | [覆盖范围与核验](reuse/REVIEW.md) |

## 数据与创作身份

- SQLite 实际结构以 [sql 迁移](../apps/desktop/src-tauri/sql/) 为准；升级须保留素材、文件、计费及执行事实，不从文档 SQL 草图重建数据库。
- 中央素材 `assets` 与文件夹位置、收藏夹/项目成员分别管理。同一素材可出现在多个画板实例；移除实例不隐式删除原文件。`library_hidden` 允许仅画板可见，最后实例移除后恢复库内可见性。
- 当前创作数据围绕 caption `sections`、维度稳定 ID、编辑器显式引用及 `generation_meta`。旧 `asset_prompts` CRUD 保留兼容，不作为新功能枢纽。
- 项目是唯一一级工作区；新意图新建线程，续轮/重试/分支沿用原线程。provider session、Cloud job 和 Agent Run 各自负责执行恢复，不冒充画板身份。旧用户可见会话不做 backfill，见 [项目画板契约](PROJECT-CANVAS-PLAN.md)。
- 关键词搜索使用 LIKE，标签和颜色使用关联表，`name / prompt_body / annotation` 继续同步到 FTS5。以文搜图使用独立的本机 SigLIP2 图文模型。`core/semantic_search` 维护素材版本和可恢复索引，借用 `CatalogFilter::sql` 缩小范围后排序。模型、SQLite 0060／0061、Tauri 命令和 UI 入口见[复用地图](reuse/SERVICES.md#以文搜图)。本地分类沿现有模型包，见 [LOCAL-CLASSIFICATION.md](LOCAL-CLASSIFICATION.md)。

## 生成与理解

| 能力 | 当前路线 | 约束 |
|---|---|---|
| 图片生成 | Codex CLI、Dreamina CLI、本机固定 ComfyUI MiniMax-H3-Image、Bowerbird Cloud | `GenProvider` / `resolve_gen_provider`；Cloud 档位来自服务端 `service_costs` |
| 反推/命名 | 本机 Codex 或 Cloud 方舟 Vision | `UnderstandProvider`；即梦不承担理解 |
| 视频 | 本机 ComfyUI H3、Dreamina Seedance 2.5、Cloud 国内方舟 Seedance 2.5 | [H3](COMFYUI-LOCAL-VIDEO.md) · [CLI 四模式](SEEDANCE-2.5-INTEGRATION.md) · [Cloud 恢复与结算](VIDEO-API-INTEGRATION.md) |
| 分层 | Cloud Seedream 5.0 Pro | [透明图层与本地工程](LAYER-EDITING.md) |

后端入口为 [codex/mod.rs](../apps/desktop/src-tauri/src/codex/mod.rs)、[understand.rs](../apps/desktop/src-tauri/src/codex/understand.rs)。UI/provider 默认选择与单次选择须遵守 FeaturePolicy：免费仅 Cloud，本机 CLI 由 Pro/Studio 解锁；不能只靠按钮禁用。

本机 CLI 使用 Bowerbird 独立凭据；Windows 应用内更新保留登录、普通手动重装清登录，具体上线版本与失败恢复边界见 [桌面自动更新](DESKTOP-UPDATES.md)。不得读写系统 CLI 原登录。普通生成持久化到 SQLite 任务队列，按 job 取消；即梦自有订阅图像、视频独立提交，Cloud 按原 job/key 恢复。上游结果未知不自动重发或退款。

## Agent 与对话

| 通路 | 新任务与恢复 | 实现入口 |
|---|---|---|
| 桌面对话及 Agent 卡片 | 共用桌面会话与受控建卡。用户可选本机 Codex CLI、本机 DSH 0.2 或 DSH · Cloud v2。Cloud 试用按账号准入和 0 Bcoin 报价；模型上下文由对应原生会话维护。 | [桌面 provider](CHAT-PROVIDERS.md) · [Cloud API](../apps/cloud/CHAT.md) |
| 云端异步 Agent Run | 新建仅使用 `bowerbird-unified-agent + dsh`，保持 test-only。DSH/ACP 调用 Tool Gateway，控制面持有 Run、审批、租约、计量、产物和结算。图片与 HTML 共用此 Harness。 | [专项契约](UNIFIED-AGENT-HARNESS-PLAN.md) · [Worker](../apps/agent-worker/README.md) · [运行手册](../apps/agent-worker/UNIFIED-HARNESS-RUNBOOK.md) |
| 退役通路 | 旧 `.agent-z/ds-inbox/` 属历史本机投递。旧 `deepseek-cloud`、`dsh-vps-v1` 拒绝新单（426），已受理聊天按原请求恢复。旧 `bowerbird-controlled-image-edit`／`legacy_kernel` 仅恢复原 Run。 | [对话兼容](CHAT-PROVIDERS.md) · [Cloud 协议](../apps/cloud/CHAT.md) · [历史迁移](UNIFIED-AGENT-HARNESS-PLAN.md#历史专项与验收流水) |

Codex 直接生成沿生成 provider，本机 Codex 和 DSH 的技能沿各自宿主。新云端内容能力复用受控工具与按需 Skill；即梦作为正式 Agent 执行器的真机专项维持暂停。

## 当前接续

未完成项只维护在 [PROJECT.md「目前进展」](../PROJECT.md#目前进展)。收费化部署/验收见 [ARCH-ADJUST-PROGRESS.md](ARCH-ADJUST-PROGRESS.md)，操作手册见 [DEPLOY.md](../apps/cloud/DEPLOY.md)。创作记忆仍是 [待实施计划](CREATIVE-MEMORY-PLAN.md)，不得将既有引用计数视为完成学习。
