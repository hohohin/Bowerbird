# Mac 跨端同步说明（2026-10-15）

项目决策以 `PROJECT.md` 为准，工作流协议见 `dev-doc/CANVAS-WORKFLOW.md`。

## 范围

上次远端推送基线为 `2392ebc6979d438496f4fe58f13d20032ff9aa7a`（10 月 15 日 Intel 26.10.1501 签名交接）。本机起点 `4cc1faf` 与它分叉：本地 15 个历史提交、远端 5 个历史提交，另有本机未提交工作流增量。本机增量已存档为 `58b4997`，随后合并远端；保留两条历史，不强推。用户追加要求以远端 Mac 更新本机 Apple Silicon 代码，已纳入本次组合验证。

**推送状态：** 已通过本机 12000 代理恢复连接，完整源码已推送 `origin/mac@5fecb7c`，包含下方追加发包功能；其他端可按共同祖先合并接收。

## Intel 后续源码同步与存档

本轮本机从 `c718c0b` 快进至远端 `9d99745`，恢复本地未提交改动并解决五处冲突。保留远端发布记录及工作流撤销、表格、Agent 会话交付、分享 v4；新增卡片继续使用 `CanvasWorkflowLayer` 的可撤销 `edit` 路径，仅改变手动放置位置与视口行为。合并前改动保存在本机命名 stash `archive-before-origin-mac-sync-20261015`，临时截图和缓存不入 Git。

- 自动分类改为三个 Choice 共用标签池，Cloud 只补缺失维度并最多四张并行；后端状态和前端三组概率／队列进度必须一起同步，新增 `local_classification/pipeline.rs`。标签仍按普通名称／说明保存，无维度字段或迁移。
- 素材缩放新增 `useThumbnailPinch.ts`、`useMasonryLayout.ts`，主页悬浮滑块、项目素材栏缩放、平滑布局与相关 CSS 必须一起同步。项目卡单击进入，右上按钮单独展开。
- 卡片按钮改为选中工具后点击画布或拖放；测试同步使用 `scripts/fixtures/canvas-reference/place-card.mjs`，保留远端图片列输入及 Agent 执行引擎断言。素材栏切换动画结束后再测量画布坐标。
- 版本沿用远端 26.10.1502／SQLite 0034，本轮源码尚未纳入已有 ARM 1502 或 Intel 1501 包；真实 Jev/Cloud、WKWebView 手势／拖放与 Windows 原生体验仍需另验。本轮不发布安装包或切换官网。

本轮合并后验证：Rust 库 **499 passed / 0 failed / 10 ignored**（无过滤；真实模型／平台专项 ignored 项未运行）、画板逻辑 **135/135**、TypeScript/Vite 构建通过，保留既有 Rust 警告与 Vite chunk 提示。**24 组隔离 Chromium 界面回归通过**，覆盖卡片放置／框选／内容卡／素材栏、Agent／循环／发条／编排／规范、撤销／视频／分享、探索／导入、分类、主页布局／动画／缩放与项目入口／重命名、工具栏。素材布局首次导航超时，单独复跑最终无诊断版本通过；不将初次失败记为通过。最初沙箱回环监听受限的测试已获准复跑；旧框选夹具起点避开新工具栏与卡片名称输入，初始化测试沿当前 Agent 要求名称，远端撤销／视频测试改为显式放置。全部使用隔离库／模拟 IPC，不操作真实用户库或付费模型。日志在本机 `/tmp/bowerbird-archive-*.log` 与 `/tmp/bowerbird-archive-ui/`，不提交截图或缓存。

## 追加发包（26.10.1502）

用户追加要求存档、推送并发包。原直连 GitHub 超时已通过本机 12000 代理恢复连接；本轮将新增循环/视觉规范卡结构分享 schema v4 一并存档，新版本为 26.10.1502，SQLite 保持 0034。分享白名单不携带个人规范或运行状态，默认空白内容导入，兼容 v1–v3；前后端必须同时更新。固定提交 `5fecb7c` 的 ARM64 包已上传 R2，完整公网哈希与原公钥验签通过；官网仍为 26.10.801，待 SSH 发布。完整结果以 `dev-doc/DESKTOP-UPDATES.md` 本版记录为准。下文未打包等表述为上一阶段源码同步边界。

## 本机新增功能

