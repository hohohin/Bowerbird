# Bowerbird 开发计划与架构入口

架构主体按 2026-09-17 源码整理；下方复用地图于 2026-11-03 按当前工作区核验。当前进度与产品决策统一见 [PROJECT.md](../PROJECT.md)，文档索引见 [AGENTS.md](../AGENTS.md)。本页合并早期 provider 方案，删除已完成的 Phase 路线、旧 SQL 草图和失效的单 Codex 假设；历史设计可从 Git 查阅。

## 产品与范围

Bowerbird 是本地优先的 AI 图像素材库与创作工作台：收集、浏览、搜索、整理、反推和生成。一个项目对应一块无限画板，内部组织多条创作线程；中央素材、项目成员、画板实例与底层生成任务身份分离。

素材和长期资料以本地为权威。云端承担账号、积分和托管算力，只接收用户授权的任务输入；不上传整库，不共享用户 CLI 订阅。千图级流畅是当前性能目标。

## 技术栈与目录

| 层 | 当前实现 | 入口 |
|---|---|---|
| 桌面 UI | React 18、TypeScript、Vite、Tailwind、Zustand；ProseMirror 创作输入 | [apps/desktop](../apps/desktop/) |
| 本机后端 | Tauri 2、Rust、Tokio；SQLite/rusqlite，FTS5 | [src-tauri](../apps/desktop/src-tauri/) |
| 媒体 | image / fast_image_resize、LAB 提色、64-bit dHash；FFmpeg/ffprobe 统一发现 | [media](../apps/desktop/src-tauri/src/media/) |
| 浏览器采集 | MV3 扩展、axum WebSocket；Windows 内置 WebView2 探索 | [extension](../apps/extension/)、[探索契约](EMBEDDED-BROWSER.md) |
| 云控制面 | Supabase Auth/Postgres/Storage + Edge Functions | [cloud](../apps/cloud/) |
| 云执行 | VPS 常驻 Worker；官方 API；DSH/ACP 受控工具 | [agent-worker](../apps/agent-worker/) |
| HTML 渲染 | 独立、断网、资源受控的 Chromium renderer | [HTML 契约](HTML-RENDER-PLAN.md) |
| 官网 | 服务端代理、共享账号权益、兑换码后台 | [website](../website/) |

依赖版本以 package.json、Cargo.toml 与锁文件为准；平台共用 canonical source，不维护整文件 Windows override。构建与 NSIS 流程见 [Windows/README.md](../Windows/README.md)。

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
- 搜索同步 `name / prompt_body / annotation`；当前多维度查询使用 LIKE，标签/颜色走关联表；不做 CLIP 向量搜索。分类走本地模型包，见 [LOCAL-CLASSIFICATION.md](LOCAL-CLASSIFICATION.md)。

## 生成与理解

| 能力 | 当前路线 | 约束 |
|---|---|---|
| 图片生成 | Codex CLI、Dreamina CLI、Bowerbird Cloud | `GenProvider` / `resolve_gen_provider`；Cloud 档位来自服务端 `service_costs` |
| 反推/命名 | 本机 Codex 或 Cloud 方舟 Vision | `UnderstandProvider`；即梦不承担理解 |
| 视频 | Dreamina Seedance 2.5、Cloud 国内方舟 Seedance 2.5 | [CLI 四模式](SEEDANCE-2.5-INTEGRATION.md)、[Cloud 恢复与结算](VIDEO-API-INTEGRATION.md) |
| 分层 | Cloud Seedream 5.0 Pro | [透明图层与本地工程](LAYER-EDITING.md) |
| Agent | 官方统一 Skill + DSH，旧受控链路兼容 | [通用 Harness](UNIFIED-AGENT-HARNESS-PLAN.md)；仍 test-only |

后端入口为 [codex/mod.rs](../apps/desktop/src-tauri/src/codex/mod.rs)、[understand.rs](../apps/desktop/src-tauri/src/codex/understand.rs)。UI/provider 默认选择与单次选择须遵守 FeaturePolicy：免费仅 Cloud，本机 CLI 由 Pro/Studio 解锁；不能只靠按钮禁用。

本机 CLI 使用 Bowerbird 独立凭据；Windows 应用内更新保留登录、普通手动重装清登录，具体上线版本与失败恢复边界见 [桌面自动更新](DESKTOP-UPDATES.md)。不得读写系统 CLI 原登录。普通生成持久化到 SQLite 任务队列，按 job 取消；即梦串行，Cloud 按原 job/key 恢复。上游结果未知不自动重发或退款。

Agent 的授权、预算、审批、幂等、计量、租约、TTL 由控制面掌权，DSH 不接管账本；新内容能力复用工具与按需 Skill，不新增领域 Runner。Codex 直接生成保留，禁止新建 Codex + 正式 Agent 组合；即梦 Agent CLI 真机专项按用户决定暂停。

## 当前接续

未完成项只维护在 [PROJECT.md「目前进展」](../PROJECT.md#目前进展)。收费化部署/验收见 [ARCH-ADJUST-PROGRESS.md](ARCH-ADJUST-PROGRESS.md)，操作手册见 [DEPLOY.md](../apps/cloud/DEPLOY.md)。创作记忆仍是 [待实施计划](CREATIVE-MEMORY-PLAN.md)，不得将既有引用计数视为完成学习。
