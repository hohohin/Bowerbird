# PROJECT.md

本文件是项目的**活文档**（living doc），记录说明、进展、约定与踩坑。权威的完整设计见 `Bowerbird开发计划.md`；面向 Claude Code 的工作规则与索引自见 [CLAUDE.md](CLAUDE.md)。

---

## 项目说明

**Bowerbird（园丁鸟）** —— 为 AI 图像创作服务的、本地优先的「提示词 + 参考图」素材库与编排工作台。形态：Tauri 2 桌面应用 + 浏览器扩展。

- **核心交互**：**创作板**（拟文本编辑器）—— 选图 + 选维度下拉，所见即一段中文句子；每个选项 / 缩略图背后映射真实提示词片段，底部「确认生成」拼出完整 prompt + 参考图发 codex（优化 / 扩写 / 生成）。用户全程不写一字提示词。设计稿见 [桌面端UI设计.html](桌面端UI设计.html)。
- **范围**：v1 覆盖六大工作流 —— 收集 / 浏览 / 搜索 / 整理 / 分析 / **生成（⑥）**（2026-07-06 决策扩展，覆盖开发计划 v1.2 §1.4「不做生成」，详见关键约定 2）。
- **定位**：不是「复现 Eagle」，而是把散落的灵感图片组织成可复用的「提示词 + 参考图」资产并交给 AI。
- **哲学**：素材与提示词 100% 本地（Local-First）；AI 推理与生成经用户自有的 codex CLI（可能联网）。

完整定位、范围、技术栈、数据模型、Roadmap 见 `Bowerbird开发计划.md`（v1.2，2026 年 7 月）。

---

## 目前进展

> 更新时间：2026-07-06

**当前阶段：1.0 功能路径打通 + v1 范围扩展到生成（⑥）+ 创作板 UI 设计定稿。** 详情页「反推」真正看图（codex CLI + gpt-5.5，ChatGPT 订阅，绕过 API quota）；FTS5 文件名搜索可用；**创作板（拟文本编辑器）设计完成**（[桌面端UI设计.html](桌面端UI设计.html)），代码待建；**生成（⑥）纳入 v1**，待 spike 验证 codex CLI 的画图能力。

**源码树（按开发计划 §7）：** `apps/desktop/{src, src-tauri}`、`apps/extension/`、`packages/shared/`。常用命令：`pnpm install`、`pnpm tauri dev`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。

**已完成：**
- **Phase 0（脚手架）**：monorepo（pnpm workspace）、Tauri 2 + React 18 + Vite + Tailwind + Zustand、`rusqlite`(bundled, FTS5) + 迁移（§4.2 全表）、`CodexProvider` trait + Mock + ClaudeCode（默认禁用）、SQLite 任务队列骨架。
- **Phase 1（P0 MVP）**：导入流水线（probe → 缩略图 → dHash → 去重 → 入库）、资源库 CRUD、瀑布流（CSS columns + 缩略图懒加载）、侧栏、浏览器扩展采集（MV3 + WS `127.0.0.1:39871` + 下载入库）。
- **Phase 2（P1）**：K-Means 提色（LAB）+ 主色条 + 颜色筛选、多格式预览（SVG 前端直渲染 / 视频 ffmpeg 抽帧）、智能文件夹（`source:`/`ext:` 过滤）。
- **Phase 3（核心枢纽）**：prompts/asset_prompts CRUD、提示词编辑器（绑定 main/ref/desc）、**选图组创作包 `assemble_pack`**、创作包导出（prompt + 参考图清单）、`ClaudeCodeProvider` 真实接入（`claude -p --output-format stream-json` 流式）+ 前端 event 流式呈现。
- **桌面端 UX 重构（2026-07-05）**：浏览/批量双模式（默认浏览：点图→详情页；「批量管理」进入多选）；详情页（大图 `store_path` + 元信息 + 提示词板块 + 来源外链）；`move_assets_to_folder` 命令；`codex_generate_prompt_for_asset` 命令（Mock 走通，真实多模态待 Phase 5 spike）。瀑布流缩略图抖动已修（`aspect-ratio` 占位）。
- **Phase 4（P2 检索 · 部分）**：FTS5 同步触发器（`0002_fts.sql`：assets INSERT/UPDATE/DELETE → `library_fts`）+ 存量回填；`search_assets` 命令（trigram match，按 `rank`）；Toolbar 搜索框 + 清除；App 在 `searchQuery` 非空时切到搜索结果。
- **Phase 5（P3 拆解分析 · 简化版）**：`analyses` CRUD + `codex_describe_asset` 命令（**反推：固定发"请描述这张图片"**，结果入 `analyses(kind=caption)`）；详情页「反推」按钮 + caption 卡片呈现。按用户要求**仅做反推**，未做 OCR/版式/灵感卡/关键词模板集。

**测试：** `cargo test` 8 通过（导入/去重/多图过滤 + assemble_pack + **FTS5 文件名搜索 + analyses 读写**）；前端 `tsc --noEmit` 通过。

