# PROJECT.md

本文件是项目的**活文档**（living doc），记录说明、进展、约定与踩坑。权威的完整设计见 `dev-doc/Bowerbird开发计划.md`；面向 Claude Code 的工作规则与索引自见 [CLAUDE.md](CLAUDE.md)。

---

## 子文档索引

- [dev-doc/analyse-panel-todo.md](dev-doc/analyse-panel-todo.md) — 详情页「反推」面板待优化清单（结果管理 / 流式取消 / 术语统一 / 未登录置灰 等，2026-07-07 评审，P0–P2 分级）
- [dev-doc/AI-PROVIDERS.md](dev-doc/AI-PROVIDERS.md) — AI provider 可切换方案（泛化 GenerationPanel + 全局默认/单次覆盖 + codex/即梦首批 + 即梦走官方 dreamina CLI + 关键约定 1 演进，v2 草案 2026-07-23）
- [dev-doc/ARCH-ADJUST-PROGRESS.md](dev-doc/ARCH-ADJUST-PROGRESS.md) — 收费化架构调整（P0–P9）跨会话任务进度与交接（更新至 2026-08-11；原始计划见 dev-doc/ARCH-ADJUST-PLAN.md，部署步骤见 apps/cloud/DEPLOY.md）
- [dev-doc/AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md) — Bowerbird 受限 VPS Worker 与内置 Skill Agent Runtime 专项计划（Cloud 异步生图 G0 / Agent Kernel / 有限澄清 / 项目视觉设定 / Supabase / 方舟 / 桌面 UI，v1.6 2026-08-15；当前优先 G0，见 [apps/agent-worker](apps/agent-worker/)）
- [dev-doc/进展归档.md](dev-doc/进展归档.md) — 「目前进展」已完成条目的历史全量归档（append-only 只进不改；PROJECT.md 只留最近 3 条里程碑）

## 项目说明

**Bowerbird（园丁鸟）** —— 为 AI 图像创作服务的、本地优先的「提示词 + 参考图」素材库与编排工作台。形态：Tauri 2 桌面应用 + 浏览器扩展。

- **核心交互**：**创作板**（拟文本编辑器）—— 选图 + 选维度下拉，所见即一段中文句子；每个选项 / 缩略图背后映射真实提示词片段，底部「确认生成」拼出完整 prompt + 参考图发 codex（优化 / 扩写 / 生成）。用户全程不写一字提示词。设计稿见 [dev-doc/桌面端UI设计.html](dev-doc/桌面端UI设计.html)。
- **范围**：v1 覆盖六大工作流 —— 收集 / 浏览 / 搜索 / 整理 / 分析 / **生成（⑥）**（2026-07-06 决策扩展，覆盖开发计划 v1.2 §1.4「不做生成」，详见关键约定 2）。
- **定位**：不是「复现 Eagle」，而是把散落的灵感图片组织成可复用的「提示词 + 参考图」资产并交给 AI。
- **哲学**：素材与提示词 100% 本地（Local-First）；AI 推理与生成经用户自有的 codex CLI（可能联网）。

完整定位、范围、技术栈、数据模型、Roadmap 见 `dev-doc/Bowerbird开发计划.md`（v1.2，2026 年 7 月）。

---

## 目前进展

> 更新时间：2026-08-19

**当前阶段（2026-08-19 快照）：**
**桌面（1.0 功能路径全通）：** 收集（浏览器扩展 + 小红书适配 + 拖拽/剪贴板/文件夹导入，dHash 阈值去重）、瀑布流浏览、FTS5 文件名搜索、文件夹/收藏夹/智能文件夹/颜色/标签筛选、项目 Workspace、创作板（ProseMirror + 维度环形菜单）、生成会话面板（多 job 并行、会话分组持久化、版本分支、重试/继续对话/轮级编辑重试精确重放、跨引擎续轮交接）、反推（Bowerbird Cloud / 本机 codex 显式选择，维度可就地编辑）、图片标注（画框/箭头/裁剪/旋转 → 火山 Seedream 交互编辑坐标，入库/插板双出口）；codex/即梦 CLI 对小白隐形（app 内一键安装/登录，codex 免 Node 直装）、统一环境状态 Onboarding、自定义素材库位置与完整迁移、Windows NSIS 出包（日期版本 26.8.x）。
**云端（已上线）：** 账号 + 积分（免费档每日 30 分；档位门控：免费档只能 Bowerbird Cloud，Pro/Studio 可用本机 CLI）；Cloud 生图三档 Pro/Fast/Lite（`service_costs` 数据驱动，上新档位零桌面发版）；生图与反推均走 VPS 异步任务链路（0015 `generation_jobs` + 0019 `understand_jobs`，腾讯云 Lighthouse 广州单容器双循环 Worker）；Agent Runtime 控制面（0012–0014 + agent-run/agent-worker Edge）已部署。真实支付因备案/商户资质暂停（Mock 保持）。官网部署 Render + 首屏试用创作板接真实生图。
**Agent 线（dev）：** 创作板 Agent A/B 双方案（A=模型挑子句 + 确定性编译 / B=skill 审查修复）+ 评测 harness（`npm run ab:prompt`）已落地；A2（VPS Worker 跑 Skill）与 A4（桌面接 agent-run）未开工，规划见 [dev-doc/AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md)。

**源码树（按开发计划 §7）：** `apps/desktop/{src, src-tauri}`、`apps/extension/`、`packages/shared/`。常用命令：`pnpm install`、`pnpm tauri dev`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。

**测试基线：** 桌面 `cargo test` 150/150、agent-worker 59/59、桌面 `tsc --noEmit` 干净（2026-08-19）；扩展 Node tests 10/10、官网 build、Edge Functions Deno type-check 全过（2026-08-13 存档基线）。

**近期里程碑（只保留最近 3 条；更早的全量历史见 [dev-doc/进展归档.md](dev-doc/进展归档.md)）**