- 内容卡按行／列接收图文，沿对应方向追加；稳定单元格身份、写入中断恢复与旧主输入兼容，单格入口仍覆盖。
- Agent 生图确认提交后即将精确生成会话写入目标格，不等待最终回复；保存目的地及交付标记，重载补交付不重投。
- Agent 统一图片输出兼容旧 session 输出；真实像素消费者等待原任务完成，内容交付可立即保存会话引用。
- 普通会话拖入内容格、单击回原会话／双击放大、清空后恢复原会话；完成态显示原比例纯图片，保留名称与悬停端口。
- Agent 运行详情显示冻结输入、公开进度、生成任务和结果；Codex 不保存内部推理、原始命令或工具输出。
- Agent 接入已确认的视觉规范，冻结版本和规则；恢复取原快照，新任务断线停用旧规范。
- Agent 可引用输出位置并定向交付，原图分类不重复生图；显式比例交给 provider 校验，不设额外白名单。
- 工作流新建/复制/删除/连线/参数接入统一撤销，保留较新执行输出和运行锁；循环起始项按真实输入预览、随输入变化校验，恢复使用冻结输入。
- 连线默认淡化，选中实际可见端点恢复类型色，精确实例与内容 writer 关联保持。

## 同步边界

本轮同时带入本机已接收的 Windows dev：正式版 DSH/Codex Agent、视频生成卡、更新保留登录、多结果引用、二维表格与循环轮次。已包含这些提交的接收端应按 Git 共同祖先合并，不重复 cherry-pick。

远端既有 Intel 文件浏览/外部引用、SQLite 0034、分类/截图/布局及发布签名改进需要一并保留。26.10.1501 已有 Intel 包不包含本次后续工作流功能；本次不打包或切换更新通道。当前本机源码已包含上述远端增量，ARM64 debug 可执行文件已重新编译；不自动重启用户正在运行的桌面应用。


## 已同步到本机 Apple Silicon 的远端内容

下列能力在 `2392ebc` 中已存在，属于本次接收并保留的基线，不应误算为本次新发布：

| 能力 | 共享实现与平台注意事项 |
|---|---|
| 本机文件浏览与外部图片引用 | 新 `LocalFileBrowser`、external_files 命令/数据库方法与 SQLite `0034_external_assets`；浏览只建预览缓存，引用原文件路径，缺失/变更需按协议确认；物理删除不得删除外部原文件 |
| Jev 图片匹配与 Cloud 补标签 | 显式选择/应用本地或云端分类；Jev 检查已有标签，仅明确全部不匹配时 Cloud 发现新标签；保留人工保护、上传授权和失败不放行 |
| 分类管理 | 单删/批删标签、当前素材与进度、Jev 分批概率/原始结果面板；本机模型及云端配置保持隔离 |
| 截图与贴图 | 独立 `screenshot.html`/`screenshot-main.tsx`，截图预热、帧获取及像素微调；Vite 多页面入口、Tauri capability 与 Rust command 必须一并同步 |
| 主页/项目素材栏 | 自适应缩略图大小、分类标签筛选，工具栏固定 64px 单行、搜索区伸缩；新组件和样式一并保留 |
| Mac 专属 | 系统代理、Intel 向量回退、原 Mac updater 签名及可信备注验证、架构命名与证书保护；保留 ARM64 的标题栏/WKWebView、钥匙串辅助程序与媒体取帧分支 |

远端文档提到出包后另有 Jev score／三维标签的并行未提交修改；没有进入本次 fetch 的提交，不能视为已接收。本文仅描述已合入的 `2392ebc` 源码。

## 本次相对上次推送的代码入口

| 增量 | 主要文件（相对 apps/desktop） |
|---|---|
| 行列输入、精确生成会话与及时交付 | `src/lib/canvasContentInput.ts`、`canvasWorkflowRuntime.ts`、`canvasSessionOutputs.ts`、`canvasNotes.ts`，`CanvasTextCard.tsx`、`CanvasWorkspace.tsx` |
| Agent 定向交付与规范 | `workflowAgentOutputs.ts`、`workflowAgentProfile.ts`、`WorkflowPromptEditor.tsx`；`src-tauri/src/commands/agent_ds.rs` |
| Agent 详情与公开日志 | `WorkflowAgentDetail.tsx/.css`、`ProjectInspectorShell.tsx`；`commands/agent_ds/codex.rs` 与 `lib.rs` 新命令注册 |
| 撤销和循环预览 | `workflowUndo.ts`、`workflowLoop.ts`、`WorkflowLoopStartSelect.tsx`、`canvasClipboard.ts`、`workflowTemplates.ts` |
| 原生保存兼容 | `commands/canvas_workflow.rs`、`core/creative_session_contract.rs`、`core/project_canvas.rs`；校验 `generation_ref`、行列目标、图片会话输出与循环历史 |
| 生成完成态/连线 | `CanvasConversationImages.tsx/.css`、`canvasConversationCards.ts`、`CanvasWorkflowLayer.tsx`、画板样式 |