**未开始 / 待办：**
- **关键 spike（多模态看图）已接通 — codex CLI 路线**：实测后确定 `codex exec --image` 是当前唯一真正看图的路径（走 **ChatGPT 订阅**，绕过 OpenAI API quota；国内 `chatgpt.com` WS reset 但 codex 自动回退 HTTPS，慢但成功）。`CodexCliProvider`（[codex/codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)）spawn `codex exec --skip-git-repo-check --image <path>`，stdin 喂指令，解析 `\ncodex\n<answer>\ntokens used`。**三条备选路线均不通**（已验证）：① `claude -p` 无头把图传 CDN 但不传给模型（"unable to view"）；② DeepSeek HTTP 不接受 OpenAI 的 `image_url` variant（`unknown variant image_url, expected text`）；③ OpenAI HTTP 受账户 `insufficient_quota` 限制。Mock / ClaudeCode（`claude -p`）/ DeepSeek / OpenAI HTTP 路线均已验证看图不通或冗余，**已全部移除**（`codex/` 仅剩 `codex_cli.rs` + `types.rs`）；详情页「反推」/ 创作包「发 codex 优化」/ 批量生成提示词统一走 codex CLI，不再有「真实看图」切换或 in-app apikey 配置（`SettingsDialog` / ⚙️ 按钮 / `config.json` / 后端 `Settings` 模块 + `codex_health` 命令 + `base64` 依赖一并删除）。修复了本地 codex CLI（`npm install -g @openai/codex` 0.142.5，之前平台二进制 ENOENT）。`gpt-image-2` 是生成模型，不适合描述，已排除。
- **Phase 4 剩余**：FTS5 当前仅同步 `name`；`tags/prompt_body/annotation/ocr` 的同步（搜提示词正文等）+ codex 批量自动打标待做。
- **Phase 5 剩余**：用户已简化为只做反推（caption）；OCR/版式/关键词/灵感卡模板集 + 批量分析队列留待需要时再做。
- PSD 预览（计划 §1.3 P1）暂未做（SVG/视频已覆盖；psd crate 与 image 0.25 兼容未验证，留后续）。
- **创作板（拟文本编辑器）—— 核心交互 UI**（2026-07-06 设计定稿）：右侧面板的「拟文本编辑器」，用户选缩略图 + 选维度下拉组成一句中文，每个控件背后映射 prompt 片段，底部「确认生成」拼完整 prompt + 参考图发 codex。底层 `assemble_pack` 已就绪；前端编辑器控件（chips / 虚线占位 / 维度→prompt 映射表；映射复用 `analyses(kind=caption)` 与 `prompts(kind=template)`）待新建；现 `PackPanel.tsx` 未挂载，将按此构思重做。设计稿 [桌面端UI设计.html](桌面端UI设计.html)。
- **v1 范围扩展：图像生成（⑥）**（2026-07-06 决策）：原计划 v1 不做生成，现纳入。生成走 codex CLI 的 tool-use（自行调用画图工具），不自建扩散模型。**关键假设待 spike**：codex CLI（gpt-5.5 / ChatGPT 订阅）能否在 `codex exec` 流程里触发图像生成并取回产物（路径 / 格式 / 落库）。落库需补回 `generations` 表（开发计划 v1.2 §4.2 原移除，与本次决策冲突，需后续同步开发计划）。UI 上生成由创作板底部「确认生成」按钮触发。

**里程碑：** 内部 Alpha（Phase 1 ✅）→ 公开 Beta 0.5（Phase 3 ✅）→ 1.0 正式版（Phase 5 简化版 ✅，真实 VLM 看图 spike 后转正）→ **1.x 生成（⑥，创作板 + codex 画图 spike 后转正）**。

---

## 关键约定

> 团队已定的、不轻易改的决策。变更此处**必须同步** [CLAUDE.md](CLAUDE.md) 的「Architectural constraints」一节。详细论证见 `Bowerbird开发计划.md`。