- **生成会话续轮全面对齐 + 跨引擎续轮（2026-08-19，dev 线）**：① **续轮参考图后端权威合并（根因实测定位）**：续轮「没带上上一轮生成图」反复复现的真正主因是前端 `sendGenRevise` 曾为二选一——「挑了新参考图就完全替代上一轮产出」，用户用创作板习惯组稿（修改意见里 @ 素材图选维度）即触发替换、上一轮产出被挤掉（task_queue references / generation_meta 双重取证实锤，见踩坑「续轮挑图即替换」）；叠加 `job.turns` 易失内存（重启恢复只建空轮）空回退也会落空。修复（约定 34）：`codex_create_image` 对 jimeng/Cloud 续轮从 generation_meta 取会话「最后有图轮」产出图（新增 `Database::last_generated_images_for_session`）与显式挑选图**合并去重（产出在前、截前 10）**（`merge_continuation_references`），前端只传显式挑选图；每轮实际下发参考图经 `started` 事件回填 `GenTurn.refs`——**每轮气泡上方「附件」缩略图**（含合并的上一轮产出，可点开放大），历史按轮重建 references + 反查完整 asset（`lookup_ref_assets_by_path` 共用，重启/回看不丢）。② **续轮比例后端解析**：「自动」档按**第一参考图**（续轮 = 上一轮产出）对数距离吸附 7 档（`nearest_ratio_key`，与创作板 RATIOS 同套）显式下发——即梦 omit `--ratio` 固定回退 16:9 竖图被横切；`started` 同时带最终比例，`job.lastRatio` 随实际下发更新（续轮坞比例初值不再滞留首轮）。③ **轮级「编辑 ✏️ / 重试 ↻」（每轮气泡下方 icon，与首轮同款交互）**：重试 = 该轮当时实发参考图**原样重放**（`exact_references` 参数跳过自动合并——重试第 N 轮用当时的基图，不漂移成该轮自己的产出）；编辑 = 预载该轮组稿（原文 + 组稿参考图，revise 坞 `preloadTurn`），发送 = 当时基图（turn.refs − 当时挑选）+ 当前 chips 精确合成、追加为会话新一轮（原轮保留可对比）；失败末轮重试仍走原位顶替路径。④ **续轮展示与首轮对齐**：chip 气泡（ReadonlyPrompt）对续轮开放（`GenTurn.refAssets`）；`generation_history` 带回首版 provider（遗留 `dreamina` 归一 jimeng），回看会话的续轮坞 provider 初值不再落到 codex。⑤ **跨引擎续轮（会话共享状态 = 图片流）**：codex 原生会话续轮 resume 原 thread（codex-即梦-codex 也能拿回前面的 thread），上一产出轮非 codex 时显式附最新产出图（thread 看不到别家轮，画面状态不断，`session_generation_provider` 判首/末轮引擎）；非 codex 原生（即梦/Cloud）会话切 codex 开新 thread（首轮 instruction 包装触发 imagegen）+ meta 新增 `codex_thread` 句柄字段（与即梦 submit_id 对称，`session_codex_thread` 取最新），**连续 codex 轮共享 thread**；簿记 session 恒为会话首轮 id（meta/时间线/分组不因新 thread 撕裂）。⑥ **修复**：恢复 worker（即梦/Cloud）完成时 session 记回会话首轮 id（原记成本轮 submit_id 把会话历史撕成两段）；续轮 upsert 整包覆盖抹掉持久化 `conversation_id`（`sendGenRevise` 透传修复——重启后会话面板的版本分组不再丢）。⑦ **附带存档（此前会话未提交）**：设置「登录授权」一键流程（codex/即梦：检测→自动安装→浏览器登录/授权→checklogin 轮询，进度事件接管）、创作板「创作模式」改版（档案页签/空文档占位「描述你的意图，开始创作吧」/滚动停自动浮回/退出交互）、项目「更新项目文件」增量重扫（`refresh_workspace_assets`：origin_path 命中跳过、不删素材）+ 项目右键菜单（[ProjectContextMenu.tsx](apps/desktop/src/components/ProjectContextMenu.tsx)，新文件）、素材右键「物理删除/物理删除整组/重命名/复制位图」、DeepSeek tool-call arguments 容错（未转义中文引号等非严格 JSON，含测试）、会话面板跨重启恢复（`recent_gen_sessions`/`dismiss_gen_job`/`task_queue::list_recent`）、标注 prompt 按 provider 能力归一化（[annotationPrompt.ts](apps/desktop/src/lib/annotationPrompt.ts)，新文件）。测试基线：桌面 cargo **150/150**（+10：续轮合并/比例吸附/provider 判定/thread 句柄/按轮参考图重建等）、agent-worker **59/59**、tsc 干净。

- **codex 免 Node 直装 + 远程 prompt 配置 0020 + 维度环全局单例 + 标注裁剪交互 + 即梦 5.0Pro + 瀑布流行式 masonry（2026-08-18，dev 线）**：① **codex CLI 一键安装免 Node 直装**（[install.rs](apps/desktop/src-tauri/src/codex/install.rs)，新文件）：npm 主包只是 Node 启动器，CLI 本体是平台子包 `@openai/codex@{version}-{platform}` tarball 内 `package/vendor/<triple>/` 的 Rust 二进制（含 rg/sandbox，实测不依赖 Node）——直装从 registry（npmmirror 优先、npmjs 兜底）下平台包、sha512 校验、解压到 `{app_data}/codex-cli/`，`resolve_codex_binary` 优先托管副本；失败且本机有 npm 时回退 `npm install -g`。用户全程免 Node.js、不改 PATH、无 UAC；进度事件加 `percent`，CodexOnboarding 显进度条；Cargo 新增 base64/sha2/futures-util。② **远程 prompt 配置（[0020_prompt_configs.sql](apps/cloud/supabase/migrations/0020_prompt_configs.sql)）**：`prompt_configs` 表（key 主键 + value/version/enabled；RLS 全拒，仅 service-role entitlement 读）seed `understand_autoname`；entitlement Edge 随权益快照下发 enabled 行（同 `generation_services` 模式）；桌面 [entitlement.rs](apps/desktop/src-tauri/src/cloud/entitlement.rs) `prompt_config(key)` 查找（空白值视为未配置），[autoname.rs](apps/desktop/src-tauri/src/core/autoname.rs) 生成图命名指令远程优先、内置默认兜底——Supabase Studio 改行即热更，零桌面发版、零 Edge 重部署（约定 33）。校验脚本 [check-prompt-configs.mjs](apps/cloud/scripts/check-prompt-configs.mjs)。③ **维度环全局单例 + 点扇区直达创作板**：CaptionRing 从创作板局部提升为 App 根全局单例（store `captionRing/ringAssetId/pendingKeyword` 驱动）；**点扇区 = 维度直接进创作板**——板未开自动开板，`pendingKeyword` 由创作板实例的 `useCreationEditor` 挂载后/即时消费插入（编辑坞不抢）；`ringAssetId` 收起后保留供 smartPunct 维度名→chip 匹配正文；扇区信息浮层（径向外侧 + 视口钳制；开环 600ms 内忽略错峰绽放期假 hover）；板在环开着期间被打开 → 下一帧补挖编辑框洞。OnboardingTour step 8→9 改「真长按瀑布流图呼出维度环」。④ **标注面板裁剪交互升级**（[ImageAnnotator.tsx](apps/desktop/src/components/ImageAnnotator.tsx)）：裁剪从拉框即落 op 升级为**持久裁剪模式**——框内移动 / 8 手柄缩放 / 框外重画（橡皮筋）、双击或 Enter 应用、Esc 取消（先于关面板）、Ctrl+Z 撤销、三分构图线；最小归一化尺寸对齐火山参考图 >14px 约束（输出 ≥16px）；底图坐标系变化（换图/应用裁剪旋转/撤销）清旧框。「标注」维度直接挂注入对象（sections 内联，不进 DB、不走 `list_prompted_assets` 合成）；仅裁剪/旋转无形状时不带维度 = 普通参考图。⑤ **即梦模型版本可配 + 默认 5.0Pro**（AI-PROVIDERS.md 开放问题 3 决策反转）：settings 新字段 `dreamina_model_version`（serde default 兼容旧配置；每次生成前 resolve 读取、改设置热生效），SettingsDialog 加选择器（text2image 3.0~5.0Pro / image2image 仅 4.0+），jimeng.rs `--model_version` 传入。⑥ **续轮回退修复 + 杂项**：续轮参考图取「最后一个有图的轮」（末尾失败轮无图不再落空）、截前 10 张（服务端参考图上限）、Cloud 与即梦同样回退上一轮产出图；featureFlags 新增 `SMART_REFINE_ENABLED=false`（智能精修未完成，隐藏详情页「再创作」tab 卡片）。⑦ **瀑布流行式 masonry（Eagle 式）**（[MasonryGrid.tsx](apps/desktop/src/components/MasonryGrid.tsx)）：从 CSS columns（列优先填充：最新沿左列向下、阅读列式）换 **JS 分列**——`useColumnCount`（matchMedia，断点与旧 `columns-*` 一致：2/3/4/5 列）+ **最短列优先放置**，高度用 DB width/height 估算（`h/w` 相对高度，零 DOM 测量）；阅读顺序近似从左到右从上到下，横扫一行 = 相邻时间段素材；排序仍后端 `ORDER BY created_at DESC`（与布局解耦）。aspect-ratio 占位保留（防加载撑高跳滚动，与分列估高同源）；`break-inside-avoid`（columns 专用）清理。测试基线：桌面 cargo **140/140**（+5：即梦旧配置默认 Pro、entitlement prompt_config 回退与快照兼容等）、tsc 干净。
- **图片标注（画框/箭头/裁剪/旋转 → 火山 Seedream 交互编辑坐标）+ 创作板维度环形菜单 + 右键菜单四组重组（2026-08-18，dev 线）**：① **图片标注面板**（[ImageAnnotator.tsx](apps/desktop/src/components/ImageAnnotator.tsx)，新组件；右键「图片标注」唤起、App 全局单例、全屏遮罩与 Lightbox 同级 z-[90]）：截图软件式画框/箭头（5 色、线宽按底图宽比例）+ 裁剪/旋转 90° 步进（ops 序列即时生效、已有形状坐标随变换映射到新坐标系锚定图像内容、快照栈全量撤销）；坐标导出**火山 Seedream 交互编辑格式**（0-999 归一化整数：rect → `<bbox>x1 y1 x2 y2</bbox>`、arrow → 起终点两个 `<point>`，坐标相对最终输出图 = 实际发给模型的参考图）；底图经新命令 `read_image_data_url` 由 Rust 读为 data URL（convertFileSrc 的 asset 协议是跨域源、烧进 canvas 再 toDataURL 会抛 SecurityError；命令 canonicalize 前缀比较只放行库根内文件，防任意本地图泄进 webview）。导出双出口：**保存到素材库** = `save_annotated_image`（ingest 入库 source=annotation、命名「原名-标注」前端拼好、**跳过 auto-analyze**——codex 看图取名丢溯源且多一次调用；pHash 去重命中返回既有资产时 annotation 行照常追加）+ 坐标 JSON 落 `analyses(kind=annotation)`；**插入创作板（不入库）** = `save_annotation_temp`（落 `<库根>/annotations/<ulid>.<ext>` 临时文件 + sidecar `{name,ext,annotation}`，不写 DB；目录在库根内 asset scope 已放行（约定 19）；不自动清理——板草稿引用着）。② **「标注」维度接入创作板**：`list_prompted_assets` 的 EXISTS 扩到 annotation kind（标注入库无 caption，靠 annotation 行进 @ 池），`annotation_section` 取 shapes[].token 用「；」拼成「标注」维度（caption 并存时**追加**在反推维度之后、多条 annotation 取最新）；`useCreationEditor` 新增 `board-asset-injected` 事件旁路注入 extraAssets（同 id 覆盖防草稿 refs 膨胀）、插 image chip 后紧跟「标注」keyword（serialize 自动展开 `@图名 的【标注】：<bbox>…`，用户无需手动引用）；`generation_history` 参考图反查未命中且路径在 annotations 目录时从临时文件 + sidecar 合成（`references` 类型 `Asset[]` → `PromptedAsset[]`）——「复用生成提示词」不丢不入库标注图、标注维度随之还原（sidecar 缺失退化仅按文件合成、文件已删则跳过）。③ **维度环形菜单 CaptionRing**（[CaptionRing.tsx](apps/desktop/src/components/creation/CaptionRing.tsx)，新组件）：取代旧「编辑框下方维度 chips 面板」（showKeywordHints → ringOpen）——点瀑布流图片拾取 / **长按 450ms 窥视**（MasonryGrid `board-asset-peek`，不插 chip 不抢焦点；移动超 8px/松开/离开/开始拖拽取消，触发后松开不再当点击）后，卡片四周呼出**扇形维度环**（SVG 扇区角缝分隔 + label 居中质心 + 自中心旋出/按角度错峰绽放动画；点扇区插维度、环保持开、已选 ✓ 变淡）；遮罩挖两洞（环圈 + 编辑框）evenodd + feGaussianBlur 羽化（洞内不压暗、编辑框可继续输入定位插入点）；Esc/点遮罩/再点图/右键/窗口缩放/鼠标移出环一定距离/直接输入文字收起；tour 激活时 suppressScrim（tour 自带聚光灯），OnboardingTour 文案同步改为环交互。④ **右键菜单四组重组**（整理 / 再创作 / 文件 / 移出与删除）：新增「图片标注」（本地位图才可标，tiff/视频/SVG 置灰）与「打开生成会话」（生成图，与详情页「回看生成对话」同一 `viewGenerationHistory` 入口）；ConfirmDialog `message` 支持 ReactNode（「不可恢复」加粗）。⑤ **「用途」（preset）入口暂隐**：新 [featureFlags.ts](apps/desktop/src/lib/featureFlags.ts) `PRESET_FEATURE_ENABLED=false` 关闭创作板「用途」栏与生成面板「登记为用途」入口（store 注入逻辑随之不可达），功能待重做；BatchBar 批量反推不再因任一 job 在跑而禁用。⑥ **首轮生成成功不再自动关创作板**：`pendingBoardClose` 整体移除（GenJob 字段删除，loadGenJobs/首轮/续轮/重试四处同步）——创作板转为常驻工作台；`setBoardOpen(true)` 现同步退出会话编辑坞 genEditing + 收起 genPanelOpen（两个 `useCreationEditor` 同时挂载会双份插入/抢焦点）。测试基线：桌面 cargo **135/135**（+3 标注测试：缓存合成参考 / 标注维度进 @ 池 / caption+annotation 并存追加）、tsc 干净。

