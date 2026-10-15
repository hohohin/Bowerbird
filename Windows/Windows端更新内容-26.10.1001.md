# Windows 端更新内容 — 26.10.1001

核对日期：2026-10-15。用途：Mac 接收 Windows `dev` 增量的源码交接清单。项目当前决策以 [PROJECT.md](../PROJECT.md) 为准。

**版本口径：Windows 最近发布的是 26.10.1001；本文件还包括其后未发版的源码。** 表格管道、Agent 会话生图、视频播放器/截帧、完整错误查询不在现役 1001 安装包内。本轮存档不提升版本、不打包、不发布 Mac。

## 1. 对比基线与接收范围

| 项目 | 核对结果 |
|---|---|
| 上次完整接收的 Mac 基线 | `d6027fb8280ce8ab9452fe06ad04bcbcde178bfe`（含 `08ada63`） |
| 本次重新 fetch 的 `origin/mac` | 仍为 `d6027fb`，也是与当前 dev 的共同祖先 |
| 本次存档前 `dev` / `origin/dev` | `55f4d9380b746d5e51831e54e81fa3bc15045143` |
| 已提交差异 | `d6027fb..55f4d93` 共 12 个提交，另加本次视频与诊断源码/文档存档 |
| 最新接收目标 | 包含本文件及第 4 节新增源码的存档提交；接收时核对 Git 提交，不能只看版本字符串 |
| 当前 Cargo / Tauri 版本 | `26.10.1001`，本次未提升 |
| 公开更新清单（本次只读核对） | Windows `26.10.1001`，Apple Silicon Mac `26.10.801`；未重新下载或验签安装包 |

基线已具有 Codex CLI 适配、Agent 图文协议、循环起点/恢复、数据包交换、Codex 退出登录、截图贴图等能力。它们不是本轮 Windows 新增；Windows 的重要差异是正式构建开放、后续协议与交互修复。旧交接见 [2026-10-10 记录](../macOS/DEV-SYNC-2026-10-10.md)，本文件补齐 1001 之后的变更。

## 2. 按版本与日期列出的更新

| 版本 / 阶段 | Windows 更新内容 | 关键提交 / 发布状态 |
|---|---|---|
| 26.10.901 | 画板容器封装、布局预览、模板 v3 布局复用；接收 Mac 共享工作流及原生适配 | `45d5652`；补合 Mac 遗漏内容为 `e9eb482`。901 包的旧 Agent 限制由 902 修正 |
| 26.10.902 | 正式版开放本机 DSH 与 Codex CLI Agent 图文输出；隐藏技能卡片/模板库入口；release 请求目录转应用数据目录 | `3250bb4`，发布记录 `fcbae72`；已发布，替代 901 |
| 26.10.903 | 生成卡新增图片/视频模式；即梦/方舟参数与结果恢复；查询临时超时按原任务有限续查 | `e1fe0e8`；已发布 |
| 26.10.904 | Windows 应用内更新保留 Bowerbird、Codex、Dreamina 登录；手动重装仍按原规则重置 | `78eb8e6`；已发布，NSIS 专属 |
| 26.10.1001 | 多张画板结果可以作为普通引用发送；只有明确继续/重试才绑定父结果 | `3d46e3a`，发布记录 `640551e`；当前线上 Windows 版本 |
| 1001 后，2026-10-13 | 二维表格粘贴/传递/回写、循环当前轮次、Agent 生图投递普通会话、非法比例反馈、画板交互与 Windows Codex 沙箱预检 | `55f4d93`；源码已存档，未发版 |
| 1001 后，2026-10-14 实现 / 10-15 存档 | 视频胶片播放器、截帧入画板、StrictMode 播放修复、即梦完整错误查询与诊断落盘 | 与本文件同一存档提交；未发版 |

## 3. 1001 及之前：Mac 需要接收的共享功能

### 正式版 Agent 与入口

- 正式构建开放「本机 Agent DS · 图文处理」「Codex CLI · 图文处理」，Cloud DSH 保持文本契约；本机支持文字、表格、图片与混合结果。技能卡片/模板库入口保持隐藏。入口隐藏不等于删除模板、容器或文件协议代码。
- UI 选择器、输入、输出端口和运行时必须一起接收。Rust 仅开放工作流 `purpose=agent-text`，仍校验 BYO 权益；旧聊天/规划入口继续受原开发限制。
- release `.agent-z` 使用应用数据目录。Mac 为 `~/Library/Application Support/com.bowerbird.desktop/.agent-z/`，含 `ds-inbox/` 和 DSH `workspace/`；debug 保留仓库路径。安装后的 release 包必须验证含空格路径与权限。
- 每卡会话、循环隔离、冻结通道/provider、持久化任务身份和原请求恢复仍须保留。10-13 的生图提交语义见第 4 节，不能只按旧 902 的同步等待流程实现。

