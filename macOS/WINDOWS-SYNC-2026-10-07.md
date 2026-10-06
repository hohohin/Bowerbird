# Mac → Windows 源码同步说明（2026-10-07）

本文件是本次交接快照；项目状态与决策以 `PROJECT.md` 为准，工作流协议以 `dev-doc/CANVAS-WORKFLOW.md` 为准。

## 对比范围

- 上次 mac 推送：`e63841a96aa3c3fc36ce8b32ed6019b8f0e8e5d8`，本地远端 reflog 记录为 2026-09-21 01:42:54 +0800 的 `update by push`。
- 本轮开始时 HEAD：`66c2f1b`，相对该基线有 8 个提交，另有 9 月 24 日至 10 月 5 日的未提交增量。本说明与这些增量一起存档；交接目标为 `origin/mac`；本轮已通过本机代理 fetch 核对，远端仍在上述基线。
- 8 个既有提交包含合入 dev 的历史，不全是 Mac 新功能。Windows 若已包含 `f196d6c`，不要逐个重复 cherry-pick；按共同祖先合并本次 mac 分支。
- 本轮不升级版本号、不打包、不发布官网/Worker/Edge、不执行云数据库迁移。最近记录的已发布版本仍为 Mac 26.9.2002 / Windows 26.9.1803。

| 提交 | 内容 |
|---|---|
| `66c2f1b` | Mac 同步 dev 工作流与模板；修复 DSH 仓库路径的符号链接、大小写及平台差异 |
| `f196d6c` | 模板、planning-v2 编排协议、画板交互与标注出口存档 |
| `c48e89a` | 工作流卡片执行器、内容卡与引用恢复 |
| `6ce7005` | 9 月 22 日 Worker 覆盖层 / Edge 部署记录 |
| `cb8f511` | 工作流首版、Agent DS 队列与 Mac 26.9.2002 发布记录 |
| `523576f` | 新卡跟随参考图落位并恢复生成后聚焦 |
| `dfd5f71` | dev 合入此前 mac 增量 |
| `da0428f` | Windows 既有多选菜单、分区右键、几何撤销、云端单张生成路径等存档 |

## 可同步到 Windows 的功能与修复

### 工作流、内容卡与模板

- 完整卡片工作流：指令、生成、技能、Agent、视觉规范、触发器、内容卡；按依赖并行执行、状态持久化、失败定位、停止及重载恢复。分层统一图片出口，结果可进入内容卡及下游，生成历史保留精确轮次。
- 本地模板库支持框选保存、名称/搜索/版本、选择携带图片和输入文案、参数化子流程、`.bbworkflow.json` 导入导出；实例保留快照，不随模板库更新。planning-v2 助手通过 proposal → 校验反馈 → commit 创建真实卡片，默认不自动执行模型任务。
- 新增独立循环卡，逐张图片或逐行处理，冻结输入列表，一项的全部分支完成后才进入下一项；最多 100 项，保存每项任务身份，重载取回原任务。失败暂停，不自动重提结果未知的任务；暂不支持嵌套/多循环和循环模板分享。
- `@文本 N` / `@图片来源 N` 改为接收卡片自身的输入管道。换上游保持编号，断线不重排，新连接补空编号；不要恢复旧的“token 固定绑定来源单元格”逻辑。
- 所有卡片产出共用内容交付步骤；单独运行也写入已连接内容卡和中继。产出保存后再交付，写入失败可继续，不重复调用已完成模型任务。
- **主输入每次新交付追加，指定单元格覆盖。** 接收区域按执行步骤保存，失败/重载重试复用本次区域；保留历史格 ID、邻格手写内容及下游引用。表格接收范围有明确锚点时可补回缺失行列；歧义或所有权变化仍拒绝覆盖。
- 内容 Note 节点上限从 64 KiB 独立放宽到 **4 MiB**，按 UTF-8 字节计算；其他节点仍是 64 KiB，无 SQL 迁移。
- 多输入线右键可选具体来源断开；卡片默认名称唯一，卡片上方可直接编辑、重名阻止保存。反推缓存归卡片所有，按图片与指令匹配，复制和模板实例不继承运行缓存。

主要入口：`CanvasWorkflowLayer.tsx`、`CanvasTextCard.tsx`、`CanvasCardName.tsx`、`WorkflowDisconnectMenu.tsx`，以及 `src/lib/canvasWorkflow*.ts`、`canvasContentInput.ts`、`workflowLoop.ts`、`workflowPlanner*.ts`、`workflowTemplates.ts`；后端 `commands/canvas_workflow.rs`、`commands/workflow_templates.rs`、`core/creative_session_contract.rs`。

### 本机 Agent 与生成诊断