**未开始 / 待办：**
- **多模态看图 spike — 已接通（codex CLI），非待办**：四路径实测后定型为唯一 `CodexCliProvider`（`codex exec --image`，ChatGPT 订阅，绕过 API quota）；Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线已全部移除（`codex/` 仅 `codex_cli.rs` + `types.rs` + `mod.rs`），反推会话回看走 `open_codex_session`（`codex resume <thread_id>`）。详见关键约定 1 + 踩坑「多模态看图四条路径实测」。旧 provider 切换 / in-app apikey 配置已删（`config.json` / 后端 `Settings` 模块 / `base64` 依赖随路线移除）；**`SettingsDialog` / ⚙️ 设置按钮 2026-07-18 同名复活为「整库运维面板」**（codex 状态检测 / 重建色板 / 智能归类全部，[SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx)，Toolbar ⚙ 入口、约定 13 全屏 Modal 形态），与 apikey 无关。`codex_health` 命令保留作离线/无账号降级探测（约定 7）。
- **Phase 4 剩余**：FTS5 当前仅同步 `name`；`prompt_body/annotation/ocr` 的同步（搜提示词正文等）待做。**tags 已可检索**——走 `tag:<name>` 智能文件夹 JOIN（不进 FTS，见 P2 设计）；codex 批量自动打标已通（采集即归类 + `reclassify_all`）。
- **Phase 5 剩余**：用户已简化为只做反推（caption）；OCR/版式/关键词/灵感卡模板集 + 批量分析队列留待需要时再做。
- PSD 预览（计划 §1.3 P1）暂未做（SVG/视频已覆盖；psd crate 与 image 0.25 兼容未验证，留后续）。
- **创作板 UI — 已实现（见「已完成」，非待办）**：原「占位填空 + 维度下拉」设计演化为「真实 prompt 文本编辑器 + `@` 选图 + 维度 chips 来自图片 sections」（2026-07-18 重写为 ProseMirror）；图像生成亦已通。
- **图像生成（⑥）— 已端到端打通（2026-07-08，见「已完成」，非待办）**：创作板→codex imagegen→真流式回显→入库进瀑布流→多轮修改（resume）→生成图标记（角标/筛选/来源/命名）整条打通。**剩余**：`generations` 表落库（开发计划 §4.2 原移除；目前用 `analyses(kind=generation_meta)` 存来源元信息，够用）。

- **收费化 P9 剩余**：P9-T2/T3/T4/T5 与 P6.1 多层权限门控代码已完成；P9-T1 的购买 Pro、800 分到账、续费/退款与真实订阅升降级验收明确暂停，等待备案/商户资质完成后恢复。可先用测试订阅数据验收 Pro/Studio；7 天离线宽限还需非对称 entitlement 签名。跨会话细节见 [dev-doc/ARCH-ADJUST-PROGRESS.md](dev-doc/ARCH-ADJUST-PROGRESS.md)。
- **收费化延后项（凭据/决策驱动）**：Seedance 视频 adapter（待真实 video model id）、微信登录真实联调（H5）；真实支付在备案完成前不选 provider、不做真实联调，历史候选仅供恢复时重新调研，决策前 `BOWERBIRD_PAYMENT_MOCK` 保持 true。

