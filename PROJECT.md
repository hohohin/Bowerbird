# PROJECT.md

本文件是项目的**活文档**（living doc），记录说明、进展、约定与踩坑。权威的完整设计见 `Bowerbird开发计划.md`；面向 Claude Code 的工作规则与索引自见 [CLAUDE.md](CLAUDE.md)。

---

## 子文档索引

- [analyse-panel-todo.md](analyse-panel-todo.md) — 详情页「反推」面板待优化清单（结果管理 / 流式取消 / 术语统一 / 未登录置灰 等，2026-07-07 评审，P0–P2 分级）
- [PRICING.md](PRICING.md) — 商业模式与定价策略（架构张力 / 竞品定价实测 / 免费·付费功能切法 / 价位卡位，2026-07-18）
- [AI-PROVIDERS.md](AI-PROVIDERS.md) — AI provider 可切换方案（泛化 GenerationPanel + 全局默认/单次覆盖 + codex/即梦首批 + 即梦走官方 dreamina CLI + 关键约定 1 演进，v2 草案 2026-07-23）

## 项目说明

**Bowerbird（园丁鸟）** —— 为 AI 图像创作服务的、本地优先的「提示词 + 参考图」素材库与编排工作台。形态：Tauri 2 桌面应用 + 浏览器扩展。

- **核心交互**：**创作板**（拟文本编辑器）—— 选图 + 选维度下拉，所见即一段中文句子；每个选项 / 缩略图背后映射真实提示词片段，底部「确认生成」拼出完整 prompt + 参考图发 codex（优化 / 扩写 / 生成）。用户全程不写一字提示词。设计稿见 [桌面端UI设计.html](桌面端UI设计.html)。
- **范围**：v1 覆盖六大工作流 —— 收集 / 浏览 / 搜索 / 整理 / 分析 / **生成（⑥）**（2026-07-06 决策扩展，覆盖开发计划 v1.2 §1.4「不做生成」，详见关键约定 2）。
- **定位**：不是「复现 Eagle」，而是把散落的灵感图片组织成可复用的「提示词 + 参考图」资产并交给 AI。
- **哲学**：素材与提示词 100% 本地（Local-First）；AI 推理与生成经用户自有的 codex CLI（可能联网）。

完整定位、范围、技术栈、数据模型、Roadmap 见 `Bowerbird开发计划.md`（v1.2，2026 年 7 月）。

---

## 目前进展

> 更新时间：2026-07-23

**当前阶段：1.0 功能路径打通 + v1 范围扩展到生成（⑥）+ 创作板 UI 已实现（2026-07-18 重写为 ProseMirror）。** 详情页「反推」真正看图（codex CLI + gpt-5.5，ChatGPT 订阅，绕过 API quota）；FTS5 文件名搜索可用；**创作板（真实 prompt 文本编辑器 + @ 选图）已落地**（[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)）；**生成（⑥）纳入 v1**，待 spike 验证 codex CLI 的画图能力。

**源码树（按开发计划 §7）：** `apps/desktop/{src, src-tauri}`、`apps/extension/`、`packages/shared/`。常用命令：`pnpm install`、`pnpm tauri dev`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。

**已完成：**
- **Phase 0（脚手架）**：monorepo（pnpm workspace）、Tauri 2 + React 18 + Vite + Tailwind + Zustand、`rusqlite`(bundled, FTS5) + 迁移（§4.2 全表）、`CodexProvider` trait + Mock + ClaudeCode（默认禁用）、SQLite 任务队列骨架。
- **Phase 1（P0 MVP）**：导入流水线（probe → 缩略图 → dHash → 去重 → 入库）、资源库 CRUD、瀑布流（CSS columns + 缩略图懒加载）、侧栏、浏览器扩展采集（MV3 + WS `127.0.0.1:39871` + 下载入库）。
- **小红书采集 P0（2026-07-14）**：扩展为 `xiaohongshu.com` 增加结构化适配——发现页读 `feed.feeds` 只采笔记封面（滚动新增卡片由笔记链接内主图补齐，排除头像/装饰），图文详情读 `noteDetailMap.note.imageList` 采完整有序图片；视频笔记仅采封面，不读取 Cookie、不调用私有 API。扩展由「每图一个 WS」改 `save_batch` 单连接批次协议，逐项携带 `media_url`（下载）+ 笔记 `source_url`（追溯）并返回逐项结果；桌面下载器复用 `reqwest::Client`，带 UA/Referer、按文件魔数/Content-Type 识别 WebP 等真实格式、ULID 安全临时文件、30s 超时/50 MiB 上限/最多 5 次安全重定向，并拒绝本机与常见内网直连。相关 [content.js](apps/extension/content.js)、[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs)、[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs)、[扩展 README](apps/extension/README.md)。
- **品牌标识 + Windows 安装包（2026-07-14）**：使用用户提供的 `Bowerbird logo3.png` 作为图形源，生成 Tauri 的 Windows/macOS/iOS/Android 全套应用图标；扩展 Manifest 增加 16/32/48/128 图标，网页悬浮采集入口由 🐦 改为新 Logo（根目录扩展、Windows override、Windows 独立加载版三处同步）。NSIS 显式配置安装器/卸载器图标为 `icons/icon.ico`；[Windows/build.ps1](Windows/build.ps1) 已修正单返回值路径解析并成功产出 [Bowerbird_0.1.0_x64-setup.exe](Windows/dist/Bowerbird_0.1.0_x64-setup.exe)（Windows x64，一键安装，未签名；SHA-256 `8D68FD99CFA1D87F1C083320FDE4ACEF3C7F832D03041A01957B7768AB32D4EF`）。
- **Phase 2（P1）**：K-Means 提色（LAB）+ 主色条 + 颜色筛选、多格式预览（SVG 前端直渲染 / 视频 ffmpeg 抽帧）、智能文件夹（`source:`/`ext:` 过滤）。
- **Phase 3（核心枢纽）**：prompts/asset_prompts CRUD、提示词编辑器（绑定 main/ref/desc）、**选图组创作包 `assemble_pack`**、创作包导出（prompt + 参考图清单）、`ClaudeCodeProvider` 真实接入（`claude -p --output-format stream-json` 流式）+ 前端 event 流式呈现。
- **桌面端 UX 重构（2026-07-05）**：浏览/批量双模式（默认浏览：点图→详情页；「批量管理」进入多选）；详情页（大图 `store_path` + 元信息 + 提示词板块 + 来源外链）；`move_assets_to_folder` 命令；`codex_generate_prompt_for_asset` 命令（Mock 走通，真实多模态待 Phase 5 spike）。瀑布流缩略图抖动已修（`aspect-ratio` 占位）。
- **Phase 4（P2 检索 · 部分）**：FTS5 同步触发器（`0002_fts.sql`：assets INSERT/UPDATE/DELETE → `library_fts`）+ 存量回填；`search_assets` 命令（trigram match，按 `rank`）；Toolbar 搜索框 + 清除；App 在 `searchQuery` 非空时切到搜索结果。
- **Phase 5（P3 拆解分析 · 简化版）**：`analyses` CRUD + `codex_describe_asset` 命令（**反推：固定发"请描述这张图片"**，结果入 `analyses(kind=caption)`）；详情页「反推」按钮 + caption 卡片呈现。按用户要求**仅做反推**，未做 OCR/版式/灵感卡/关键词模板集。
- **反推提示词维度归类（2026-07-07）**：caption payload 从纯 `{text}` 增量升级为结构化 JSON（`schema_version/text/instruction/session_id/sections/dimensions/parse_status`）。解析器**动态识别所有 markdown 维度标题**（`**任意维度**` / `- **任意维度**` / `### 维度` / `维度：内容`），原样保留进 `sections`；同时经别名表把常用维度归一化为五大标准键 `composition/light/palette/action/mood` 写入 `dimensions`。详情页按模型实际输出的 sections 顺序展示（含 类型 / 材质 / 反推提示词 等），创作板 `@图片 + 维度` 只注入对应 section 正文，缺失时回退整段 caption。旧 `{text}` 数据继续兼容。
- **创作板 UI（2026-07-08）**：[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) 落地「真实 prompt 文本编辑器」——右侧面板，用户像跟 AI 输入 prompt 一样自由书写；输入 `@` 触发图片选择（创作板变灰 + 瀑布流跑马灯高亮，且瀑布流仅显示已反推的图），点图后焦点回编辑框并插入「缩略图 + 图名」token；图片后浮现维度 chips（取自该图反推 `sections` 标题，见约定 10），点击插入蓝色下划线维度 token，**面板常驻可连续点多个维度**（同图的光影/类型/氛围… 不用重新 `@` 选图；Esc / ✕ 收起）；手输维度按空格/回车/标点自动识别转 token。底部「实际发送 prompt」把图片 token 按所选维度展开为 `@图名 的【维度】：section 正文`，多维度各自取片段（详见踩坑「多维度序列化」）。后端新增 `list_prompted_assets` 命令（只返回有 caption 的资产 + sections）。入口为 Toolbar 右侧「🎬 创作板」按钮（非批量管理）；旧 `PackPanel.tsx` 已删。（2026-07-08 续：点图不再自动插「的」、不选维度的图片 token 作**纯参考引用**只输出 `@图名`，支持「将@B 变为@A 的调性」这类用法，见约定 9。）（2026-07-09 续：创作板打开时点瀑布流任意图即插入参考图，无需先打 `@`；`@` 保留为显式高亮入口，见约定 9。）
- **采集即命名（2026-07-08）**：图片进库（扩展采集 + 拖拽/剪贴板/文件夹导入）即后台 `spawn` 一次 codex，一次产出两样——① ≤8 字命名写回 `assets.name`；② 基础 caption（无维度，落 `analyses(kind=caption)`），让新图自动「创作板就绪」。**非阻塞**（先秒级落库可见，命名/caption 后台完成后再 emit `library://assets-changed`）；信号量(3)节流批量并发；dHash 去重命中的已有资产先查 `has_analysis`、已有 caption 则跳过；codex 不可用静默降级（保留原文件名，约定 7）。新增 [core/autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs)；caption 解析 + payload 构造抽到 [core/caption.rs](apps/desktop/src-tauri/src/core/caption.rs) 共享（`commands::codex` 反推与 autoname 共用，反推行为不变）；DB 加 `update_asset_name`（命中 [0002_fts.sql](apps/desktop/src-tauri/sql/0002_fts.sql) 的 `AFTER UPDATE OF name` 触发器，FTS5 索引自动同步）/ `has_analysis`；三个入口（[ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs) 采集 / [library.rs](apps/desktop/src-tauri/src/commands/library.rs) `import_files`·`import_folder`）挂钩；`ingest_dir` 改返回 `Vec<Asset>`。详见关键约定 11。