- 本机 DSH 支持文字、图片、混合输入及无原文写作；每张卡片使用独立且可恢复的会话，普通 Agent DS 通道排除卡片专属会话。
- 支持新版 DSH Cookie 登录和 Typert 接口；本机登录链接来自 Git 忽略的 `.agent-z/dsh-web-auth-url.txt`，Windows 需在本机单独配置，不复制 Mac Cookie/账号或队列。
- Agent 可返回文字、原生表格、图片或图文组合。图片经请求产物目录校验后入库并从「返回图片」出口交付；取消后的迟到结果不落卡。取消应用层固定 10 张输入限制，保留单张 20 MiB、合计 64 MiB 与格式校验。
- Agent 生图/改图使用**投递时的全局标星默认 provider**，请求内冻结；复用既有 Codex/即梦/Cloud 图片链路，不新建普通生成会话卡，不静默换引擎，恢复不重复生成。Cloud Agent 仍保留既有文本改写边界，不能把本机能力当成已上线云能力。
- Codex stdout JSONL 的 `error` / `turn.failed` 优先于 stderr 启动提示显示，额度耗尽不再只显示 `Reading prompt from stdin...`；失败不接收部分答案，正常重连完成仍可用。

主要入口：`commands/agent_ds.rs`、`commands/codex.rs`、`codex/codex_cli.rs`、`core/generation_worker.rs`、`core/task_queue.rs`、`workflowAgentResult.ts`。协议见 `dev-doc/UNIFIED-AGENT-HARNESS-PLAN.md` 与工作流文档。

### 截图、贴图与画板交互

- 工具栏新增截图；设置支持快捷键录入、禁用和恢复默认。默认 F1 区域截图、F3 剪贴板贴图，注册冲突/落盘失败回退。
- 截图支持框选调整、矩形、椭圆、箭头、画笔、多行文字、马赛克、放大取色、撤销/重做、复制 PNG、保存和置顶贴图；贴图可移动/缩放/复制/保存，关闭释放。截图不自动入库或上传，不持久化恢复；当前选区不跨显示器。
- 普通生成按项目和 conversationId 合并为会话组图，默认最新结果、左右切换、数量角标；逐轮原始节点/素材与工作流精确输入保持，移出/撤销覆盖整组。
- Mac 新增 Cmd+Delete，Windows 原 Delete 保留，输入框/输入法/弹窗等保护保持。修复拖动卡片正文时出现原生选字蓝底，编辑器内仍可选字。

新增依赖必须连同 `Cargo.lock` 同步：`tauri-plugin-global-shortcut = 2.3.1`、`xcap = 0.9`、`arboard = 3`。新增 `capabilities/screenshot.json`、`commands/screenshot.rs`、截图设置与独立窗口组件；`main.tsx` 的窗口路由、Rust 插件初始化和 command 注册需一起合并。

### 视频与媒体

- 本机即梦视频通过官方 CLI 对应模式 `--help` 发现模型/分辨率，支持 Seedance 2.5/2.0 系列及模式允许的旧模型；按型号校验时长/分辨率/参考素材。
- 余额读取 `user_credit.total_credit`，逐轮消耗仅取相同 `submit_id` 的 `commerce_info.credit_count`；零值与缺失分开，不用余额差值推算。CLI 未提供生成前报价时明确提示；Cloud 仍限 Seedance 2.5，计费不改。
- 所有被动视频预览使用静态封面或占位，不创建预加载播放器；主动打开详情/集合才有播放器，`preload="none"`。声音关闭时不初始化 AudioContext，resume 去重、关闭释放。
- 共用 `VideoPoster.tsx` / `videoPoster.ts`，后端 `video_poster` 对已登记库内视频串行补封面、缓存并避免解码时持有 DB 锁，前端忽略迟到结果。
- **Windows 保留现有 FFmpeg 工具链**；Mac 的 AVFoundation worker 是平台专属实现，不能替换 Windows 解码路径。

## Mac 专属部分与合并注意事项

| 部分 | Windows 处理 |
|---|---|
| `.cargo/config.toml`、`macOS/run-signed.sh`、`macOS/dev-keychain.c`、`cloud/dev_keychain.rs` | 保留平台条件；仅 macOS debug 用稳定辅助程序访问钥匙串，Windows/release 继续原 keyring。无需复制本机签名证书/私钥 |
| `src-tauri/macos/video_thumbnail.m`、`build.rs`、`main.rs` 的 thumbnail worker | AVFoundation / Objective-C 仅 Mac 编译；Windows 继续非 Mac 分支。不要因目录名为 macOS 而误删 canonical 构建输入 |
| Mac 标题栏、WKWebView、Intel 分类回退 | 保留既有平台分支；不能整文件用旧 Windows override 覆盖新主源码 |
| `macOS/*.swift`、签名/钥匙串 shell 测试 | Mac 隔离验收工具，Windows 无须执行 |
| `.tmp/`、`apps/desktop/.tmp/` 新截图/缓存、根目录孤立包哈希 | 仅本机证据/产物，本次不新增到 Git；测试 fixture 源文件会提交 |