**里程碑：** 内部 Alpha（Phase 1 ✅）→ 公开 Beta 0.5（Phase 3 ✅）→ 1.0 正式版（Phase 5 简化版 ✅，真实 VLM 看图 spike 后转正）→ **1.x 生成（⑥，codex imagegen 端到端实测跑通 + 入库 + 标记，2026-07-08）**。

---

## to-do

[x] 允许用户通过codex一次生成多张图片（codex无疑能生成多张图片，但bowerbird需要增加在一次发送内接收多张返回的图片的功能）— 2026-07-17 完成（接收侧本就 Vec 全链路；瓶颈是首轮 instruction 硬编码「一张」，改为 prompt 驱动数量，详见「目前进展」）
[x] 生成结果历史，允许用户像回看对话一样回看某个图片的生成结果界面，能看到生成时的prompt，并且能提出对该图片的修改意见（给codex）— 2026-07-17 完成（后端 `generation_history` 按会话重建各轮 prompt+图；前端复用 GenerationPanel，详情页「回看生成对话」入口 load 历史会话 + 续轮 resume，详见「目前进展」）
[x] 创作板新增”用途”功能：允许用户将某段提示词及参考图（可选）登记为一个用途，若选择了某用途，那创作时就会首先加载其代表的提示词和参考图。— 2026-07-17 完成（用途 = preset：[0009_presets.sql](apps/desktop/src-tauri/sql/0009_presets.sql) + `createPreset`/`updatePreset`/`deletePreset` CRUD；CreationBoard 用途区选中即加载、可编辑/删除；生成面板「📋 复用」可把某轮 prompt 登记为用途，详见「已完成：回看后复用 prompt / 登记为用途」）；**2026-08-18 起入口被 `PRESET_FEATURE_ENABLED=false` 隐藏（功能待重做，见 featureFlags.ts）**
[x] 允许用户在瀑布流中拖拽素材来放入某个文件夹 — 2026-07-18 完成（Thumb 拖拽源 + FolderRow 放置目标仅普通文件夹；payload 走模块变量避开 WKWebView 自定义 MIME strip；后端 move_assets_to_folder 加 emit 刷新，详见「目前进展」）
[x] 改变生成图的点击行为，目前点击之后会跳转默认浏览器打开本地图片。但应该要的是就是跟常见的图片交互一样，点击后放大展示。— 2026-07-18 完成（生成图点击改 app 内 Lightbox 全屏放大，跨轮 ←/→ 切换，详见「目前进展」）
[ ] 新增功能：允许用户上传文件（如品牌全案）以生成合理的视觉系统规范——可以作为用途。
[ ] 记录素材被创作板调用（参考）的次数。然后构思自学习功能应该提供什么具体的体验（此处先输出策略文档）。

## 关键约定

> 团队已定的、不轻易改的决策。详细论证见 `dev-doc/Bowerbird开发计划.md`。（约定内容只在本文件维护、不镜像到 CLAUDE.md——2026-08-18 勘误：原文「必须同步 CLAUDE.md『Architectural constraints』」为死引用，该节不存在。）

1. **AI 全外包，不自建模型**：所有理解/分析（VLM 描述、OCR、版式、关键词、灵感卡）**不自建本地模型、全外包**：本机走 headless codex 子进程，Cloud 走 `UnderstandProvider`（方舟 Vision，2026-08-18 起经 VPS understand 异步链路）；**图像生成（⑥）多 provider 可切换**（2026-07-23 Phase 1+2 落地，2026-08-10 Cloud 加入）——抽象 `GenProvider` trait（原 `CodexProvider`，[codex/mod.rs](apps/desktop/src-tauri/src/codex/mod.rs)），三实现：`CodexCliProvider`（默认，`codex exec --image`，ChatGPT 订阅，真正看图 + 出图）/ `DreaminaCliProvider`（即梦官方 dreamina CLI，OAuth + 积分，**仅出图**，[codex/jimeng.rs](apps/desktop/src-tauri/src/codex/jimeng.rs)）/ `BowerbirdCloudProvider`（Bowerbird Cloud 托管生图，Pro/Fast/Lite 档位数据驱动见约定 31，[codex/bowerbird_cloud.rs](apps/desktop/src-tauri/src/codex/bowerbird_cloud.rs)；免费档唯一生图路径）；命令层 `codex_create_image` 的 `provider` 参数选（None=codex），工厂 `resolve_gen_provider`。**理解类（反推/命名/归类）走 `UnderstandProvider`（[codex/understand.rs](apps/desktop/src-tauri/src/codex/understand.rs)）**：本机 codex 或 Bowerbird Cloud 引擎显式二选一（2026-08-13 起；档位门控免费档仅 Cloud；即梦无文本能力，§4.3）。**禁止** ONNX / CLIP / 本地扩散 / 本地 VLM / tesseract / 向量等任何本地模型；Mock / ClaudeCode / OpenAI HTTP 路线在桌面 provider 层均已移除（[codex/openai_api.rs](apps/desktop/src-tauri/src/codex/openai_api.rs) 仅存 spike 备选；DeepSeek 只在 agent-worker 作 Agent 文本回合后端，见约定 25/28；详见踩坑「多模态看图四条路径实测」）。详见 [dev-doc/AI-PROVIDERS.md](dev-doc/AI-PROVIDERS.md)。
2. **v1 做图像生成（⑥）**（2026-07-06 决策，**覆盖开发计划 v1.2 §1.4「不做生成」**）：在原五件套（收集/浏览/搜索/整理/分析）基础上加入生成。生成多 provider（约定 1）：codex 路径走 CLI tool-use（codex 内置 `imagegen` 技能，不自建扩散模型），Cloud 路径走方舟 Seedream（VPS 异步链路，约定 24/31），即梦走官方 CLI。**已端到端打通（2026-07-08）**：codex exec 触发 `imagegen` 画图，产物落 `~/.codex/generated_images/<thread>/`（路径不在 JSONL 一等字段，靠**快照差分**取图，详见踩坑）；创作板生成 → 真流式回显 → `ingest_generated` 入库为正式资产（`source=codex`、不算 pHash 不去重、进瀑布流）→ 多轮 `codex exec resume` 迭代修改 → 生成图标记（✨ 角标 / `source:codex` 筛选 / `generation_meta` 来源追溯 / 自动命名）。**生成图 caption 策略（2026-08-11 反转）**：曾从生成 prompt 拆 `【维度】：正文` 自动落 caption（2026-07-10 起，不调 codex 反推），导致所有生成图被标「有反推」（🏷️/创作板 @ 池虚构维度）——已反转：**生成图入库不自动写 caption，需手动反推才有**（generation_worker 移除维度拆解，详见「已完成」条目）。prompt 原文仍存 `generation_meta`；**生成 UI 独立为 `GenerationPanel` 覆盖层**（与创作板解耦，状态在 store）；**同流程合并**（2026-07-10）：同一 `session_id` 的过程图入库时写 `assets.generation_session_id`，瀑布流 `collapse_generation_groups` 每组只显最新一张，缩略图/详情页可左右切换过程图（详情页支持 ←/→ 键）；**2026-08-18 扩展（0014）**：`generation_conversations` 把 session 组再扩成 conversation 组——「重新编辑/重试」的版本分支归入同一会话（后端权威、重启不丢）。**一次生成多张（2026-07-17）**：接收侧本就是 Vec 全链路、无需新增能力；数量完全由用户 prompt 驱动（不加 UI 控件），首轮 instruction 不再硬编码「一张」（改「张数以提示词为准」），续轮 resume 天然支持，首轮多张同 session_id 合并成一组。**剩余**：`generations` 表落库（开发计划 §4.2 原移除；目前用 `analyses(kind=generation_meta)` 存来源元信息，够用）。
3. **检索用 FTS5 全文**（`trigram` 起步；**当前仅 `name` 已同步**，`prompt_body`/`annotation`/`ocr` 待 Phase 4）。pHash **仅用于采集去重**，不做以图搜图；无 CLIP 语义/向量搜索。**标签/颜色不走 FTS**——`tag:<name>` 走 `list_assets_smart` JOIN（P2）、颜色走 `asset_colors` JOIN（P3）。
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