主要入口：`CanvasWorkflowLayer.tsx`、`canvasWorkflow.ts`、`canvasWorkflowRuntime.ts`、`commands/agent_ds.rs`、`commands/agent_ds/codex.rs`、`commands/codex.rs`。

### 容器与 v3 布局

右键封装为容器、确认面板布局预览、缩放/适应选区；容器固定 `member_ids`，解封保留卡片/连线/内容。`.bbworkflow.json` 新写 v3，兼容读取 v1/v2，保留相对几何、公开输入、未连接内容卡和 `enclosed`。Rust `workflow_encapsulate` 在同一事务保存容器/几何/revision/可选模板，失败回滚；不能遗漏 IPC 注册。模板不携带账号、会话、任务身份或私有路径，既有循环/本机通道便携限制保留。

一起接收 `SaveWorkflowTemplateDialog`、`WorkflowTemplateLibrary`、`WorkflowTemplatePreview`、`workflowTemplatePreview.ts`、`workflowTemplates.ts`、`workflowTemplateContent.ts`、`canvasNotes.ts`、`commands/workflow_templates.rs` 和对应 CSS/API。

### 视频生成卡与多结果引用

- 生成卡保存图片/视频类型及独立视频参数，即梦/方舟沿既有四模式契约；正文 `@` 的参考顺序必须保留。视频结果沿 job/turn 与普通入库链路恢复，不能重载后重新提交。
- 界面输出标「视频」，持久化端口仍用 `image` 兼容已有连线。视频卡可复制，模板/数据包导出暂明确拒绝，不能静默降成图片卡。被动预览保持静态封面。
- 即梦查询只对命令层临时传输错误按原 `submit_id` 最多额外重试 3 次，有效响应清零；提交不重试，明确远端失败/登录错误/解析错误/未知状态不按传输超时处理。
- 1001 修复普通多结果引用误要求选择父结果：没有唯一父结果也能创建创作，引用原序和精确节点保持；显式继续/重试仍接回指定结果。

核心为 `creativeGeneration.ts`、`CanvasWorkflowLayer.tsx`、`WorkflowGenerationHistory.tsx`、`canvasWorkflow.ts`、`canvasWorkflowRuntime.ts`、`workflowTemplates.ts`、`codex/jimeng_video.rs`。协议见 [工作流](../dev-doc/CANVAS-WORKFLOW.md) 与 [视频接入](../dev-doc/SEEDANCE-2.5-INTEGRATION.md)。

## 4. 1001 之后：当前源码新增，尚未包含在安装包

### 4.1 二维表格与循环当前轮次（55f4d93）

- 内容统一为二维 `cells`，纯文本为 1×1。WPS/HTML、TSV、Markdown 与显式 JSON 表格粘贴保留空单元格、换行及合并占位；全卡传递包括第一行，不能把第一行自动当表头丢弃。
- 单格输入仅接收 1×1，拒绝多单元覆盖邻格。Agent 回写、内容交付与循环读取使用同一归一化边界；旧 `columns + rows` 在边界兼容。需要跳过第一行时显式从第 2 行开始。
- `WorkflowValue.table.rows` 与引用中的 JSON 保持完整二维结构、单次编码；超过 16000 限制明确拒绝，不截断。混合图片单元位置不丢失，本地实际图片不走 Cloud 文本接口。
- 循环新增十进制「当前轮次」输出，使用真实迭代索引；显式步进不伪造一张内容表。

一起接收 `contentTable.ts`、`canvasTablePaste.ts`、`CanvasTextCard.tsx`、`canvasNotes.ts`、`canvasContentInput.ts`、`canvasWorkflow.ts`、`canvasWorkflowRuntime.ts`、`workflowAgentResult.ts`、`workflowLoop.ts` 与 Rust `core/project_canvas.rs`。

### 4.2 Agent 生图改投普通会话（55f4d93）

- 新增「生成任务」输出，连接可见普通生成会话；请求使用 `localDsGenerationMode: session` / `sessionGeneration: true`。普通会话通过 `returnOnStarted: true` 返回提交结果，循环可以处理下一项，无需等待上一张图生成完成。
- 在回复 `response.submitted` 前冻结 provider 并保存 job、turn、session 节点身份。恢复只查询原任务；停止工作流不自动取消已经交给普通会话的任务。
- 旧内部生图请求保留兼容协议。不能只改前端输出口而漏掉 Rust、持久化与恢复链路，否则容易丢任务或重复提交。
- 生图比例只接受约定的 7 种值或空值；例如 `3:5` 返回 `invalid_ratio`，不擅自近似。允许 Agent 通过新的调用修正，原调用结果保持一致。