1. **AI 全外包，不自建模型**：所有理解/分析（VLM 描述、OCR、版式、关键词、灵感卡）**与图像生成**均走 headless codex 子进程（抽象 `CodexProvider` trait，**唯一实现 `CodexCliProvider`** = `codex exec --image`，走 ChatGPT 订阅认证，真正看图）。**禁止** ONNX / CLIP / 本地扩散 / 本地 VLM / tesseract / 向量等任何本地模型（生成亦不自建扩散模型，由 codex 的 tool-use 调用外部画图工具）。Mock / ClaudeCode（`claude -p`）/ DeepSeek / OpenAI HTTP 路线均已验证看图不通或冗余，**已全部移除**（详见踩坑「多模态看图四条路径实测」）。
2. **v1 做图像生成（⑥）**（2026-07-06 决策，**覆盖开发计划 v1.2 §1.4「不做生成」**）：在原五件套（收集/浏览/搜索/整理/分析）基础上加入生成。生成走 codex CLI 的 tool-use（自行调用画图工具），不自建扩散模型。**关键假设待 spike**：codex CLI 能否在 `codex exec` 流程里触发图像生成并取回产物（路径 / 格式 / 落盘）；未实测前生成功能视为未通。落库需补 `generations` 表（开发计划 §4.2 原移除）。
3. **检索用 FTS5 全文**（文件名 / 标签 / **提示词正文** / 描述 / OCR，`trigram` 起步）。pHash **仅用于采集去重**，不做以图搜图；无 CLIP 语义/向量搜索。
4. **性能目标：千图级流畅**，不追求万图秒开（据此决定虚拟滚动/缓存不要过度优化）。
5. **codex 调用走独立 Worker + 持久化 SQLite 任务队列**（可取消 / 重试 / 并发上限）；单个 codex 子进程崩溃/超时不得拖垮主进程与资源库。
6. **核心数据是「图片 ↔ 提示词映射」**（`asset_prompts`，`role`: main / ref / desc）—— 连接素材管理与 AI 编排的枢纽，所有 P1→P3 功能围绕它展开。
7. **离线/无账号降级**：未配置 codex 时，分析类功能置灰并提示，而非崩溃。
8. **浏览/批量双模式交互**：默认浏览模式（点图 → 详情页覆盖主区：大图 + 元信息 + PromptEditor + 来源外链）；Toolbar「批量管理」进入多选模式（点图 = 切换选中，含取消），BatchBar 提供「删除 / 移入新文件夹 / 批量生成提示词」。详情页大图走 `store_path`（原图全尺寸），来源外链用 `source_url`（`@tauri-apps/plugin-shell` 的 `open` 经系统浏览器打开，`shell:allow-open` 已授权）。

9. **创作板 = 核心交互的 UI 形态**（拟文本编辑器，2026-07-06 定稿；设计稿 [桌面端UI设计.html](桌面端UI设计.html)）：右侧面板呈现一段中文句子（如「我想要一张 `[调性▾]` 像 `[缩略图]` 的，`｛人物动作｝`，`｛构图｝`… 的图片」），用户**选缩略图 + 选维度下拉**填空，全程不写提示词。每个控件背后挂真实 prompt 片段：① **维度聚合**——「调性」= 光影/色调/光比/空间感 等子维度打包成一个下拉；② **缩略图** = 该图 codex 反推出的提示词（复用 `analyses(kind=caption)`）；③ **维度下拉选项** = 预置 prompt 片段（存为 `prompts(kind=template)`）。**虚线占位项**（`｛人物动作｝`…）点击即升级为「`[维度▾]` 像 `[缩略图]`」完整子句。底部「**确认生成**」= `assemble_pack` 拼完整 prompt + 参考图集 → 发 codex CLI（优化 / 扩写 / 生成）。底层 `assemble_pack` 已就绪，前端编辑器控件待新建；现 `PackPanel.tsx` 写好但未挂载，将按此构思重做。

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
- 相关文件：[codex/openai.rs](apps/desktop/src-tauri/src/codex/openai.rs)、[core/settings.rs](apps/desktop/src-tauri/src/core/settings.rs)、[components/AssetDetail.tsx](apps/desktop/src/components/AssetDetail.tsx)。

### 多模态看图四条路径实测 → codex CLI 胜出（2026-07-05）
- 目标：让「反推」（图→文本描述）真正看图，不再凭空。实测四条路径：
  - **`codex exec --image`** ✅ **采用**：走 ChatGPT 订阅（`chatgpt.com/backend-api/codex`，`provider: openai` / model `gpt-5.5`），**绕过 OpenAI API quota**（不受 insufficient_quota 影响）；国内 `chatgpt.com` 的 WebSocket 被 reset，但 codex 自动回退 HTTPS 慢但成功。
  - **`claude -p` 无头** ❌：`@path` / Read 工具把图上传 CDN 但**不传给模型**（"uploaded it to a CDN without displaying it to me"）；`--input-format stream-json` 的 image content block 也只被识别为"image attached"，Claude 仍说"unable to view"。
  - **DeepSeek HTTP** ❌：官方 API content 不接受 OpenAI 的 `image_url` variant（`unknown variant \`image_url\`, expected \`text\``）—— DeepSeek 多模态消息格式与 OpenAI 不兼容。
  - **OpenAI HTTP** ❌：账户 `insufficient_quota`（429）。
- 结论：看图走 [`CodexCliProvider`](apps/desktop/src-tauri/src/codex/codex_cli.rs)（`codex exec --skip-git-repo-check --image <path>` + stdin 指令 + 解析 `\ncodex\n<answer>\ntokens used`）。Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线随后已清理移除，全链路只走 codex CLI。
- 前置：`npm install -g @openai/codex` 修复本地 codex（0.142.5，之前平台二进制 ENOENT），`codex login` 登录 ChatGPT 订阅。
- 相关文件：[codex/codex_cli.rs](apps/desktop/src-tauri/src/codex/codex_cli.rs)、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`provider()` 工厂按 `active_provider` 分流：codex/deepseek/openai）。