16. **环境状态入口收敛进设置面板 + 扩展心跳连接跟踪（2026-07-31 立，2026-08-15 重构）**：原两级「环境状态 Onboarding」（一级 Onboarding.tsx 三卡片总览 + store `onboardingForceOpen` 跳转二级）**已于 2026-08-15 删除**——codex / 即梦 CLI 状态与引导移入设置「模型设置」、浏览器扩展引导移入「系统设置」直接唤起，二级引导（Codex/Dreamina/Extension Onboarding）关闭即返回设置；新手上手改走交互式 OnboardingTour（右键复用生成提示词 → 进创作板 → 插 chip 实操逐步解锁）。**扩展连接跟踪不变**：canonical 扩展（[apps/extension/](apps/extension/)）每 15s WS ping；后端 `ExtensionStatus`（last_seen + connected）收任意消息 touch/emit connected、后台 tick 30s 超时 emit disconnected。随包内嵌（tauri resources `../../extension/` → `extension/`，用**目录源**保留子目录结构——map+glob 会拍平子目录致 release 扩展图标加载失败，见踩坑；dev 源码、release resource）。

17. **扩展采集统一走浏览器 save_blob + 通用候选管线（2026-07-29）**：canonical 与旧 Windows 版不再分叉——[background.js](apps/extension/background.js) 在浏览器会话内 fetch（继承代理/Cookie/登录态）后，以 `save_blob` metadata + binary WS 上传；桌面 [ws_server.rs](apps/desktop/src-tauri/src/collect/ws_server.rs) → [ingest_from_bytes](apps/desktop/src-tauri/src/core/ingest.rs) 按真实字节 sniff/decode，**禁止退回桌面 reqwest 二次下载作为主路径**（Pinterest/登录态站会回归）。通用候选见 [candidate-utils.js](apps/extension/candidate-utils.js)：`img/currentSrc`、srcset/picture、lazy data-*、CSS background、OG/Twitter、JSON-LD、poster/SVG、open shadow；拖拽 HTML 图片优先，禁止把外层商品页 URL混为图片；Alt 明确目标支持 overlay/CSS/blob/data/canvas。XHS 结构化适配保留为高置信度增强但共用后续管线。安全边界：候选≤100、fetch 45s、图片≤50MiB、HTML fallback≤2MiB且深度1、防循环、Rust 100MP/32768边界、metadata状态机/长度限制、日志 query 脱敏；不绕 closed shadow/跨域 iframe/tainted canvas。真机以 Pinterest + `petcollars.com.au` 商品页通过为验收。

18. **项目是中央素材库上的多对多 Workspace 视图（2026-07-30）**：`projects` 只登记 canonical workspace 路径与名称，`project_assets` 只登记成员关系；项目**不是第二套素材库**，不改变 `assets.folder_id` 的全局位置语义。创建项目只在登记时递归导入目录现有图片，之后不监听/同步、不写回、不删除用户原目录；所有素材仍复制到 Bowerbird 中央库，dHash 去重命中时仅新增项目关系。进入项目后，所有素材查询与成员集合取交集，文件夹/收藏夹/标签/颜色元数据仍为全局共享；项目内导入、扩展采集、生成均同时进入中央库和当前项目。应用启动默认全局，不持久化 active project。项目内单次删除必须每次二选一（仅移出 / 全局彻删）；删除项目三选一（2026-07-31）：仅删关系 / **移出独占素材文件回 workspace 并删行**（这是唯一会写 workspace 的操作，且由用户显式触发）/ 物理删除独占素材（红色 + 手输「确认删除」），被其他项目共享的素材必须保留。扩展的 active project 由后端 `ActiveProjectContext` 快照，生成续轮使用首轮 `genProjectId` 快照，禁止因中途切换 scope 造成归属漂移。

19. **素材库根可自定义并可整体迁移（2026-08-01）**：库根不再写死应用数据目录——`settings.json` 增 `library_root`（只存指向，文件体量小可留系统盘），[lib.rs](apps/desktop/src-tauri/src/lib.rs) 启动先读设置定根，默认仍为应用数据目录。迁移只复制不删除，用自定义根打开成功后由启动流程清理 app_data_dir 旧库残留（images/thumbnails/library.db*），彻底释放系统盘；`VACUUM INTO` 拿一致性 DB 快照、`REPLACE` 改写新库 `store_path`/`thumb_path`/analyses payload 绝对路径前缀。**`convertFileSrc` 走 asset 协议、受目录白名单约束（默认仅应用数据目录）**——自定义库根必须 `asset_protocol_scope().allow_directory(&paths.root, true)` 显式放行，否则迁移后全部破图（见踩坑「迁移素材库到自定义位置后全部图片破图」）。

20. **图片删除统一走三模式，与「删除项目」语义对齐（2026-08-01）**：单素材删除（右键菜单）与删除项目共用同一套语义——`keep`=仅移出当前项目（素材留全局）；`move_out`=移出园丁鸟（独占素材文件移回 `origin_path` 原始位置并删资产行；共享素材只移出当前项目成员、资产行与库内文件保留，原始文件不在时如实报告失败）；`delete`=从全局及所有项目物理删除（红色入口 + 手输「确认删除」口令，避开 WKWebView 对 `window.confirm` 的拦截）。删除项目三选项（约定 18）与右键三模式只差在粒度（项目 vs 单素材）与「move_out 时独占判定」的覆盖范围（项目内 vs 当前项目视角），核心 `move_file` / `move_destination` 复用。**删资产前必须先 `drop(conn)` 释放锁再走 `delete_asset`**（`delete_asset` 内部会再拿锁 + 文件 IO，锁内调用即死锁）。

21. **官网试用创作板的生图 provider 独立于桌面端（2026-08-02）**：官网运行在浏览器，禁止把 API Key 写进 `index.html` / `app.js` / bundle；真实生成统一经 [`website/server.mjs`](website/server.mjs) 的同源服务端代理。`BOWERBIRD_IMAGE_REGION=cn` 时首选 Seedream 5.0 Lite，其他地区首选 FLUX.2 Klein 9B；`BOWERBIRD_IMAGE_PROVIDER` 可显式覆盖。编辑器只提交 prompt 与演示图 ID，服务端按固定白名单读取参考图并转 data URI。官网试用的产品目标是**演示生成后自动入库**，不是提供免费生图：前端不提供下载按钮；服务端默认每 IP 每自然日 3 次、全站 100 次/日（均可由环境变量收紧），第 3 次后前端隐藏生成按钮并展示下载 CTA。首屏只用动态节点图解释参考图、维度与输出图的关系，不明文展示或复制最终 prompt；图作为来源分组，组内每个维度必须拥有独立节点、端口和到输出图的连线，未选维度的纯参考图以「整图参考」节点接线；但底层序列化与 API 请求保持真实 prompt，不因可视化改变生成语义。内存计数服务重启后清空，公开部署仍应叠加 CDN/WAF 限流。官网 HTTP provider 只服务公开试用页，**不推翻桌面端“本地 CLI 子进程”约定**。