Mac 自签名不能保证每次更新免钥匙串授权；开发版辅助程序只在自身字节保持不变时稳定授权主体，发布包/公证没有在本轮解决。

## 数据、云端与其他随历史带入的内容

- 相对旧 mac 推送新增 SQLite **0031_canvas_workflows、0032_parallel_canvas_workflows、0033_workflow_templates**；已有 dev 可能已经包含。同步 `db/migrations.rs` 与 SQL 文件，不重复编号、不手工跳迁移。9 月 24 日后增量主要扩展工作流 JSON 与设置，不再新增 SQL。
- 新代码写出的循环/管道/图片/交付进度等字段不能假定旧版本可无损解释；Windows 验收使用素材库副本，保留升级前备份。
- 8 个历史提交还带入 Worker 的视觉规范 workflow/schema 2、transparent 透传、公众号排版方法、本机 Agent DS/DSH 适配，以及 Edge、官网管理页面/下载快照与 `logo1.ai` 变化。它们属于完整分支差异，不应遗漏，也不代表本次要求重新部署。
- 9 月 22 日部署记录在 `PROJECT.md` / 既有专项文档中；本轮不重放部署、不新增云迁移、不变更价格或权限。

## 本轮验证与 Windows 接收步骤

本轮重新执行：

- 直接调用已安装 TypeScript/Vite：类型检查及生产构建通过；存在既有 chunk 大小提示。
- 画板、会话组图、生成恢复/意图、视频、Agent 表格解析共 **153/153** 通过；补齐 `creative-canvas.test.mjs` 的会话组图状态和拖动事件夹具，原有删除/撤销/混合拖动断言保持。
- Rust `cargo test --offline --lib` 允许本地监听后全量复跑：**450 passed / 0 failed / 7 ignored**。初次沙箱运行的 11 项失败均来自模拟 HTTP 服务 `TcpListener::bind` 的 `Operation not permitted`（4 项 DSH、7 项分类/下载），本轮复跑已全部通过；7 项 ignored 仍未执行。
- 本轮 **20/20 组 Chromium 合成 IPC 回归通过**：循环、输入管道、多线断开、Agent 图片/provider/表格、表格恢复、统一输出交付、主输入追加、反推缓存、模板、planning-v2、会话组图、删除快捷键、框选拖动、截图、视频控制、静态预览、媒体生命周期与生成通知。
- 历次工作中记录的 Chromium、Mac WKWebView、真实合成视频解码及截图原生隔离结果见 `PROJECT.md`、`CANVAS-WORKFLOW.md` 和 `macOS/README.md`；不等于本轮全部重跑，更不等于 Windows 实机通过。
- 初次沙箱禁止 loopback 监听；Rust 和浏览器回归在授权该权限后执行。pnpm 启动器的联网签名核验因网络不可达失败，本轮没有关闭签名校验，改用已安装的 tsc/Vite/Node 验证。

Windows 接收时：

1. 在 Windows 工作分支保存本地改动，`git fetch origin` 后核对 `git log --oneline HEAD..origin/mac`、`git diff --stat HEAD...origin/mac`，再 `git merge origin/mac`。不要 reset 或盲目覆盖当前分支；若已含 dev 历史，让 Git 按共同祖先合并。
2. 按 `Windows/README.md` 执行 `Windows/prepare.ps1`，从 canonical 源码更新 `.work`，安装匹配的依赖并执行类型检查/构建、Rust 测试。不要复活已退役的整文件 overrides。
3. 用隔离库或升级副本验证 0031–0033、旧画板打开/保存、旧内容卡保留、模板导入导出、循环中断恢复、主输入追加与单格覆盖、Agent 图片回传不重复生图。
4. WebView2 原生验证 F1/F3 冲突回退、屏幕截图、混合 DPI/多显示器、贴图置顶和剪贴板；验收 Delete/Ctrl+Z、正文拖动与编辑选字、会话组图和右键多线断开。
5. 验证 Windows FFmpeg 缺封面补齐、连续切项目与媒体预览、主动播放后关闭、声音启闭；验证即梦 CLI 能力/官方积分读取和历史任务恢复。真实付费生成另行按已有流程验收。
6. Windows x64 编译/安装包与真实升级验收通过后再按发布流程发布；本次 Mac 源码交接本身不是发版。