一起接收 `commands/agent_ds.rs`、`commands/agent_ds/codex.rs`、`agent_generation_wait.rs`、`core/project_canvas.rs`、`api.ts`、`CanvasWorkflowLayer.tsx`、`CanvasWorkspace.tsx`、`canvasWorkflowRuntime.ts` 及会话生成回归。

### 4.3 画板交互与 Windows Codex（55f4d93）

普通会话图片可独立点击，输出端口常显；拖入素材的标注与草稿引用已移除节点场景修复。Windows Codex 使用 `windows.sandbox="unelevated"`、`workspace-write` 和 `-a never`，执行前做真实受限沙箱创建/读取/删除预检，30 秒超时并支持取消；失败不调用模型，不退回无沙箱。终态缺失可从有界最后 Agent 消息补诊断，仍必须通过终态信封校验。此 Windows 预检不应移植为 Mac 启动参数。

### 4.4 视频播放器、截帧与 StrictMode 修复（本次存档）

- Lightbox 换用 `VideoPlayer.tsx` / `.css`：中央指针固定、胶片横移，拖动暂停；方向键 0.1 秒，细调 0.01 秒。是时间步进，不宣称任意帧率逐帧寻址。
- 停止播放且完成寻址/解码后，按视频原始尺寸生成 PNG 并添加到画板，优先在源视频旁避让落位。使用 `videoFrame.ts`、`import_image_bytes` 与现有画板写入队列；来源 `video-frame` 跳过自动反推/命名。
- 保存冻结原项目、节点和时间；入库成功而画板写入失败时重试原写入，不重复导入。关闭预览或切换项目不把迟到结果写到新项目。
- 播放器 `preload="none"`，用户播放后才用一个有时限的解码器采样 12 张缩略图，关闭/换源释放资源。StrictMode 清理删除 src 后，setup 必须恢复 src，否则开发模式无法播放。

同步入口：`Lightbox.tsx`、`CanvasWorkspace.tsx`、`CanvasConversation.tsx`、`GenerationPanel.tsx`、`commands/library.rs`，以及上述新增播放器文件。**没有新增 FFmpeg 运行依赖**；浏览器测试制作三色视频夹具时才需要 FFmpeg。

### 4.5 即梦完整错误诊断（本次存档）

- 失败视频轮显示「查询完整错误 / 复制完整诊断」，精确按原编号执行 `query_result --submit_id` 和 `list_task --submit_id --limit 1`，不下载、不重投、不改变任务终态；两路查询各自记录退出码、响应、stderr 与失败。
- 保存脱敏后的上游错误码、嵌套 JSON、logid 等；扫描精确编号的 CLI 日志，限最近 24 文件、每文件尾部 512 KiB、最多 60 条。没有子码就保留未知原因，不能把通用失败猜成审核/尺寸/余额；积分数字不是扣费或退款流水。
- 报告落应用数据目录 `diagnostics/dreamina/<submit_id>.json`，落盘错误单独展示；切换卡片时迟到响应不能串任务。新发生的查询/生成失败也保存脱敏原响应与 CLI 诊断。
- 当前 Windows 读私有 profile 下 `dreamina/.dreamina_cli/logs`；Mac 分支读 `$HOME/.dreamina_cli/logs`。Mac 必须核对实际官方 CLI 的日志位置与登录环境，不照搬 Windows APPDATA。

必须同步新增 `codex/jimeng_diagnostics.rs`、`creation/DreaminaTaskDiagnostics.tsx`，以及 `codex/mod.rs`、`codex/jimeng_video.rs`、`commands/dreamina_account.rs`、`src/lib.rs` IPC 注册、`api.ts` 与 `GenerationPanel.tsx`。验证/历史真实只读查询边界见 [视频接入记录](../dev-doc/SEEDANCE-2.5-INTEGRATION.md)。

## 5. 平台、数据与发布边界