22. **官网本地与 Render 统一 pnpm，部署在 codex/render-deploy 分支（2026-08-04）**：[`website/`](website/) 是 pnpm workspace 成员（锁文件用根 `pnpm-lock.yaml`），本地与 Render 必须用同一套包管理器（pnpm@11.10.0，根 [package.json](package.json) 的 `packageManager` 字段），**禁止在 website 目录跑 `npm install`**——会生成 `package-lock.json` 并破坏 pnpm 的 `node_modules/.bin`（详见踩坑）。Render Blueprint（[render.yaml](render.yaml)）push 到 **`codex/render-deploy`** 分支触发自动部署（这是 Render 实际监听的分支，不是 main/dev/mac）。Render 构建环境 `/usr/lib/node_modules` 与 `/usr/bin` 只读，`corepack enable` 与 `npm i -g` 都失败，buildCommand 必须把 pnpm 装到用户可写目录 `$HOME/.npm-global`（`npm i -g pnpm@11.10.0 --prefix $HOME/.npm-global`）并用绝对路径调用（详见踩坑）。官网静态资源（含 mp4）经 [server.mjs](website/server.mjs) 同源伺服，已支持 MP4 Range 分段请求（`206`），大视频可拖动进度条。

23. **生成任务持久化 + per-job 取消 + 即梦串行 + 前端多 job（2026-08-06）**：生成（图片/视频）任务进 `task_queue`（kind=generation，payload = `GenJob` JSON：id/media/provider/status/prompt/references/session_id/ratio/submit_id/video_options/turns/queue_idx/timestamps）；`job_id` 由前端 `crypto.randomUUID()` 生成传入（多 job 路由无 race），`codex_create_image` upsert（续轮复用同 job_id 刷新回 running）+ emit `codex://chunk{job_id}` + 成功 `mark_done` / 取消 `mark_cancelled`（保留 submit_id 事后取回，演进约定 5）。**per-job 取消**：`GENERATE_CANCEL` 为 `HashMap<job_id, oneshot::Sender>`（非单槽），`cancel_codex_create(job_id)` 精确取消指定任务。**即梦同账号并发=1**（spike 实证 `ExceedConcurrencyLimit` ret=1310）：`JIMENG_FLY` Semaphore(permit=1) 串行化即梦 job，codex 不受此限可并行。**前端多 job 状态机**（Task 3，2026-08-06）：store `genJobs: Record<id, GenJob>` + `activeJobId`，`generating` 派生（任一 job running）；`startGeneration` 不再单槽阻塞（可并发发多个生成），chunk 按 `job_id` 路由；续轮/复用/取消/重试基于 activeJob；GenerationPanel 呈现活跃 job/会话（2026-08-15 起会话化，2026-08-18 起侧栏 SidebarStatus 悬浮会话面板亦可切换查看，旧「顶部 job 标签栏」形态已演进）。**submit_id 事件回填持久化**（Task 5，2026-08-06）：jimeng provider 拿到 submit_id 瞬间经 `Chunk::Submit` 回传，转发 task 立即 upsert GenJob.submit_id + 细粒度 status=querying（app 此后被杀也有 submit_id 续查）。**启动恢复**（Task 5 阶段1+2，2026-08-06）：app 启动 `generation_worker::spawn_recovery` 扫 `list_running` → 即梦 job + submit_id 后台 `query_result` 续查入库（`finalize_generation_assets` 复用 meta/caption/autoname）/ codex job 不可恢复 `mark_failed`（codex exec 无 resume-from-mid）；前端挂载 `loadGenJobs` 重建 genJobs。**同步 invoke 模型**（命令阻塞到完成，但 Tauri 后台 async 不冻结 UI）；远端孤儿 `list_task` 取回 + 完整持久化 worker 留阶段 3。详见 [dev-doc/VIDEO-GENERATION.md](dev-doc/VIDEO-GENERATION.md)。

24. **Bowerbird Cloud 收费化边界（2026-08-08，2026-08-11 P6.1/P9-T5 收口，2026-08-12 Agent Runtime 扩展，2026-08-15 Cloud 生图异步化决策）**：云承载**只三件事**——账号（Auth）、积分（账本/预授权）、托管算力（官方 API 代理与内置 Skill Agent 执行）。**素材库、整库提示词、项目数据永不上云，不形成云端资产库/同步服务**；Cloud 生成/理解只有用户**明确选择**时才发送本次输入。异步图片生成与理解（2026-08-18 起理解同款异步化，开关 `UNDERSTAND_ASYNC`）允许把本次 prompt、明确选择的参考图（理解为单图）和产物放入**私有、job 隔离、短 TTL 临时工作区**，桌面确认下载后立即清理，输入/失败任务最迟 24h、最终产物最迟 7d；理解结果文本只短时投递（行内存放，输入对象过期清理时同步清空）。Agent Runtime 因跨步骤、审批和崩溃恢复需要，同样允许用户为该次 Run 明确选择的输入、目标、中间状态和产物进入私有、Run 隔离、短 TTL 临时工作区。长期只留不含用户内容的技术状态/usage/账务，本地素材库与本地任务历史仍是长期权威。日志只记 request/job/run id、user hash、service/skill、状态、时延与 usage，不记图片、目标/提示词正文、签名 URL。**门控单一事实源**：前端只镜像服务端派生的 `FeaturePolicy`（`effectivePolicy`/`canUseByo`/`canStartAnotherJob`，[entitlement.ts](apps/desktop/src/lib/entitlement.ts)），不散落 tier 字符串比较；UI、store、Rust command、后台自动分析与任务恢复都必须复核它。免费档只能使用 Cloud，Pro/Studio 才能使用 Codex/即梦本机 CLI。**积分三段式**：`credit_hold`（幂等、FIFO daily→sub→topup、行锁防透支）→ 上游 → `credit_confirm`/`credit_rollback`；异步任务先 `pending_settlement`，绝不在前端取消即盲退。方舟明确失败才回滚；Worker 已把请求发给方舟但连接丢失时必须记 `outcome_unknown`，不自动重试、不重复扣费，等待人工/后续可审计处理。**安全**：桌面端只持构建期内置、用户不可编辑的 publishable key + URL，refresh token 存 OS keychain（keyring）；secret/方舟/支付密钥只在可信服务端运行时（短请求 Edge Functions + 受限 VPS Worker），Worker 不持 Supabase `service_role`、不直连数据库；计费表 RLS own-row 只读 + 写仅服务端 RPC；`SECURITY DEFINER` 固定 search_path；webhook 常量时间验签。当前 entitlement 响应尚未做非对称签名，在线响应只在当前进程刷新期使用，不能把 7 天离线 Pro 宣称为已上线。H1（Supabase）/H2（方舟）已部署并通过东京节点真实积分出图闭环。**H3 支付延期（2026-08-11 用户决策）**：真实支付需先完成备案/商户资质，前置手续完成前不选/不实现真实 provider，`BOWERBIRD_PAYMENT_MOCK=true` 必须保持；Mock checkout/webhook 只作协议骨架，不能对外收款。恢复时必须重新核对当时的官方渠道文档并取得商户/沙箱凭据，微信/superun/Paddle 均未真实联调。当前线上同步过渡值仍为方舟图片 135 秒、Cloud 代理 140 秒、Cloud 理解 110 秒、桌面 Cloud HTTP 180 秒；图片生成与理解均已走 VPS 异步链路，不再受 Edge 请求 deadline 截断，Cloud 理解 110/120 秒仅在 `UNDERSTAND_ASYNC=false` 回退模式生效。**生图/理解等待铁律（2026-08-18 用户定调）**：只要方舟未返回错误就等待——Worker 调用不设 abort 超时、租约心跳续租、桌面轮询无总 deadline，绝不单方面截断；方舟明确失败才回滚/报错。Mock/真实选择只由可信服务端 secret 控制。详细方案见约定 25 与 [dev-doc/AGENT-RUNTIME-PLAN.md](dev-doc/AGENT-RUNTIME-PLAN.md)。