- **反推后台化 + 全局可见（2026-07-08）**：反推不再绑死在 AssetDetail 组件生命周期——执行状态提到 zustand store（`describingId` / `describeQueue` / `describeStartedAt`），详情页点反推后返回瀑布流**继续后台跑**、结果照常入库；**瀑布流缩略图右上角标**「反推中 / 排队 N」（点击即取消：运行中 kill 子进程、排队中移出队列）；**前端单槽排队**——连点几张图串行执行（不并发打 ChatGPT 订阅），根治此前「连点反推 → 后端单例 sender 被 replace → 前一张被静默 kill」的坑（详见踩坑）。后端 `codex_describe_asset` 加 `AppHandle`，`insert_analysis` 后 emit `analyses://changed`，让创作板（`promptedAssets`）/ 当前详情页（`analyses`）按需自动刷新，无需手动 refresh。

- **图像生成（⑥）打通（2026-07-08）**：创作板底部「✓ 发送 codex 生成」把最终 prompt + 参考图发 codex（`codex exec --image`，与反推同机制），codex 调内置 `imagegen` 技能出图。[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs) 新增 `generate_image`：按行读 JSONL，把每条 `item.completed(agent_message)` 即时推 `codex://chunk`（Delta，**真流式**，app 内可见过程——旧 `run_stream` 是一次性 Done、且前端 done 回调没渲染 `c.text` 连最终文本都看不见，本次一并修）；跑完 `spawn_blocking` 扫 `~/.codex/generated_images/` 取本次新增图（**快照差分**，比 mtime 稳——见踩坑），`ingest_generated` 进库为正式资产（source=codex、进瀑布流）；`generate_image` 借用 tx 推 Delta + 返回源图路径，command 层 ingest 后以 asset 路径发 `Chunk::Done` + emit `library://assets-changed`。新增 [commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_create_image` / `cancel_codex_create`（独立 `GENERATE_CANCEL`，与反推互斥无关、可中断）。codex 不可用时按钮置灰 + 显原因（约定 7）。**端到端实测跑通（2026-07-08）**：创作板推送 → codex imagegen 生成 → app 内回显 + 入库整条流程实测通过（关键约定 2 转正，取图机制见踩坑）。
- **生成图对话迭代修改（2026-07-08）**：图片难一次满意，创作板支持多轮对话——首轮生成拿到 `session_id`（`Done.session_id`）后，「提修改意见」输入框带它走 `codex exec resume <id>` 续接同一 codex 会话：codex 记得上一张图与对话上下文，按修改意见编辑出新一轮图（spike 实测可行）。[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs) `generate_image` / [commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_create_image` 加 `session_id` 参数（Some→`resume <id> -`、None→新 exec）；[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) turns 时间线展示各轮 prompt + 产出图，「重新生成（新会话）」可重置。
- **生成图入库（2026-07-08 续）**：生成图不再是孤立副本，而是 `ingest_generated` 进库为正式资产（`source=codex`、不算 pHash 故迭代各版相似图都各自保留、不参与去重），进瀑布流浏览。`generate_image` 重构为借用 tx 推 Delta + 返回源图路径（不再 copy / 发 Done），command 层 ingest 后以 asset 路径发 `Done` + emit `library://assets-changed`；移除原 `LibraryPaths.generations` 中转目录。
- **生成图标记（视觉 + 筛选 + 追溯 + 命名，2026-07-08 续）**：① 视觉——瀑布流缩略图左上 ✨ 角标、详情页头部「✨ codex 生成」徽章（[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) / [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)）；② 筛选——侧栏「✨ 生成图」走 `source:codex`（新增 [list_assets_smart](apps/desktop/src-tauri/src/commands/library.rs) 命令 + store `smartFilter`，与文件夹/搜索互斥）；③ 来源追溯——`codex_create_image` 把 `{prompt, session_id, references}` 落 `analyses(kind=generation_meta)`，详情页「生成来源」卡片展示 + 「在 codex 中打开会话」；④ 自动命名——[autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs) `spawn_auto_name_only` 给生成图 codex 看图取 ≤8 字中文名（**只命名不写 caption**，不进创作板 @ 引用池），替代 codex 默认的 `ig_<hash>`。

- **P2 标签 + 自动归类（2026-07-09）**：`tags` 表加 `source` 列（auto=codex / manual=用户，[0005_tags_source.sql](apps/desktop/src-tauri/sql/0005_tags_source.sql) + seed 10 个预置词表：人像/风景/静物/美食/动物/建筑/抽象/插画/室内/街景）。**采集即归类**——`spawn_auto_analyze` 除命名 + caption 外，还从 codex 回复抽 `[[CAT: 类别]]` 哨兵 → 写 auto tag（仅当该图尚无 auto tag，防顶手改）；**批量重归类** `reclassify_all`（Toolbar「智能归类全部」）对「无 auto tag 且有 caption」的图喂 caption 文本（不看图）让 codex 重新分类，emit `classify://progress {done,total,ended?}`。tag 检索走 `list_assets_smart` 的 `tag:<name>` JOIN（**不进 FTS**——0002 触发器不维护 tags 列）；侧栏「自动归类」分区（一行两列、tag 以 `#` 前缀展示替代 emoji）= auto tag + 计数（count>0），点击即 `tag:` 过滤；详情页「类别」板块区分 auto（灰）/ manual（强调），可加/删（按 source 隔离全量替换，互不误伤）。相关 [core/library.rs](apps/desktop/src-tauri/src/core/library.rs)（`get_or_create_tag`/`set_asset_tags`/`list_tags_with_count`/`has_auto_tag`/`list_assets_to_classify`）、[autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs)（`extract_categories`/`apply_auto_categories`/`spawn_reclassify_all`）、[Sidebar.tsx](apps/desktop/src/components/Sidebar.tsx)、[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)。
- **文件夹管理增强（2026-07-09）**：侧栏文件夹行 inline 改名 / 删除（两段式确认，避开 Tauri WKWebView 对 `window.prompt`/`confirm` 的拦截；新建文件夹/智能文件夹也改 inline 表单）；BatchBar「移入已有文件夹」（select 已有普通夹）。后端新增 `rename_folder` / `delete_folder`（均排除 root）。
- **全局 codex 状态圈（2026-07-09）**：顶部工具栏最右侧一个圆，反映全局 codex 调用状态——空闲（静态圆环）/ 反推中（圆环旋转，有排队时环内嵌实心圆 + 队列数）/ 导入基础分析中（旋转环）/ 生成中（六格 pulse loader，[uiverse spotty-starfish-76](https://uiverse.io/cosnametv/spotty-starfish-76)，CSS 在 [styles.css](apps/desktop/src/styles.css)）。codex 调用是全局的（反推 / 创作板生成 / 导入基础分析都会触发），故指示器常驻顶栏而非只在创作板（初版放创作板内是错的）。三路信号：反推 `describingId`/`describeQueue`（store 已有）、生成 `generating`（从 CreationBoard 本地态提到 store）、导入分析 `autoAnalyzing`（后端 [autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs) `AUTO_ACTIVE` AtomicUsize + RAII `AutoActiveGuard`，拿信号量 +1 / 释放 -1 时 emit `codex://auto-active`）。组件 [CodexStatus.tsx](apps/desktop/src/components/CodexStatus.tsx)。
- **P3 色板量化修复（2026-07-09）**：补颜色量化层——12 命名桶（LAB ΔE / CIE76，复用 [color.rs](apps/desktop/src-tauri/src/media/color.rs) `lab_dist`），新建 `asset_colors(asset_id, bucket)` 多对多表（[0006_color_buckets.sql](apps/desktop/src-tauri/sql/0006_color_buckets.sql)，与 `asset_tags` 对称）；入库时 [ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs) `link_colors` 量化挂钩、存量靠 Toolbar「重建色板」（`recompute_colors` 后台扫全库 + emit `color://rebuild-progress`）。色板/筛选全走后端：`palette_overview` 返回 `{key,count,hex}`（hex 后端注入消除前后端双源）、`list_assets_by_color` 带 folder 上下文（folder+color 叠加，在风景夹里筛红色）；colorFilter 与 smartFilter/search 互斥、与 folder 叠加。缩略图色条仍用 `assets.colors` 原始中心色（视觉准确）。
- **生成结果面板独立化（2026-07-10）**：生成 UI 从 [CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) 抽出为独立 [GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) 主区覆盖层（像详情页那样盖住主区，创作板在右槽始终可用、可继续组下一轮稿）。生成对话状态（`genTurns`/`genSessionId`/`genStreaming`/`genPanelOpen`/`genLastPrompt`/`genLastRefs`/`genUnread` + `startGeneration`/`sendGenRevise`/`applyGenChunk`/`cancelGeneration`）从 CreationBoard 本地态提到 [store.ts](apps/desktop/src/store.ts)；`codex://chunk` 监听挪到 [App.tsx](apps/desktop/src/App.tsx) 全局（alive 守卫防 StrictMode 双挂载重复，见踩坑）；Toolbar 加「🖼 生成结果」按钮（生成中转圈 / 面板关时有新结果红点角标）；`codexHealth` 提到 App 级（创作板/生成面板共用置灰依据）。面板随时开合不丢对话。
- **生成图 prompt → 反推提示结果（维度识别，2026-07-10）**：生成图入库时不再让 codex 反推去「猜」——直接从生成 prompt 里识别 `【维度】：正文` 片段（创作板序列化 `@图名 的【维度】：正文` / 独立 `【维度】：正文` 注入）→ 按 `**维度**\n正文` 分段落 `analyses(kind=caption)`，正中 `caption::parse` 的 section 识别（详情页按段展示、创作板维度 chips 随之生成），**全程不调 AI**。新增 [commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `build_generation_caption`/`extract_dim_sections`/`cut_trailing_connector`/`is_valid_dim_title`（正文到下一个 `【`/`@` 截断，按最后一个句末标点 `。！？` 去尾随连接词如「，以及」；同名维度后出现者覆盖=修订版优先；无维度回退整段）+ [core/library.rs](apps/desktop/src-tauri/src/core/library.rs) `generation_prompt_chain`（按 `generation_meta.session_id` 取会话 prompt 链、相邻去重）。caption 落库后 emit `analyses://changed` 让创作板 @ 池即时刷新。prompt 原文仍存 `generation_meta`（「✨ 生成来源」卡片）。生成图因有 caption 进创作板 `@` 池（用户确认允许，chips = 识别出的维度）。
- **生成图同流程合并（2026-07-10）**：同一 codex 会话的多张过程图原先各占一格、瀑布流冗杂 → 合并成一组、**瀑布流只显最新一张**、可左右切换过程图。`assets` 加 `generation_session_id` 列（[0007_generation_groups.sql](apps/desktop/src-tauri/sql/0007_generation_groups.sql) + 索引 + 从 `generation_meta` 回填存量）；`ingest_generated` 带 session_id、[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) 传入 `outcome.session_id`。[core/library.rs](apps/desktop/src-tauri/src/core/library.rs) `collapse_generation_groups`（泛型；列表已 `created_at DESC`，同 session 首见=最新，去重保首见）在 5 个 wrapper（`list_assets`/`list_assets_smart`/`list_assets_by_color`/`search_assets`/`list_prompted_assets`）return 前各调一次；`list_generation_group`（单取）+ `list_generation_groups`（批量 `HashMap<asset_id, Vec<Asset>>`）两命令。前端：[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) 批量取组 → 缩略图 ✨ 角标带 `idx+1/N` + 悬浮 ◀▶ 翻过程图；[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 图片下方常驻 `◀ 1/2 ▶` 控制条 + **←/→ 方向键切换**（输入框内不拦截），sibling 不在主列表时从 group 解析、组已含 id 时跳过重取。
- **收藏夹（多对多，2026-07-10）**：详情页 header ☆ 按钮 → 行内 panel 选已有收藏夹 / 新建收藏夹 → ★ 完成。新增 `asset_collections(asset_id, folder_id, created_at)` 多对多关联表（[0008_collections.sql](apps/desktop/src-tauri/sql/0008_collections.sql)，与 `asset_tags`/`asset_colors` 对称；trigger 拒绝把普通/智能文件夹当收藏夹目标、级联随素材/收藏夹删除清理；`folders.kind='collection'` 标识收藏夹）。**`assets.folder_id` 位置语义不变**——素材保留原文件夹、可同时收进多个收藏夹。后端 6 命令（`create_collection`/`list_collections`/`list_asset_collections`/`add_asset_to_collection`(INSERT OR IGNORE 幂等)/`remove_asset_from_collection`/`list_assets_by_collection`，写命令 emit `library://assets-changed`）；前端 store `currentCollectionId`（与 folder/search/smart/color 互斥）、App refresh 分流加 collection 分支、Sidebar 三分区（普通夹 / ★ 收藏夹 / 智能夹，`FolderRow` 泛化按 kind 分流）、AssetDetail header ☆/★ + 行内 panel（已收藏 chips 可单移除 + 选已有 + 新建并收藏）。详见关键约定 12 + 踩坑「BatchBar `kind!=='smart'` 污染 folder_id」。

- **新用户上手：codex 首启引导页 + 未签名 dmg（2026-07-10）**：① 新用户原本拿不到 app、且 codex 未就绪时 UI 只置灰按钮 + 小字 `reason`、不知 codex 为何物/如何配置。新增 [CodexOnboarding.tsx](apps/desktop/src/components/CodexOnboarding.tsx)——项目首个全屏 Modal（`fixed inset-0 z-50` + `bg-black/60` 遮罩 + 居中卡片，组件自管可见性、不满足条件直接 `return null`）：`codexHealth` 未就绪且未「稍后」/未通过检测时弹出，三步引导（`npm i -g @openai/codex` / `codex login` 登录 ChatGPT 订阅 / 重新检测）+ 命令复制按钮 +「稍后再说」（localStorage `bowerbird.onboardingSeen` 持久不再弹）/「重新检测」（重跑 `codexHealth`、通过即关）；[App.tsx](apps/desktop/src/App.tsx) 最外层 div 内、`<Toolbar>` 前无条件渲染 `{<CodexOnboarding />}`。`codexHealth` 复用 store（App 挂载已取、不重复调），「已看过」flag 照 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 的 localStorage 范式不入 store。② **首个未签名 dmg 出包**：`pnpm tauri build` → `target/release/bundle/dmg/Bowerbird_0.1.0_x64.dmg`（未签名，首次打开需右键→打开绕 Gatekeeper，或 `xattr -dr com.apple.quarantine`）。**范围**：纯前端、仅 macOS；Windows 三处 bug（登录检测死读 `$HOME` / 安装检测找不到 `codex.cmd` shim / `codex_cli.rs:68` 取图路径同 bug）/ 签名公证 / 登录态轮询 / `codex_health` 加 `CODEX_HOME` 一致性 均留后续。详见关键约定 13。（**2026-07-17 更新**：其中 Windows codex 三 bug + `CODEX_HOME` 一致性 已在主源码修复——`Windows/overrides/` 的 codex 适配合并进了 [codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)/[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)，dev 与安装版同源；签名公证 / 登录态轮询 仍未做。`Windows/overrides/` 的 `codex.rs`+`codex_cli.rs` 随之冗余，**出 Windows 包前应删，否则 prepare.ps1 会用旧 overrides 覆盖主源码的多张改动**；其余 overrides（ingest/App/store/Toolbar/WelcomePanel）保留。）

- **一次生成多张图（2026-07-17）**：to-do 第1条。探索确认**接收侧全链路早已是数组语义**（`list_new_generated` 快照差分返 `Vec` → 循环 `ingest_generated` → `Done.images` 数组 → 前端 `applyGenChunk` `[...last.images, ...imgs]` → `TurnView` 多张 `grid-cols-2`），无需新增「接收多张」能力；**真瓶颈是首轮 instruction 硬编码「生成一张」**压制了用户 prompt 的数量意图。按用户决策**不加 UI 数量控件——数量完全由 prompt 驱动**（「生成3张」即出3张），bowerbird 全接住：[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_create_image` instruction 改为「张数完全以提示词要求为准；未指定时一张」；续轮 resume 分支本就是用户原文、天然支持多张。生成超时 300→600s（多张串行耗时翻倍）。首轮多张共享同一 `session_id` → `collapse_generation_groups` 自动合并成一组（瀑布流 ✨ N/M + 左右切换），正是一次多张变体的期望呈现。端到端实测通过。
- **Windows codex 适配并入主源码（2026-07-17）**：消除 dev/安装版分叉。起因：`pnpm tauri dev` 在 Windows 检测不到 codex（安装版正常），查证是主源码 `codex_health` 死读 `$HOME` + `Command::new("codex")` 找不到 npm 的 `codex.cmd` shim，而 `Windows/overrides/` 有适配、`prepare.ps1` 出包时覆盖主源码 → dev（纯主源码）与安装版（主源码+overrides）行为分叉。把 overrides 验证过的适配合并进主源码：[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs) 新增三 `pub(crate)` 辅助——`resolve_codex_binary`（`BOWERBIRD_CODEX_BINARY`→Windows 查 `%APPDATA%\npm\codex.{exe,cmd,bat}`→PATH；非 Windows 查 PATH）、`codex_home`（`CODEX_HOME`→`USERPROFILE`→`HOME`+.codex）、`codex_command`（Windows `.cmd/.bat` 经 `cmd.exe /D /S /C`+`CREATE_NO_WINDOW` 防弹黑窗）；`Default`/`run`/`generate_image` 全改用，`generate_image` 顺带搬 `read_until+lossy`（Windows npm shim 偶发非 UTF-8 不崩）、超时分支 kill 子进程+拼 stderr、空图友好报错。[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_health` 改用三函数、`open_codex_session` 加 Windows 分支（`cmd.exe start cmd.exe /K`）。至此**约定 13 列的 Windows codex 三 bug + `CODEX_HOME` 一致性 均在主源码修复**（`creation_flags` 是 tokio Command inherent 方法、无需 CommandExt import）。`cargo check`（Windows cfg 全编译）+ `cargo test` 通过。

- **生成结果历史回看（2026-07-17）**：to-do 第2条。此前生成对话时间线只活在内存（`store.genTurns` = 当前活跃会话镜像），重启或换会话后回看不了；但数据早就在库里（每张生成图一行 `generation_meta` 存 `{prompt, session_id, references}` + `assets.generation_session_id` 关联同会话图），缺的只是「按会话重建时间线 + 从某图入口」。后端新增 [library.rs](apps/desktop/src-tauri/src/core/library.rs) `generation_history(asset_id)` → `GenerationHistory{session_id, turns:[{prompt, images:store_path[]}], first_references}`：查该会话全部 generation_meta，按 `created_at ASC, id ASC` 排序、**相邻相同 prompt 合并为同一轮**（一次 `codex_create_image` 产多张图 = 多行同 prompt 时序相邻），首版 references 单独带回供「新会话重新生成」复用；非生成图（无 session_id）返回空。命令 [commands/library.rs](apps/desktop/src-tauri/src/commands/library.rs) `generation_history` + [lib.rs](apps/desktop/src-tauri/src/lib.rs) 注册。**前端复用 GenerationPanel**（用户确认方案）：[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)「✨ 生成来源」卡片新主按钮「💬 回看生成对话」→ store `viewGenerationHistory` 把历史 turns load 进 `genTurns`/`genSessionId` 并弹 GenerationPanel——时间线展示各轮 prompt+产出图（`TurnView` 的 `convertFileSrc` 直接吃 `store_path`，**面板零改动**），底部「继续修改」天然 `codex exec resume` 续接历史会话（新轮入库写同 session 的 generation_meta，下次回看自洽）；generating 中拒绝覆盖当前会话。回看面板盖住详情页（同 `relative` 容器、`z-10` 后渲染），关面板即回详情页。

- **回看后复用 prompt / 登记为用途（2026-07-17，2026-07-18 即梦式演进）**：① **复用到创作板**（即梦式：每轮 TurnView 上「📋 复用」按钮，点某条生成即复用该轮 prompt + 会话参考图）→ [store.ts](apps/desktop/src/store.ts) `reusePromptToBoard` 开创作板 + 关详情/生成面板 + 延一帧 dispatch `bowerbird://board-load-prompt`；[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) listener 把 **prompt 全文载入输入框 `draft` + 参考图作 `silent` image token**——`silent` 图序列化跳过 `@图名`（避免重复）但 references 照常收集（store_path 随发送传 codex），参考图经 local `extraAssets` 注入 `assetById`。**复用后可就地编辑**（即梦核心，2026-07-18）：prompt 进 `draft` 而非原子 `text` token，用户可光标定位/改词/换行编辑；创作板单行 `<input>` 升级为多行 `<textarea>`（按 `scrollHeight` 自适应高度、上限 240px 后滚动）；`onDraftChange` 的 `@` 触发改为「仅本次新输入 @」（对比 `draftRef`），避免复用 draft 已含 `@图名` 被一编辑就误触发选图 + 清空。**遗留局限（诚实）**：textarea 内 `@图名` 是纯文本（非可点缩略图 token），改/删图描述走文本；文本内 `@图名` 与图片 token 的双向联动需重写为 contenteditable/ProseMirror，本次不做。② **登记为用途**（面板底部，inline 起名 → `createPreset`）+ **补 preset 编辑/删除 UI**（CreationBoard 用途区选中 preset 显示「编辑/删除」，调 `updatePreset`/`deletePreset`——此前两 api 无前端入口，preset 只能建不能改）。后端 `generation_history` 返回 `references: Asset[]`（按 store_path 反查），preset CRUD 零改动。

- **创作板重写为 ProseMirror（2026-07-18）**：收掉两处遗留限制（踩坑「退格删太多」「回看后复用即梦式演进」标注的：中段编辑不支持 / 文本内 `@图名` 与图片 token 无双向联动）。编辑器内核从「尾部 textarea + `tokens[]`」整体换为原生 ProseMirror doc（`paragraph+`，text/image/keyword 三种 inline 节点；image/keyword 是原子 chip，attrs 存 assetId+name+ext+thumb 快照供 toDOM 渲染缩略图）。新增 [creation/](apps/desktop/src/components/creation/) 5 模块：[schema.ts](apps/desktop/src/components/creation/schema.ts)（SchemaSpec + toDOM + imageAttrs）、[serialize.ts](apps/desktop/src/components/creation/serialize.ts)（移植旧版 `serializePrompt`/`nextSectionTitle`/`serializeImageToken`/`serializeKeyword`，数据源换 doc 扁平序列，**输出与旧版字节级等价**）、[parse.ts](apps/desktop/src/components/creation/parse.ts)（`@图名` 贪心最长+边界检查匹配、载入多行+silent 参考图）、[plugins.ts](apps/desktop/src/components/creation/plugins.ts)（标点 keymap：先试 @图名、再试维度 endsWith；baseKeymap+history）、[useCreationEditor.ts](apps/desktop/src/components/creation/useCreationEditor.ts)（非受控 EditorView + tick 派生 + window 事件 + clipboardTextParser）。[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) 瘦身为 UI 外壳（preset CRUD/复制/发送/维度 chips/预览）。**`@` 语义从「显式挑图入口」改为「mention 前缀」**（手输 `@图名`+标点转 chip；载入/粘贴整段解析）；挑图单一入口 = boardOpen 时点瀑布流图（**光标处插入**，取代旧版末尾追加）。**连带清理 `boardPickMode` 整条链路**（[store.ts](apps/desktop/src/store.ts) 字段+3 方法、[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) 高亮条/cursor-crosshair、CreationBoard 提示框/灰显）—— @ 不再触发挑图后的孤儿。序列化契约保持（`【维度】：正文` + `@` 终止符，后端 `extract_dim_sections` 测试 51 passed 兜底）。修 reuse 后 preset 重复拼接（`reusePromptToBoard` 载入时清 `activePresetId`）。新增 7 个 prosemirror-* 依赖。约定 9 更新；踩坑见「schema 漏 group:inline」「PM 集成 API 坑」「reuse preset 重复」。

- **Windows codex overrides 清理（2026-07-18）**：兑现关键约定 13 / 踩坑「dev 在 Windows 检测不到 codex」里的计划——`Windows/overrides/apps/desktop/src-tauri/src/codex/` 的 `codex_cli.rs` + `commands/codex.rs` 随 Windows 适配合并进主源码后已冗余，本次删除（`prepare.ps1` 出包不再用旧 overrides 覆盖主源码的多张改动）。其余 overrides（ingest/App/store/Toolbar/WelcomePanel）保留。
- **Windows 前端 overrides 并入主源码（2026-07-20）**：延续 codex override 并入趋势，删掉剩余四个前端 override（`store.ts`/`App.tsx`/`Toolbar.tsx`/`WelcomePanel.tsx`），其差异化功能（扩展连接状态 `extensionConnected`、采集提示 `collectedNotice`、环境状态面板）并入主项目源码——[store.ts](apps/desktop/src/store.ts) 加两字段+setter、[App.tsx](apps/desktop/src/App.tsx) 加 `collect://extension-connected` 与 `library://assets-changed`(payload.name) 两 listener、[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 环境状态区加「浏览器扩展」连接行、[Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx) 加「已采集：xxx · 查看」提示条（点击回总库）。起因：`build.ps1 -Clean` 出包 `tsc` 失败 12 处——主项目 store 演进（presets / colorRebuild 进 store / 删 boardPickMode / startGeneration 改签名）后，整文件覆盖式 override 与主项目分叉，`.work` 里「主项目新组件 + override 旧 store」类型对不上（详见踩坑「Windows 前端 overrides 整文件覆盖分叉」）。Rust overrides（ingest/ws_server + 已并入的 codex）不受影响、保留；**前端零 override**。Windows 覆盖工作树 52 测试通过，安装包 `Bowerbird_0.1.0_x64-setup.exe` 3,660,865 bytes（sha256 `6CD2331F…F24D`）。

- **瀑布流拖拽素材入文件夹（2026-07-18）**：to-do 第4条。瀑布流缩略图可直接拖到侧栏普通文件夹完成移动——browse 模式拖单张；manage 模式选中多张时拖任一选中项即拖全部选中（与 BatchBar「移入已有」一致直觉），拖未选中项只移该张；创作板挑图态禁用拖拽避免与点图插入选图冲突。[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) Thumb 外层 div `draggable={!boardOpen}` + onDragStart（manage 且该图在 selectedIds → 全部选中，否则单张；payload 写入新增 [dragPayload.ts](apps/desktop/src/lib/dragPayload.ts) 模块变量，dataTransfer 只写 `text/plain` 作「拖拽已发生」信号——**不用自定义 MIME**：macOS WKWebView 走 NSPasteboard 会 strip 自定义类型、同页也丢）+ onDragEnd 清场。[Sidebar.tsx](apps/desktop/src/components/Sidebar.tsx) FolderRow 仅 `kind==='folder'` 启用 drop（约定 12：collection 多对多、smart 无意义，二者 onDragOver 不 preventDefault → 不允许 drop），`dragOver` 计数器防子元素进出抖动，drop 后 `moveAssetsToFolder` + `clearSelect`。后端 [move_assets_to_folder](apps/desktop/src-tauri/src/commands/library.rs) 加 `AppHandle` + emit `library://assets-changed`——**拖拽不改 currentFolderId，当前视图靠此事件重拉才让移走的图消失**（对 BatchBar 冗余但无害）；不支持拖回「全部」（`folder_id` 非 Option，本 todo 之外）。

- **生成图点击放大 Lightbox（2026-07-18）**：to-do 第5条。生成面板里生成图点击原先 `<a href={convertFileSrc(p)} target="_blank">` 跳系统浏览器，而 convertFileSrc 走 Tauri asset 协议浏览器无权解析、**本就打不开**；改为 app 内全屏放大。新增 [Lightbox.tsx](apps/desktop/src/components/Lightbox.tsx)（`fixed inset-0 z-50 bg-black/90`，约定 13 全屏遮罩形态；createPortal 到 document.body 渲染（脱离 GenerationPanel 多层 overflow-hidden 父链，避免任何祖先层叠上下文/transform 吞掉 fixed 遮罩），稳定盖整屏）；点背景/Esc/✕ 关闭、点大图本体不关（stopPropagation）。**跨轮导航**：各轮图拍平成 `allImages`、每轮记起始 offset，点某图算全局 index，←/→ 键或箭头切换整个会话的所有版本（「回看生成对话」场景尤自然），单图无箭头。[GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) TurnView `<a>` 换 `<button type="button">`（cursor-zoom-in），map 时累加 imageOffset；预览图与大图同 URL 命中浏览器缓存、开图瞬时。

- **图片浏览缩放交互统一（2026-07-18）**：所有「看大图」场景统一为成熟图片查看器交互——**滚轮以光标为锚点缩放（zoom-to-cursor）+ 按住拖动平移（grab/grabbing 光标）+ 双击 1x↔2x 切换**，换图自动 reset。新增 [useImageZoom.ts](apps/desktop/src/lib/useImageZoom.ts) hook 供 [Lightbox.tsx](apps/desktop/src/components/Lightbox.tsx) 与 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 大图共用：transform `translate+scale`，zoom-to-cursor 数学 `tx'=tx+C·(1-k)`（C=鼠标相对当前 imgRect 中心、k=s'/s）；wheel 走原生 `addEventListener` + `passive:false` 才能 preventDefault 阻止页面滚动（React onWheel 在部分浏览器为 passive、preventDefault 无效）；拖动 move/up 挂 window，拖出元素仍跟手。视频保留 `<video controls>` 不缩放；AssetDetail 容器 `overflow-auto`→`overflow-hidden`（平移走 transform 不用滚动条）。瀑布流缩略图不纳入（网格导航，滚轮应滚动列表）。

- **创作板 ratio 选择下拉菜单（2026-07-20）**：创作板编辑框上方加**可扩展工具条**（ratio 在左、右侧留位，未来可加更多功能），首项 = 画面比例选择器。形态 = **inline 展开**（复用项目既有 inline 面板范式：toggle 按钮 + 下方 chip 面板 + 选中即收 / ✕，无 absolute 浮层 / 点外部关闭 / z-index / shadow——项目无下拉浮层先例，故不发明新范式）；档位 1:1 / 3:4 / 4:3 / 2:3 / 3:2 / 16:9 / 9:16 + 自动，icon = CSS 描边矩形按比例缩放（直观体现横竖）。**ratio 作为独立参数透传后端**（创作板本地 state + localStorage `bowerbird.boardRatio` 跨会话记忆，照 AssetDetail 范式；null=自动不注入），[codex.rs](apps/desktop/src-tauri/src/commands/codex.rs) `codex_create_image` 加 `ratio` 参数，**首轮** instruction 拼入「；画面比例为 16:9」，**续轮 resume 不注入**（codex 记得首轮比例）；用户 prompt 预览保持干净，未来即梦接入（[AI-PROVIDERS.md](AI-PROVIDERS.md) §5.3）可直接对接其 `size` 参数。新增 [creation/ratios.ts](apps/desktop/src/components/creation/ratios.ts)（档位数据 + `ratioIconBox` 尺寸 helper）、[creation/RatioSelect.tsx](apps/desktop/src/components/creation/RatioSelect.tsx)（inline 选择器 + RatioIcon）；透传链路 [store.ts](apps/desktop/src/store.ts) `startGeneration` / [api.ts](apps/desktop/src/lib/api.ts) `codexCreateImage` / [CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) `send`。

- **桌面端素材交互升级（2026-07-23）**：一批围绕瀑布流图片的体验改进——
  ① **右键菜单**：新增 [ContextMenu.tsx](apps/desktop/src/components/ContextMenu.tsx)（createPortal 到 body 避开瀑布流 overflow 裁剪、测尺寸做边界翻转、透明遮罩+Esc 关）；[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) 缩略图 `onContextMenu` 弹五项——在资源管理器中显示 / 用系统程序打开 / 复制文件路径 / 反推提示词 / 删除（两段式确认避开 WKWebView 对 `confirm` 的拦截）；后端新增 `reveal_path_in_explorer` / `open_path_with_system`（跨平台 spawn，不经 shell scope 故 capabilities 不改）+ [lib.rs](apps/desktop/src-tauri/src/lib.rs) 注册、[api.ts](apps/desktop/src/lib/api.ts) 加对应方法。
  ② **hover 放大预览**：[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx) 缩略图悬停 2.8s 弹放大图（portal 到 body，= 缩略图渲染尺寸 ×200%，跟鼠标定位、靠右/下边时翻转到左/上）；视频 / 无 store_path 不启用。
  ③ **创作板全量挑图 + 草稿持久化**：创作板模式瀑布流从「仅反推图」放宽到「全量资产」，任意图点一下即插为参考图（无 caption 的作纯参考，[useCreationEditor.ts](apps/desktop/src/components/creation/useCreationEditor.ts) `assetById` 并入 allAssets 让 references 收集到）；编辑器草稿即时持久化 localStorage（`bowerbird.boardDraft`，400ms 去抖），重挂载 `nodeFromJSON` 保真恢复（保留 image/keyword chip 不降级纯文本）；首发生成成功且期间未编辑时清空编辑器+草稿（组稿已交付），编辑过则保留（保护「生成期间继续组下一轮稿」，约定 9）。[App.tsx](apps/desktop/src/App.tsx) 创作板模式瀑布流显示全部资产、`promptedAssets` 仍并行拉取供编辑器给有反推的图补 sections。
  ④ **codex 生成失败可见 + 可重试**：此前失败仅显示「尚未生成…」，根因是 `genHandleError` 删失败占位轮 + `genStreaming` 只在有轮时渲染 → 错误被双重藏匿（详见踩坑）。改为失败挂到那一轮（`GenTurn.error`）成时间线可见的失败态（❌+原始错误+重试按钮），后端错误文本本就够可读（codex 退出码+stderr 前 500 字）。详见踩坑「codex 生成失败提示被双重藏匿」。
  ⑤ **反推提示词模块抽离**：把 `DEFAULT_DESCRIBE_PROMPT` 模板 + localStorage 存取从 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 内联抽到独立 [describePrompt.ts](apps/desktop/src/lib/describePrompt.ts)，详情页「反推」与瀑布流右键「反推提示词」共用同一份默认指令与存储。
  ⑥ **Windows 采集 save_batch 协议**：[ws_server.rs](Windows/overrides/apps/desktop/src-tauri/src/collect/ws_server.rs) override 补 `save_batch` 分支（原只认 `save_blob` 致小红书批量提交 `unknown type`），逐项 URL 下载入库、批量上限 100、逐项 emit `library://assets-changed`；[Windows-edited.md](Windows/Windows-edited.md) 同步更正。

- **即梦 CLI 调研 + AI-PROVIDERS.md v2 + Phase 0 spike 通过（2026-07-23）**：即梦 2026-04 推出官方 CLI `dreamina`（`curl -s https://jimeng.jianying.com/cli | bash`，单二进制 + OAuth 登录 + 即梦会员积分制，全平台含 Windows 原生 exe），[AI-PROVIDERS.md](AI-PROVIDERS.md) 接入路线**整体从 v1 的火山引擎 HTTP API（AK/SK + V4 签名 + 凭据存储 + 异步轮询）改为官方 dreamina CLI**（与 codex 同构的本地子进程）——消解签名实现、凭据存储两个老大难（开放问题 2/4），关键约定 1 演进更纯粹（所有 provider 都是 CLI 子进程，不开 HTTP 口子）。**Phase 0 spike 本机实测通过**（Win11 + maestro 会员）：`dreamina login` OAuth + `text2image --poll` + `query_result --download_dir` 全链路跑通——stdout 直接 JSON（无 `--json` flag，比 codex JSONL 逐行解析更简单）、下载命名 `{submit_id}_image_N.png`、`image_url` 是临时签名 URL（带 `x-expires`/`x-signature`，必须及时下载入库、不能存 URL）、`--generate_num` 1-10 原生多张（比 codex 靠 prompt 驱动数量更可靠，约定 2）、默认模型 5.0（v1 设想的「Seedream lite」在 CLI 不存在）、maestro 文生图本次未扣分（15080→15080，待确认免费权益还是延迟）。dreamina 的 ratio（9 档含 21:9）/`resolution_type`/`generate_num` 可直接对接创作板 ratio 选择器（[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx)），前端零改动。**关键约定 1 待 Phase 1 实现时演进**（方案已定、代码未动）。下一步进 Phase 1（`CodexProvider`→`GenProvider` trait + `generate_image` 提到 trait + 命令层加 `provider` 参数，默认仍 codex 行为零变化）。详见 [AI-PROVIDERS.md](AI-PROVIDERS.md) §3/§9。

- **AI provider 抽象重构 Phase 1（2026-07-23）**：落地 [AI-PROVIDERS.md](AI-PROVIDERS.md) v2 §5/§9 Phase 1——图像生成从「硬绑 codex」解耦为可切换 provider，**行为零变化纯解耦**，为 Phase 2 即梦接入铺路。trait `CodexProvider`→`GenProvider`（[mod.rs](apps/desktop/src-tauri/src/codex/mod.rs)），`generate_image` 从 `CodexCliProvider` inherent 提到 trait（[codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs) 逻辑一字不动）+ 加 `capabilities()` + 工厂 `resolve_gen_provider`（返回 `Box<dyn GenProvider>`：`None`/`codex`/`default`→CodexCliProvider、`jimeng`→报错留 Phase 2、未知→报错）；新增 `Capabilities` struct（[types.rs](apps/desktop/src-tauri/src/codex/types.rs)，`#[allow(dead_code)]` 标注 Phase 3 UI 消费）。[codex_create_image](apps/desktop/src-tauri/src/commands/codex.rs) 加 `provider: Option<String>` 参数，provider 解析**前置到 `GENERATE_CANCEL` 注册之前**（避免解析出错提前返回留 stale cancel sender）、`generation_meta` payload 加 `provider` 字段；理解类（反推 `codex_describe_asset` / autoname 命名 / 生成提示词）仍直构造 `CodexCliProvider::default()`、不参与切换（§4.3）。use 改名 3 处（零 `dyn` 散落）。前端零改动（serde `Option` 缺省 `None` = codex）。偏离 §5.1 草图 3 处（理由见存档计划）：`health()` 不进 trait（codex/dreamina 各自独立命令）、不加 `type` 别名（use 仅 3 处直接改名）、`CodexRequest`/`CodexResult`/`GenOutcome` 不改名。**验证**：`cargo check` 通过；`cargo test` **51 passed 0 failed**（回归无破坏；测试不依赖 trait/generate_image）。下一步 Phase 2：新建 `codex/jimeng.rs` 实现 `GenProvider`（spawn dreamina）+ `resolve_gen_provider` 加 jimeng 分支 + `dreamina_health`/`dreamina_login`。

- **即梦 dreamina provider 实现 Phase 2（2026-07-23）**：落地 [AI-PROVIDERS.md](AI-PROVIDERS.md) §5.3/§9 Phase 2——`codex_create_image` 传 `provider="jimeng"` 即走即梦出图、codex 行为不变。新建 [codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs) `DreaminaCliProvider` 实现 `GenProvider`：spawn `dreamina text2image`（无参考图）/ `image2image --images`（有参考图）+ `--ratio`/`--resolution_type=2k`/`--generate_num=1`/`--poll=120` → 解析 stdout JSON 拿 `submit_id`（**pretty 多行格式，整体解析非按行**，见踩坑）→ `dreamina query_result --download_dir=<temp>/bowerbird-dreamina-<ulid>` 下载 → `walk_images` 扫图返 command 层 `ingest_generated` 入库 source=jimeng、`temp_dir` ingest 后删；`resolve_dreamina_binary`（对称 codex：env→`%USERPROFILE%\bin\dreamina.exe`→PATH→Unix `~/.local/bin`）+ `dreamina_command`（CREATE_NO_WINDOW，dreamina 原生 exe 无需 cmd.exe shim）+ `dreamina_home`（`~/.dreamina_cli`）；`capabilities={chat:false,caption:false,generate:true}`、`run()` 报 Unsupported（即梦无文本能力）。新建 [commands/jimeng.rs](apps/desktop/src-tauri/src/commands/jimeng.rs) `dreamina_health`（binary + `credential.json` + version ping）/ `dreamina_login`（spawn `login --headless` 透传 `dreamina://login` 事件，in-app OAuth UI 留 Phase 3）+ lib.rs 注册；[mod.rs](apps/desktop/src-tauri/src/codex/mod.rs) jimeng 分支接通。配套：[types.rs](apps/desktop/src-tauri/src/codex/types.rs) `CodexRequest` 加 `ratio`（即梦读拼 `--ratio`、codex 忽略仍从 instruction 注入）+ `GenOutcome` 加 `temp_dir`（即梦下载目录 codex None）；[ingest.rs](apps/desktop/src-tauri/src/core/ingest.rs) `ingest_generated` 加 `source_tag` 参数（取代硬编码 "codex"，按 provider 传）；6 处 `CodexRequest` 构造补 ratio；前端 [api.ts](apps/desktop/src/lib/api.ts)+[store.ts](apps/desktop/src/store.ts) 透传 provider（默认 None=codex，**切换 UI 留 Phase 3**）。**多轮首轮 only**（续轮 image2image 传上一轮图留后续，需前端协议 + session 语义）。**端到端实测通过**（Win11 + maestro，带参考图 image2image 出图入库 source=jimeng + codex 自动命名）。关键约定 1 待存档演进。详见踩坑「dreamina stdout pretty JSON」。

**测试：** `cargo test` 51 通过（导入/去重/多图过滤 + 扩展下载格式识别/本机内网 URL 拒绝 + assemble_pack + FTS5 文件名搜索 + analyses 读写 + caption sections 解析 + list_prompted_assets + 采集即命名 `clean_name`/`split_name_and_desc` + caption 共享模块 + 生成图取图快照差分 `list_new_generated` + 标签 `get_or_create`/`set_asset_tags` source 隔离 + `tag:` 智能查询 + `list_tags_with_count` + 色板 `hex_to_bucket`/`colors_to_buckets` + `asset_colors` 幂等/folder 过滤 + 会话 prompt 链 `generation_prompt_chain` + 生成图 prompt 维度识别 `extract_dim_sections`/`build_generation_caption` + 同流程合并 `collapse_generation_groups`/`list_generation_group` + 收藏夹 `collection_roundtrip_and_guards` + 生成历史回看 `generation_history` + 用途 preset `preset_crud_roundtrip`）；前端 `tsc --noEmit` 通过；扩展三份 `content.js` / 两份 `background.js` 均通过 `node --check`，三份 Manifest 均通过 JSON 解析。

**未开始 / 待办：**
- **多模态看图 spike — 已接通（codex CLI），非待办**：四路径实测后定型为唯一 `CodexCliProvider`（`codex exec --image`，ChatGPT 订阅，绕过 API quota）；Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线已全部移除（`codex/` 仅 `codex_cli.rs` + `types.rs` + `mod.rs`），反推会话回看走 `open_codex_session`（`codex resume <thread_id>`）。详见关键约定 1 + 踩坑「多模态看图四条路径实测」。旧 provider 切换 / in-app apikey 配置已删（`config.json` / 后端 `Settings` 模块 / `base64` 依赖随路线移除）；**`SettingsDialog` / ⚙️ 设置按钮 2026-07-18 同名复活为「整库运维面板」**（codex 状态检测 / 重建色板 / 智能归类全部，[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx)，Toolbar ⚙ 入口、约定 13 全屏 Modal 形态），与 apikey 无关。`codex_health` 命令保留作离线/无账号降级探测（约定 7）。
- **Phase 4 剩余**：FTS5 当前仅同步 `name`；`prompt_body/annotation/ocr` 的同步（搜提示词正文等）待做。**tags 已可检索**——走 `tag:<name>` 智能文件夹 JOIN（不进 FTS，见 P2 设计）；codex 批量自动打标已通（采集即归类 + `reclassify_all`）。
- **Phase 5 剩余**：用户已简化为只做反推（caption）；OCR/版式/关键词/灵感卡模板集 + 批量分析队列留待需要时再做。
- PSD 预览（计划 §1.3 P1）暂未做（SVG/视频已覆盖；psd crate 与 image 0.25 兼容未验证，留后续）。
- **创作板 UI — 已实现（见「已完成」，非待办）**：原「占位填空 + 维度下拉」设计演化为「真实 prompt 文本编辑器 + `@` 选图 + 维度 chips 来自图片 sections」（2026-07-18 重写为 ProseMirror）；图像生成亦已通。
- **图像生成（⑥）— 已端到端打通（2026-07-08，见「已完成」，非待办）**：创作板→codex imagegen→真流式回显→入库进瀑布流→多轮修改（resume）→生成图标记（角标/筛选/来源/命名）整条打通。**剩余**：`generations` 表落库（开发计划 §4.2 原移除；目前用 `analyses(kind=generation_meta)` 存来源元信息，够用）。

**里程碑：** 内部 Alpha（Phase 1 ✅）→ 公开 Beta 0.5（Phase 3 ✅）→ 1.0 正式版（Phase 5 简化版 ✅，真实 VLM 看图 spike 后转正）→ **1.x 生成（⑥，codex imagegen 端到端实测跑通 + 入库 + 标记，2026-07-08）**。

---

## to-do

[x] 允许用户通过codex一次生成多张图片（codex无疑能生成多张图片，但bowerbird需要增加在一次发送内接收多张返回的图片的功能）— 2026-07-17 完成（接收侧本就 Vec 全链路；瓶颈是首轮 instruction 硬编码「一张」，改为 prompt 驱动数量，详见「目前进展」）
[x] 生成结果历史，允许用户像回看对话一样回看某个图片的生成结果界面，能看到生成时的prompt，并且能提出对该图片的修改意见（给codex）— 2026-07-17 完成（后端 `generation_history` 按会话重建各轮 prompt+图；前端复用 GenerationPanel，详情页「回看生成对话」入口 load 历史会话 + 续轮 resume，详见「目前进展」）
[x] 创作板新增”用途”功能：允许用户将某段提示词及参考图（可选）登记为一个用途，若选择了某用途，那创作时就会首先加载其代表的提示词和参考图。— 2026-07-17 完成（用途 = preset：[0009_presets.sql](apps/desktop/src-tauri/sql/0009_presets.sql) + `createPreset`/`updatePreset`/`deletePreset` CRUD；CreationBoard 用途区选中即加载、可编辑/删除；生成面板「📋 复用」可把某轮 prompt 登记为用途，详见「已完成：回看后复用 prompt / 登记为用途」）
[x] 允许用户在瀑布流中拖拽素材来放入某个文件夹 — 2026-07-18 完成（Thumb 拖拽源 + FolderRow 放置目标仅普通文件夹；payload 走模块变量避开 WKWebView 自定义 MIME strip；后端 move_assets_to_folder 加 emit 刷新，详见「目前进展」）
[x] 改变生成图的点击行为，目前点击之后会跳转默认浏览器打开本地图片。但应该要的是就是跟常见的图片交互一样，点击后放大展示。— 2026-07-18 完成（生成图点击改 app 内 Lightbox 全屏放大，跨轮 ←/→ 切换，详见「目前进展」）
[ ] 新增功能：允许用户上传文件（如品牌全案）以生成合理的视觉系统规范——可以作为用途。
[ ] 记录素材被创作板调用（参考）的次数。然后构思自学习功能应该提供什么具体的体验（此处先输出策略文档）。

## 关键约定

> 团队已定的、不轻易改的决策。变更此处**必须同步** [CLAUDE.md](CLAUDE.md) 的「Architectural constraints」一节。详细论证见 `Bowerbird开发计划.md`。

1. **AI 全外包，不自建模型**：所有理解/分析（VLM 描述、OCR、版式、关键词、灵感卡）走 headless codex 子进程；**图像生成（⑥）多 provider 可切换**（2026-07-23 Phase 1+2 落地）——抽象 `GenProvider` trait（原 `CodexProvider`，[codex/mod.rs](apps/desktop/src-tauri/src/codex/mod.rs)），两实现：`CodexCliProvider`（默认，`codex exec --image`，ChatGPT 订阅，真正看图 + 出图）/ `DreaminaCliProvider`（即梦官方 dreamina CLI，OAuth + 积分，**仅出图**，[codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs)）；命令层 `codex_create_image` 的 `provider` 参数选（None=codex），工厂 `resolve_gen_provider`。**理解类（反推/命名/归类）仍只走 codex**（即梦无文本能力，§4.3）。**禁止** ONNX / CLIP / 本地扩散 / 本地 VLM / tesseract / 向量等任何本地模型；Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线均已移除（详见踩坑「多模态看图四条路径实测」）。详见 [AI-PROVIDERS.md](AI-PROVIDERS.md)。
2. **v1 做图像生成（⑥）**（2026-07-06 决策，**覆盖开发计划 v1.2 §1.4「不做生成」**）：在原五件套（收集/浏览/搜索/整理/分析）基础上加入生成。生成走 codex CLI 的 tool-use（codex 内置 `imagegen` 技能，不自建扩散模型）。**已端到端打通（2026-07-08）**：codex exec 触发 `imagegen` 画图，产物落 `~/.codex/generated_images/<thread>/`（路径不在 JSONL 一等字段，靠**快照差分**取图，详见踩坑）；创作板生成 → 真流式回显 → `ingest_generated` 入库为正式资产（`source=codex`、不算 pHash 不去重、进瀑布流）→ 多轮 `codex exec resume` 迭代修改 → 生成图标记（✨ 角标 / `source:codex` 筛选 / `generation_meta` 来源追溯 / 自动命名）。**生成图 caption = 从生成 prompt 识别 `【维度】：正文` 片段落库**（不调 codex 反推，2026-07-10；原文仍存 `generation_meta`，详见「已完成」）；**生成 UI 独立为 `GenerationPanel` 覆盖层**（与创作板解耦，状态在 store）；**同流程合并**（2026-07-10）：同一 `session_id` 的过程图入库时写 `assets.generation_session_id`，瀑布流 `collapse_generation_groups` 每组只显最新一张，缩略图/详情页可左右切换过程图（详情页支持 ←/→ 键）。**一次生成多张（2026-07-17）**：接收侧本就是 Vec 全链路、无需新增能力；数量完全由用户 prompt 驱动（不加 UI 控件），首轮 instruction 不再硬编码「一张」（改「张数以提示词为准」），续轮 resume 天然支持，首轮多张同 session_id 合并成一组。**剩余**：`generations` 表落库（开发计划 §4.2 原移除；目前用 `analyses(kind=generation_meta)` 存来源元信息，够用）。
3. **检索用 FTS5 全文**（`trigram` 起步；**当前仅 `name` 已同步**，`prompt_body`/`annotation`/`ocr` 待 Phase 4）。pHash **仅用于采集去重**，不做以图搜图；无 CLIP 语义/向量搜索。**标签/颜色不走 FTS**——`tag:<name>` 走 `list_assets_smart` JOIN（P2）、颜色走 `asset_colors` JOIN（P3）。
4. **性能目标：千图级流畅**，不追求万图秒开（据此决定虚拟滚动/缓存不要过度优化）。
5. **codex 调用走独立 Worker + 持久化 SQLite 任务队列**（可取消 / 重试 / 并发上限）；单个 codex 子进程崩溃/超时不得拖垮主进程与资源库。
6. **核心数据是「图片 ↔ 提示词映射」**（`asset_prompts`，`role`: main / ref / desc）—— 连接素材管理与 AI 编排的枢纽，所有 P1→P3 功能围绕它展开。
7. **离线/无账号降级**：未配置 codex 时，分析类功能置灰并提示，而非崩溃。
8. **浏览/批量双模式交互**：默认浏览模式（点图 → 详情页覆盖主区：大图 + 元信息 + PromptEditor + 来源外链）；Toolbar「批量管理」进入多选模式（点图 = 切换选中，含取消），BatchBar 提供「删除 / 移入新文件夹 / 批量生成提示词」。详情页大图走 `store_path`（原图全尺寸），来源外链用 `source_url`（`@tauri-apps/plugin-shell` 的 `open` 经系统浏览器打开，`shell:allow-open` 已授权）。

9. **创作板 = 核心交互的 UI 形态**（2026-07-06 定稿，2026-07-08 实现；设计稿 [桌面端UI设计.html](桌面端UI设计.html)）：右侧面板的「真实 prompt 文本编辑器」——用户像跟 AI 输入 prompt 一样自由书写，**插入参考图两类入口**（2026-07-18 重写为 ProseMirror 后）：① 创作板打开时直接点瀑布流任意图（默认）→ 在**当前光标处**插 image chip（取代旧版末尾追加）；② 输入 `@图名` + 空格/回车/标点 → 自动识别为 image chip（`@` = mention 前缀，asset 名贪心最长 + 边界检查匹配，失败则 `@文本` 保持纯文本）；载入（`board-load-prompt`）/粘贴含 `@图名` 的 prompt 文本时整段解析转 chip。两者都插「缩略图 + 图名」原子 chip 并焦点回编辑框；图片后浮现维度 chips，点击插入蓝色下划线维度 token，**面板常驻可连续点多个维度**（同图的光影/类型/氛围… 不用重新 `@` 选图；Esc / ✕ 收起）；手输维度按空格/回车/标点自动识别转 token。底部「确认生成」把图片 token 按所选维度展开为 `@图名 的【维度】：section 正文`（多维度各自取片段，详见踩坑「多维度序列化」）；**未选维度的图片 token = 纯参考引用**（只序列化 `@图名`，图经 reference_images 传给 codex、不灌整段 caption，支持「将@B 变为@A 的调性」里 @B 仅作参考图；点图也不再自动插「的」，由维度展开自带或用户手输）。+ 参考图集 → 发 codex CLI（优化 / 扩写 / 生成；**生成已端到端打通，2026-07-08**，见约定 2）。**维度 chips 不来自预置 `prompts(kind=template)`**，而是按图动态生成（取该图反推 `sections` 标题，见约定 10）；早期 `0003_templates.sql` seed 的 template 行已被 `0004_templates_clear.sql` 清空（迁移历史保留，net DB 无 template 行）。入口为 Toolbar 右侧「🎬 创作板」按钮，非批量管理模式。

10. **反推 caption 维度片段存储约定**（2026-07-07）：不新增 `asset_dimension_prompts` 表；反推仍是分析数据，落 `analyses(kind=caption).payload`。payload 兼容旧 `{text}`，新版包含 `schema_version/text/instruction/session_id/sections/dimensions/parse_status`；`sections` 是模型实际输出的全部维度（按文档顺序，动态、不固定），`dimensions` 是经别名表归一化的五大标准键（`composition/light/palette/action/mood`，用于 `parse_status` 判定）。**创作板维度下拉按图动态生成**：取该图 `sections` 的标题作为可选项，`@图片 + 维度` 只注入对应 section 正文，缺失时回退整段 caption。**反推任务全局串行**（2026-07-08）：store 维护单槽队列（`describeQueue` / `pumpDescribe`），同一时刻只调一次 `codex_describe_asset`（后端 `DESCRIBE_CANCEL` 单例），连点 N 张图排队执行、各自在缩略图角标可见可取消（详见踩坑「连点反推前一张被静默 kill」）。

11. **采集即命名 + 基础/反推分层**（2026-07-08）：图片进库即后台调一次 codex（[core/autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs) `spawn_auto_analyze`），一次产出「≤8 字命名 → `assets.name`」+「基础 caption → `analyses(kind=caption)`」。**基础分析刻意不带维度**——指令只要求「描述 + 取名」（首行命名、第二行描述），caption 多为 `raw_fallback`（`sections`/`dimensions` 空）；**维度结构交给后续手动「反推」带来**。反推默认指令预置**带维度模板**（11 个 `- **维度名**` 段落：类型/ratio/构图/光影/色调/主体动作/材质·笔触/背景/氛围·情绪/反推提示词/负面提示词，见 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) `DEFAULT_DESCRIBE_PROMPT`；localStorage 记忆、旧默认「请描述这张图片」自动迁移到新模板），该 `- **维度名**` 格式正中 `caption::parse` 的 section 识别 → 反推产出的 caption sections 齐全，创作板维度 chips 随之丰富。**反推累加**：每次 `INSERT` 新 caption 行（不覆盖、不改 `name`），详情页列全部 caption 卡片（可单删），创作板取最新一条 caption 的 sections 当维度 chips。命名硬上限 8 字（`clean_name` 截断，即便指令未提 8 字）；改名走 `update_asset_name`，命中 FTS5 触发器自动重建搜索索引。**采集即同时自动归类**（2026-07-09 续）：同一次 codex 调用还产出 `[[CAT: 类别]]` 哨兵 → 写 auto tag（受控词表，仅当该图尚无 auto tag 防顶手改），详见 P2 标签。

12. **收藏夹是多对多、独立于「文件夹位置」的维度（2026-07-10）**：现有 `assets.folder_id` 是 1对1 位置语义（素材只在一个文件夹，`move_assets_to_folder` = 换位置）；**收藏夹另起一套多对多**——`asset_collections(asset_id, folder_id, created_at)` 关联表 + `folders.kind='collection'` 标识（与 `asset_tags`/`asset_colors` 多对多表对称）。一个素材可同时收进多个收藏夹、`folder_id` 原位置不变。`folders.kind` 三态：`folder`（位置容器）/ `smart`（智能查询）/ `collection`（收藏夹）。入口：详情页 header ☆/★ 按钮（行内 panel 选已有 / 新建）。**凡按 kind 过滤「可放入 `folder_id` 的容器」处，必须正向判 `kind==='folder'`**（排除式 `kind!=='smart'` 会漏掉 collection → 收藏夹污染 folder_id，见踩坑）。

13. **首个 Modal 形态：全屏遮罩（2026-07-10）**：项目此前**无 Dialog/Modal/`fixed` 先例**——唯一的「盖住主区」覆盖层 GenerationPanel 用 `absolute inset-0 z-10`（只盖主区、不盖 Toolbar/Sidebar、无 backdrop）。首启引导页 [CodexOnboarding.tsx](apps/desktop/src/components/CodexOnboarding.tsx) 新立全屏模态：`fixed inset-0 z-50`（盖住整个 app）+ `bg-black/60` 半透明遮罩 + 居中卡片（`bg-panel border border-edge rounded-lg`，项目首个用 box-shadow 的浮层）。组件**自管可见性**（不满足条件直接 `return null`），挂载点 `App.tsx` 最外层 div 内、`<Toolbar>` 前，**无条件渲染** `{<CodexOnboarding />}`；「已看过」flag 不入 store（项目零 zustand persist），照 [AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) 直接读写 `localStorage`（key 前缀 `bowerbird.`）。后续再加 Modal/Dialog/确认框 沿用此形态。

---

## 踩坑记录

> 记录已踩过的坑、根因与绕过方案，避免重复。

条目格式：
```
### <简短标题>（YYYY-MM-DD）
- 现象：
- 根因：
- 解决 / 绕过：
- 相关文件：
```

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
- 解决：在 [DetailPanel.tsx](apps/desktop/src/components/DetailPanel.tsx) 顶部加「删除所选」入口（单选/多选通用，两段式确认——避开 Tauri 2 WKWebView 对 `window.confirm` 的拦截）。
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
- 相关文件：[codex/openai.rs](apps/desktop/src-tauri/src/codex/openai.rs)、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)。

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

### pnpm 11 默认忽略 esbuild 构建脚本 → tauri dev 前置依赖检查失败（2026-07-17）
- 现象：`pnpm tauri dev` 报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5`，pnpm 11「跑命令前的依赖检查」失败，dev 不启动。
- 根因：pnpm 11 默认拒绝跑未批准的依赖 postinstall；`pnpm-workspace.yaml` 虽配了 `onlyBuiltDependencies: [esbuild]`（只是「允许」≠「已跑」），但 esbuild 的 postinstall 从未真正执行过，pnpm 一直记它处于 ignored 状态 → `verify-deps-before-run` 检查失败。
- 解决：`pnpm rebuild esbuild`（让 postinstall 真正执行一次，清除 ignored 状态）。
- 附：`pnpm-workspace.yaml` 里还有个无效的 `allowBuilds: esbuild: set this to true or false`（非 pnpm 配置键、值是占位字符串），建议删，真正生效的是 `onlyBuiltDependencies`。
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

### Windows 前端 overrides 整文件覆盖与主项目分叉 → 出包 tsc 失败（2026-07-20）
- 现象：`Windows/build.ps1 -Clean` 出包时 `tsc --noEmit` 报 12 处错——[AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx) / [CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) / [GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) / [SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 引用 `State` 上不存在的 `presets` / `viewGenerationHistory` / `colorRebuild` / `genRefAssets` / `reusePromptToBoard` 等字段。
- 根因：`Windows/overrides/apps/desktop/src/` 的 `store.ts` / `App.tsx` / `Toolbar.tsx` / `WelcomePanel.tsx` 是早期为加 Windows 专属功能（扩展连接状态、采集提示、环境状态面板）从主项目分叉出的**整文件覆盖**副本。主项目 store 其后大幅演进（presets/activePresetId/reloadPresets 进 store、colorRebuild 进 store、删 boardPickMode、startGeneration 改签名为 `(prompt, references: Asset[], ratio?)`、viewGenerationHistory/reusePromptToBoard 新增），override 副本没跟上。`prepare.ps1` 用 `robocopy overrides .work /E` 把这些旧副本整文件覆盖回 `.work` → `.work` 里「主项目新组件 + override 旧 store」类型对不上。这是「dev 在 Windows 检测不到 codex」同一条教训的又一次复现：**整文件覆盖式 override 与主源码演进必然分叉**。
- 解决：把四个 override 的差异化功能（`extensionConnected` / `collectedNotice` + 环境状态展示）并入主项目源码——[store.ts](apps/desktop/src/store.ts) 加两字段+setter、[App.tsx](apps/desktop/src/App.tsx) 加 `collect://extension-connected` 与 `library://assets-changed`(payload.name) 两 listener、[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx) 环境状态区加「浏览器扩展」连接行、[Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx) 加「已采集：xxx · 查看」提示条——然后删掉这四个 override（`.work` 直接用主项目源码）。Rust overrides（ingest/ws_server + 已并入的 codex）不受影响、保留。
- 教训：overrides 只作平台适配过渡，差异化功能应直接进主源码、合并后即删；**整文件覆盖**会在主源码演进时静默分叉，下次出包才以 tsc 失败暴露（dev 跑纯主源码测不出）。剩余 overrides 仅留 Rust 层（平台二进制/路径差异），前端零 override。
- 相关文件：[store.ts](apps/desktop/src/store.ts)、[App.tsx](apps/desktop/src/App.tsx)、[components/SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx)、[components/Toolbar.tsx](apps/desktop/src/components/Toolbar.tsx)、[Windows/prepare.ps1](Windows/prepare.ps1)。

### codex 生成失败提示被双重藏匿（2026-07-23）
- 现象：创作板发 codex 生成失败时，生成面板只显示「尚未生成。在创作板组稿后点『✓ 发送 codex 生成』。」，用户看不到失败原因、也无重试入口。后端其实返回了可读错误（codex 退出码 + stderr 前 500 字，经 `AppError` 序列化成纯字符串到前端）。
- 根因：前端双重藏匿——① `genHandleError` 把 `[error: msg]` 塞进 `genStreaming` 的**同时删掉失败的占位轮**（设计初衷是避免空轮留在时间线）；② `GenerationPanel` 的 `genStreaming`（含错误）**只在 `genTurns` 非空时渲染**。首发失败 → 占位轮被删 → `genTurns=[]` → 命中空态文案 → 错误永不可见。
- 解决 / 绕过：失败不再「删轮 + 藏 streaming」，改为挂到那一轮——`GenTurn` 加 `error` 字段，未出图的占位轮记 error 成「失败轮」（时间线可见 + 可重试），不追加 streaming 避免与失败态重复。两个守卫：① 取消（「已取消」）仍删轮不留红字（取消非失败）；② **已出图后的后置失败**（done 已到、meta/caption 写库失败）最后一轮已有图，错误降级进 streaming、绝不把成功出图轮误标失败。续轮失败重试先移除失败轮再 resume，避免同 prompt 编号递增的重复轮。两条错误路径（invoke reject 走 `genHandleError` / chunk Error 走 `applyGenChunk`）统一经 `applyGenError`。
- 相关文件：[store.ts](apps/desktop/src/store.ts)（`applyGenError` / `genHandleError` / `retryLastGenTurn`）、[GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx)（`TurnView` 失败态）、[lib/types.ts](apps/desktop/src/lib/types.ts)（`GenTurn.error`）。

### dreamina stdout 是 pretty JSON（多行），不能按 JSONL 行解析（2026-07-23）
- 现象：Phase 2 jimeng provider `parse_submit_id` 报「dreamina 提交输出未含 submit_id」，但 stdout 里明明有 `submit_id`（dreamina 实际出图成功，`gen_status=success`）。
- 根因：dreamina CLI 输出**格式化（pretty）JSON**——每字段一行带缩进（`{\n  "submit_id": "...",\n  ...}`），不是 codex 那种单行 JSONL。`parse_submit_id` 照搬 codex JSONL 习惯用 `stdout.lines()` 逐行找 `{` 开头——pretty JSON 只有第一行是 `{`（不完整，serde 解析失败），其余字段行（`"submit_id": ...`）不以 `{` 开头被跳过 → 解析不到。
- 解决：整体解析 stdout 为一个 JSON 对象——`stdout.find('{')` 取首个 `{` 起，`serde_json::Deserializer::from_str(&stdout[start..]).into_iter().next()` 流式取首个值（容忍前导提示行 + 尾随文本），不按行。
- 教训：新 CLI 输出格式不能假设（codex JSONL vs dreamina pretty JSON）。spike 时看到多行但手动读 submit_id 没踩坑，写代码按行解析才暴露——spike 应顺手验证「代码打算用的解析方式」对不对。
- 相关文件：[codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs) `parse_submit_id`。