| 内容 | Mac 接收规则 |
|---|---|
| Windows NSIS 更新钩子、登录重置测试 | 保留 Windows 条件；不复制到 Mac 更新/钥匙串流程 |
| `build.rs` Windows resource / Common Controls | 保留目标平台条件；Mac 不执行 Windows 链接 |
| Codex 沙箱及原生测试 | Unix 分支/夹具保留；Mac 验证自己的受限写入和取消，不使用 Windows launcher |
| Mac 配置 | 保留 `tauri.macos.conf.json`、Mac updater 公钥、DMG 固定拖动布局、签名身份、WKWebView/钥匙串与媒体实现 |
| 版本号 | 1001 是 Windows 发布号；Mac 真正发版时另按 Mac 版本规则同步 Cargo.toml/Cargo.lock/tauri.conf.json，不把合并源码当作发布成功 |
| 数据库/服务 | 本范围未新增 SQL 迁移、Cloud/Worker 部署或依赖包；桌面仍至 0033，Cargo.lock 仅应用版本差异。新结构沿现有 JSON 存储 |
| 官网 | 仓库网站仍为 Windows 902 快照，线上为 1001。Mac 发布不得整站覆盖造成 Windows 下载入口回退；先核对现役清单再只更新目标渠道 |

不要传输 `.tmp`、`.agent-z`、AppData、签名密钥、`.env` 或登录资料。旧 Mac 801 不保证能理解 v3 布局及新增 JSON 字段，升级与降级均使用数据副本验证。

## 6. 验证证据与 Mac 验收

本次 2026-10-15 复核：

- TypeScript `tsc --noEmit`、Vite production 隔离构建通过。首次受限环境类型读取失败，完整依赖读取下复跑通过；未修改业务源码来规避类型检查。构建仍有既有大 chunk 提示。
- `video-diagnostics-ui`、`video-player-ui`、`canvas-media-ui`、`media-lifecycle-ui` 四组浏览器回归通过，覆盖 StrictMode、真实变色 MP4/PNG 像素、保存失败重试、跨项目迟到保存与资源清理。
- Rust `cargo test --offline --locked --lib codex::jimeng` 在隔离 APPDATA 与原生 launcher 中 **11 passed / 0 failed / 1 ignored**，覆盖离线 CLI 提交/取回/取消、错误诊断与日志匹配。真实已有任务查询默认忽略，不在本次复核执行；保留既有编译警告。
- 无真实模型调用、正式素材库修改、安装包构建或 Mac 原生验收。

已存档的历史证据：1001 的 70 项逻辑、三组画板合成 IPC、正式构建/签名/公网包验签；10-13 的 14 组浏览器及正式 Codex Agent、9 项前端逻辑、Rust Agent 27 项（2 ignored）、原生等待 1 项、画板 27 项、显式离线 Codex 沙箱 1 项通过。它们不是本次重新运行的结果，具体范围见 PROJECT 与专项文档。

Mac 接收步骤：

1. 保存 Mac 本地工作，执行 `git fetch origin dev mac`。确认 `origin/dev` 包含 `55f4d93`，并通过下列命令找到包含本文件的存档提交；如果文件不存在，说明尚未收到本次存档，不能只同步 55f4d93。

   ```bash
   git merge-base --is-ancestor 55f4d9380b746d5e51831e54e81fa3bc15045143 origin/dev
   git log --oneline origin/dev -- 'Windows/Windows端更新内容-26.10.1001.md'
   git diff --stat d6027fb8280ce8ab9452fe06ad04bcbcde178bfe origin/dev
   git show origin/dev:apps/desktop/src-tauri/src/codex/jimeng_diagnostics.rs
   ```

2. 合并核对后的 dev 提交；无额外分叉可快进，有 Mac 新提交则正常合并。不要 reset 覆盖本地内容，不要只摘 UI 文件而遗漏后端、IPC、持久化和测试。
3. 运行 TypeScript/Vite、Rust 库与工作流/模板/Agent/视频回归。新增测试入口为 `canvas-table-paste`、`canvas-table-roundtrip`、`canvas-workflow-agent-session`、`video-player-ui`、`video-diagnostics-ui`（均在 `apps/desktop/scripts/`）。视频播放器测试通过 `BOWERBIRD_FFMPEG_BINARY` 指向 Mac FFmpeg，默认 Windows `.exe` 路径不能直接使用。
4. 在隔离库及实际 WKWebView 验证 Cmd 粘贴表格、首行/空格/图片位置、循环当前轮次、Agent 任务投普通会话与中断恢复、release DSH/Codex 图文入口、应用数据目录权限、视频拖动/细调/原尺寸截帧及换项目保存、错误查询与日志路径。缺 CLI/未登录/无 BYO 权益应明确提示。
5. 若另行发布 Mac，遵循 [Mac README](../macOS/README.md) 与 [桌面更新](../dev-doc/DESKTOP-UPDATES.md)，完成稳定签名、公钥、DMG 布局、原生更新/重启和公网验签。Windows 浏览器合成 IPC 的通过不能替代这些检查。