其他随本机 15 个提交带入的内容包括 Windows NSIS `/UPDATE` 保留登录、v3 模板封装/预览/布局、生成视频卡与查询超时恢复、正式 Agent 权益/应用数据目录、二维表格和网站历史快照。其背景见 `macOS/DEV-SYNC-2026-10-10.md` 与 `DEV-SYNC-2026-10-13.md`。本轮没有部署网站；仓库双首页仍含旧 Windows 902 快照，不能直接整站覆盖现役 Windows 1001。

## 兼容与发布边界

- 相对本次远端基线没有新增 SQLite 迁移；接收端若仍为 0033，必须带上已有 0034 及 migrations 注册。新工作流字段是 JSON 契约变化，前后端要同时更新，不能只替换前端包。
- Agent 可保存 `outputs.image.nodeIds`（生成会话）而无 `assetIds`，后端须接受这种形状；旧 `outputs.session` 仍可恢复。任务凭据不代表已生成图片，不得让像素处理节点提前读取，也不能为补交付重提模型。
- 行列方向及成员身份、每步目的格、Agent 及时交付记录、冻结输入/规范和循环历史都需保留；不要用旧版本保存并覆盖新工作流。
- Windows 保留 MSVC、WebView2、私有 CLI、FFmpeg 和 NSIS 原生适配；Mac 保留自己的 updater 公钥、钥匙串/签名及 AVFoundation。`.cargo` 的 Mac runner 不用于 Windows。
- Mac 源码版本沿远端 **26.10.1501**，本次未提升版本、未替换现成 Intel 包；未来若以组合源码发包，必须使用新版本并按发布流程验证，不能把旧 1501 包当成本次产物。
- 本次无云端部署、新收费策略、真实模型调用或正式素材库操作。当前运行中的旧桌面进程未重启；新的原生命令/保存校验需下次重启开发应用生效。

## 本轮组合验证

本机 Apple Silicon，使用现有 Node/Rust 依赖，离线构建与模拟 IPC/临时数据库：

- TypeScript 与 Vite production 构建通过（包含截图独立入口），保留既有大 chunk 提示。
- 前端画板/会话/撤销/输出分配/视频/删除等纯逻辑 **165/165** 通过。
- Rust `cargo test --offline --locked --lib`：**491 passed / 0 failed / 10 ignored**；未运行真实模型/下载等 ignored 项。
- 本机 `cargo build --offline --locked --bin bowerbird-desktop` 通过，`file` 确认为 **Mach-O arm64**；没有启动/安装该二进制。
- Intel `cargo check --offline --locked --target x86_64-apple-darwin` 通过，不能替代 Intel 真机运行。
- **29/29 组合成 IPC 浏览器回归通过**：行列输入、及时交付、会话入格、Agent 详情/规范/图片口/定向输出/会话/provider、循环及更新、撤销、连线、会话组图、内容输入/容器/卡片/会话输出/断线/中继、完整工作流、表格粘贴，以及远端文件浏览/素材布局/工具栏/分类/截图/素材栏。连线旧断言和焦点时序修正后两组定向复跑通过。
- DEV=false 的 Codex Agent 与输出位置两组浏览器回归通过；不等同于真实安装后的账号/CLI 验收。
- Mac 更新发布工具隔离回归通过：双架构命名、签名/可信备注与篡改拒绝、缺失签名及不支持架构。

本轮补齐两项旧抽取式画板测试的状态绑定，更新统一图片接口的名称/绿色断言，分类确认弹窗等待实际焦点条件后再断言；均不改产品行为。组合回归日志保存在本机 `/tmp/bowerbird-archive-20261015/`，临时截图、缓存、产物及凭据不入 Git。

## 其他端接收步骤

1. 保存接收端未提交工作，`git fetch origin mac`，核对 `git log --oneline HEAD..origin/mac` 和 `git diff --stat HEAD...origin/mac`，再普通 `git merge origin/mac`。历史已包含的 dev 增量交给 Git 去重，不逐个重复 cherry-pick，不强制覆盖分支。
2. 核对 SQLite 0034、前后端 command 注册、截图多页面入口/权限、工作流 JSON 字段和平台配置。Windows 从 canonical 源码更新 `.work`，不用旧 overrides 整文件覆盖。
3. 运行类型/构建、Rust 与对应合成 IPC 回归；升级验证用素材库副本，覆盖旧流程保存、行列追加、单格覆盖、生成会话收纳/清空恢复、及时交付失败后的零重投、循环停止/接续和撤销锁定。
4. 在目标平台验收原生 WPS/剪贴板、截图授权/混合 DPI/多屏、外部文件移动/缺失/更新、视频与媒体生命周期，以及本机 DSH/Codex 登录与真实生成。合成浏览器通过不等于这些真机步骤已完成。
5. 按平台单独发版并核对当前线上清单，保留他端现役入口和旧公钥。本轮源码已存档推送，ARM64 26.10.1502 安装包已上传并验证；官网更新通道切换待发布侧接续。