25. **内置 Skill Agent Runtime、Cloud 生成 Worker 与 Bowerbird Agent Kernel（2026-08-12，2026-08-15 VPS 可靠性优先）**：Bowerbird 只运行随官方 Worker 镜像发布、版本固定的**内置 Skill**；不接收用户上传/修改 Skill，不做 Skill 市场、任意代码执行、共享 Codex/即梦会员 CLI 或通用 Agent 平台。首版部署为 VPS 常驻 Worker 出站轮询 Supabase 控制面，Edge Function 负责 JWT/Worker Token、任务状态机、短时签名对象 URL、预算与结算，Worker 不持 `service_role`、不直接读写数据库、不开放公网业务端口。**Cloud 单次图片生成先于完整 Agent Runtime 接入 VPS**：它使用独立 `generation_jobs`，不伪装成 Agent Run；但复用 Worker 的 poll/claim/heartbeat、私有临时对象、安全日志和部署基线。Worker 调方舟同步图片接口时并发发送 Bowerbird 心跳；桌面轮询 Bowerbird `job_id`，不得声称能轮询方舟未提供的图片 task id。Harness 固定为自研 **Bowerbird Agent Kernel**：Skill 提供版本化 phase graph，模型后端只能返回当前 phase 的候选 action；`PhaseMachine`/`PolicyEngine`/`ToolDispatcher` 确定性掌握转换、审批、预算和副作用，所有外部调用使用 Kernel 派生的稳定 `call_id + args_hash` 与 prepare/submitted/complete ledger，Run 由版本化 snapshot 恢复且供应商隐式 session 不是权威。模型只可调用 Skill allowlist 中的确定性工具，不提供 shell、浏览器、任意 HTTP 或跨 Run 文件读取；首版单容器按 Run 隔离工作目录，不预先建设不受信代码沙箱。**不植入 OpenClaw、不复现 Claude Code**；未来 Claude backend 优先使用直接模型 API，Agent SDK 只有能关闭通用工具、降为相同 `ModelBackend` contract 并通过同一 eval 时才采用，不能接管控制面、计费和工具。Agent Run 使用独立云端状态源，不并入本地 generation `task_queue`；最大预算先 hold，usage 逐项幂等记录且最终积分由服务端计算，审批暂停时释放 Worker 租约。个性化长期偏好留在桌面本地，单次 Run 只接收用户允许的只读 `PreferenceCapsule`；Agent 只能返回偏好候选，不能直接修改长期记忆。**模型 provider 分工**：Agent 文本回合（思考/计划/评分）走 **DeepSeek `deepseek-chat`**（支持 tool calling；`deepseek-reasoner` 不支持、不可用），本机出图/看图分别复用现有 GenProvider / UnderstandProvider，未来 VPS 分别为方舟 Seedream / 豆包 vision（DeepSeek 无视觉）。**开发顺序（2026-08-15 改定，2026-08-18 更新）**：G0 Cloud 异步图片生成与 VPS 可靠性闭环**已完成上线**（0015 generation_jobs + 0019 understand_jobs，单容器双循环 Worker）；桌面 Agent 仍保持“常规生成的可选 prompt 预处理”最小形态（约定 28），后续为 A2（VPS Worker 跑 Skill）与 A4（桌面接 agent-run）。

26. **Agent 对话与项目视觉设定（2026-08-13）**：Agent 只支持三个结构化交互节点：计划前有限澄清、计划审批/修改、结果接受/一次精修；工具运行期间不开放聊天。澄清模型只能提议，Kernel 按问题必要性、重复、次数和 intent field 影响决定是否询问；回答编译为 `IntentPatch`，变更已批准计划时必须使旧 hash 失效并重新审批。项目长期统一视觉采用**视觉设定**而非“品牌”模型；来源必须是用户在当前项目主动选择的专用普通文件夹，提炼输入严格限定为点击瞬间“项目成员 ∩ folder_id”的已有最新反推数据。视觉设定提炼**永不上传或读取图片、不调用视觉模型、不自动补反推、不扫描整个项目、不监听素材变化、不自动重算/提示**；数据不足就停止并请用户自行整理/反推。每次按钮点击冻结 `source_scope_hash` 并产生 draft，用户确认才把结构化规则/来源本地落盘为新版本。可选方向验证图仅用候选规则纯文生图且 `reference_assets=[]`，它验证的是文字规则可用性，不是原素材看图理解；未确认不入库、不成为设定证据。已确认 `VisualProfileCapsule` 可供直接生成、智能精修、系列创作导演读取，但任何 Agent/生成结果都无权反写视觉设定。

27. **本机 Agent 预览先行（2026-08-14；series-director 方向 2026-08-15 已被约定 28 取代，对应 checkpoint/审批/复检代码已删；本条仍有效的规则：`local_agent_runs` 隔离、ProseMirror 结构化输入为权威、DeepSeek key 不进 React）**：checkpoint 必须独立落 `local_agent_runs`，不得把 Agent phase/审批/工具账本塞进 generation `task_queue`；本机 Agent 复用现有 `GenProvider` 与 `UnderstandProvider`，但该预览不冒充 cloud lease、跨设备恢复或 Agent 统一积分结算已经完成。创作板的 series 输入必须来自 ProseMirror 结构化 image→dimension 连接，禁止把已经展开的长 prompt 重新当作权威输入；模型只负责语义提炼与逐项判断，绑定完整性、prompt 组装、禁止串扰、criteria 完整性、修正范围和生成次数均由确定性代码控制。DeepSeek key 仅从 gitignored `apps/cloud/.env` 由本地 Node 子进程读取，React 不持 key，release 构建不开放该入口；真实本机闭环验收后再移植 VPS。

28. **初版 Agent 改为常规生成的可选 prompt 预处理（2026-08-15，覆盖约定 25/27 中 `series-director` 的当前开发顺序；2026-08-18 拆为 A/B 双方案）**：用户入口只有生成按钮旁的「Agent」开关（不另设 Director 模式），现为互斥三态——**Agent A（子句挑选）**：模型只挑维度原文子句索引 + 职责归属，确定性编译器拼合（不改写任何反推正文）；**Agent B（skill 审查修复）**：输入含模板展开后的完整 prompt（`expandedPrompt`），按官方 bowerbird-prompt skill 审查修复；关闭时沿用原编辑器 prompt 直发。开启后执行“原始 prompt（B 另加完整 prompt）+ 已选参考图维度数据 → DeepSeek 结构化分析（内置 Skills 可选，初版为空）→ 确定性编译最终 prompt → 原 GenProvider 生成”。初版没有独立 Run、审批、生成后验收或自动修正；完整 Agent Kernel/控制面保留为未来真正需要暂停恢复的多步骤 Skill 基础设施，不驱动当前桌面 Agent 模式的复杂度。prompt agent 只发送已选维度的文字反推数据，不读取图片；React 不持 DeepSeek key，开发态仍由本机 Node Worker 从 gitignored `apps/cloud/.env` 读取。

29. **Agent 模式不设参考图最低数量或固定职责维度（2026-08-15）**：Agent prompt 预处理允许 0 张参考图，也允许参考图未选择任何维度；选择维度时接受编辑器中的任意既有或自定义维度名，不要求凑齐“主体 / 构图 / 类型 / 风格”等固定角色。模型只能逐字回传实际存在的 `(assetId, dimensionKey)`，不得新增、遗漏或换绑；没有参考数据时只优化用户原始 prompt。当前仅保留每次最多 8 张参考图的输入体积上限，不构成最低数量或职责门槛。

30. **Agent 模式入口 release 门控：条件渲染隐藏，功能开发完还原两处即可（2026-08-16）**：发布安装包不含 Agent 对外入口——[CreationBoard.tsx](apps/desktop/src/components/CreationBoard.tsx) 与 [GenerationPanel.tsx](apps/desktop/src/components/GenerationPanel.tsx) 的「Agent」开关包在 `{agentAvailable && (...)}` 条件渲染内。release 构建下 `local_agent_health` 被 `ensure_preview_enabled()`（`cfg!(debug_assertions)`，[commands/agent.rs](apps/desktop/src-tauri/src/commands/agent.rs)）直接拒绝 → 前端探活失败 → 开关不渲染；详情页 LocalAgentPanel 同理由 `if (!available) return null` 不渲染；agent-worker 也不进安装包（tauri bundle resources 只含 `extension/` 与 `samples/`）。dev（有 `apps/cloud/.env`）下开关照常可用，Agent 开发不受影响。**Agent 功能开发完毕后，只需把这两处 `{agentAvailable && (...)}` 包装还原为无条件渲染即可恢复对外入口**，无需剥离代码或维护发布分支。

31. **Cloud 生图档位数据驱动：service_costs 是菜单唯一权威，上新零桌面发版（2026-08-17）**：桌面创作板/编辑坞下拉的 Cloud 档位从 entitlement 的 `generation_services` 动态渲染——数据源是 `service_costs` 中 active 且 `parameters.label` 非空的 `image_*` 行（`parameters.sort` 排序、`unit_cost` 即积分）；**parameters 无 label = 不进菜单但保持可计费**（遗留 `image_sd` 即此形态，旧安装包依赖它）。上新档位只需：① `service_costs` 插行（label/sort/unit_cost）；② 需要独立模型时 VPS `.env.generation` 加 env 并 `--build` 重启（Worker 对未知 service 兜底 `ARK_IMAGE_MODEL`，不崩任务）；③ 桌面零改动。provider key 规范 `bowerbird-cloud-<service>`，桌面/云端全部按 `bowerbird-cloud` 前缀识别；遗留 key（裸/`-fast`/`-lite`/`-standard`）映射见 Rust `cloud_service_for_key` 与前端 `canonicalProviderKey`，新代码不得再引入枚举式档位定义。generate-proxy 侧校验恒为「`image_*` 形状 + active 行」双查——形状检查防的是把 `video_*` 等高价 service 当生图扣费，不可去掉。

32. **图片标注：analyses(kind=annotation) + 库根 annotations/ 临时缓存 + featureFlags 未完成功能门控（2026-08-18）**：标注是「画在图上的指令」，不是反推数据——坐标一律**火山 Seedream 交互编辑格式**（0-999 归一化整数；rect `<bbox>x1 y1 x2 y2</bbox>`、arrow 双 `<point>`；坐标相对最终输出图 = 发给模型的参考图）。两条出口语义不同：**入库** = ingest（source=annotation、命名「原名-标注」、跳过 auto-analyze）+ 坐标 JSON 落 `analyses(kind=annotation)`（payload schema 以前端 [types.ts](apps/desktop/src/lib/types.ts) `AnnotationMeta` 为权威，Rust 只读 `shapes[].token` 合成「标注」维度、格式异常静默跳过；caption 并存时「标注」追加在反推维度之后，多条取最新）；**不入库插创作板** = `<库根>/annotations/<ulid>.<ext>` + sidecar `{name,ext,annotation}` 临时文件（不写 DB、不自动清理——板草稿引用着；`generation_history` 参考反查未命中时从缓存 + sidecar 合成兜底）。`read_image_data_url` 只放行库根内文件（canvas 防污染 + 防任意本地图读取，canonicalize 防 `..\` 逃逸）。未完成功能统一走 [featureFlags.ts](apps/desktop/src/lib/featureFlags.ts) 条件渲染关闭 UI（首个：`PRESET_FEATURE_ENABLED=false` 隐藏「用途」入口），完成后改回 true 恢复——与约定 30（Agent release 门控）同款「条件渲染隐藏」模式。

33. **远程 prompt 配置：内置默认永远保留，远程只是覆盖（2026-08-18）**：桌面内置 agent 指令（首个：`understand_autoname` 生成图命名）可经 Supabase `prompt_configs` 表（0020）云端热改——entitlement 权益快照随 `generation_services` 同模式下发 enabled 行，桌面按 key 查找；**缺 key / disabled / 值空白 / 离线一律回落代码内置默认，内置默认不得删除**（远程是覆盖不是迁移，删行即回内置而非功能失效）。编辑 = Supabase Studio UPDATE 行，无 Edge 重部署、无桌面发版；RLS 拒绝全部客户端直读，仅 service-role entitlement 函数可读。校验：[check-prompt-configs.mjs](apps/cloud/scripts/check-prompt-configs.mjs)。

34. **生成会话续轮语义：会话共享状态 = 图片流，参考图/比例后端权威（2026-08-19）**：续轮（resume 同一 session）实际下发的参考图与比例由 `codex_create_image` 权威决定，前端只传显式挑选图与显式选档（`job.turns` 是易失内存，不得作为续轮参考图依据）。规则：① jimeng/Cloud 续轮**始终合并**会话「最后一个有图轮」的产出图（修改主体，产出在前、与显式挑选图去重截前 10）——「挑了新参考图就完全替代」是被实测否定的旧语义（见踩坑）；② 「自动」比例按**第一参考图**（续轮 = 上一轮产出）对数距离吸附 7 档显式下发（即梦 omit `--ratio` 固定回退 16:9）；③ **轮级重试/编辑 = 精确重放**（`exact_references=true`）：用该轮当时实发的完整参考图列表（`started` 事件回填 `GenTurn.refs`、meta 按轮 `references` 重建），不取会话最新产出——重试第 N 轮的基图就是当时的基图；④ **跨引擎切换 = 图片交接**：codex thread 看不到别家引擎的轮，上一产出轮非 codex 时显式附最新产出图；非 codex 原生会话切 codex 开新 thread（instruction 用首轮包装），meta `codex_thread` 字段为续接句柄（与即梦 submit_id 对称）使连续 codex 轮共享 thread；⑤ 簿记 session id 恒为会话首轮 id（meta / 前端 sessionId / 重启时间线 / 会话分组不因新 thread 或恢复续查撕裂）。

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
- 解决：新增 [`open_dreamina_login`](apps/desktop/src-tauri/src/commands/jimeng.rs) 命令，**拉起真正的系统终端窗口**（Windows `cmd.exe /D /C start "" cmd.exe /K "dreamina login"`、macOS `osascript`→Terminal.app `do script`）跑 `dreamina login`——真 TTY 保证 dreamina 完整走完 OAuth + 写 token。对称 [`open_codex_session`](apps/desktop/src-tauri/src/commands/codex.rs)（codex「在终端打开会话」已验证同模式）。[`DreaminaLoginDialog`](apps/desktop/src/components/DreaminaLoginDialog.tsx) 主按钮「打开终端登录」调该命令 + 复制命令降为兜底。端到端实测通过。**未采用的备选**：方案 B（`--headless` + `checklogin` 纯 in-app，UX 更好不弹终端）——headless 不依赖 TTY、机制可行（SKILL.md 证实 device flow 打印 verification_uri/user_code/device_code 后退出，checklogin 跨进程补完写 token），但 device_code 时序敏感（2026-07-24 踩过「过期」）+ headless 输出格式 / checklogin 在 app spawn 写 token 未实测，且即梦登录一次性、方案 A 已够用；保留 dead 的 `dreamina_login`/`dreamina_check_login` 命令备方案 B 复用。
- 教训：① CLI 的交互式 OAuth（渲染二维码/链接 + 等 authorization）常依赖 `isatty(stdout)`，GUI app `Stdio::piped()` 会破坏 TTY 身份触发早退——先查 isatty，别往 console/credential store/DPAPI 方向猜。② 命令行验证通≠app spawn 通；登录类操作若必须交互式，拉起一个真终端窗口（真 TTY）是最可靠的 app 内方案。③ 实测 CLI OAuth 时优先翻 `~/.dreamina_cli/logs/`，进程「持续 poll 到完成」vs「早退」一眼可辨。
- 相关文件：[commands/jimeng.rs](apps/desktop/src-tauri/src/commands/jimeng.rs)（`open_dreamina_login`）、[DreaminaLoginDialog.tsx](apps/desktop/src/components/DreaminaLoginDialog.tsx)、[commands/codex.rs](apps/desktop/src-tauri/src/commands/codex.rs)（`open_codex_session` 模板）。

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
- 相关文件：[commands/jimeng.rs](apps/desktop/src-tauri/src/commands/jimeng.rs)（`dreamina_login_headless`）、[DreaminaLoginDialog.tsx](apps/desktop/src/components/DreaminaLoginDialog.tsx)。

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
