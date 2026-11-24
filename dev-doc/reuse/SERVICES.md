# 接口、文件接入与执行服务复用

[返回复用地图](../Bowerbird开发计划.md#复用地图)。入口按运行时标明，复用前核对当前源码和调用。发布与产品约定见 [PROJECT.md](../../PROJECT.md)。

## 网页 Agent 只读代码快照

- **用途／关键词**：代码分享、快照、GPT、Gemini、OAuth。
- **入口**：[core.mjs](../../apps/code-reader-mcp/core.mjs) 提供 TOOLS、callTool、validateSnapshot。[export.mjs](../../apps/code-reader-mcp/export.mjs) 负责脱敏导出，[dependencies.mjs](../../apps/code-reader-mcp/dependencies.mjs) 负责依赖覆盖。
- **调用**：stdio 与 Gemini 通过 [snapshot-store.mjs](../../apps/code-reader-mcp/snapshot-store.mjs) 热读取同一份有效快照。本机[分支控制台](../../apps/code-reader-mcp/branch-console.mjs)复用导出器，按工作区或指定分支的提交切换快照。run-gemini.mjs 通过 oauth-state-file.mjs 管理重启后可恢复的授权状态。
- **边界／状态**：仅供私有开发，HTTP 子进程保持只读。[MCP 接入与维护](../../apps/code-reader-mcp/README.md)。

## 接入图片模型

- **用途／关键词**：即梦网页 Seedream、自有订阅、Cloud 服务目录及默认模型。
- **入口**：[jimeng_web.rs](../../apps/desktop/src-tauri/src/codex/jimeng_web.rs) 管理网页作业，[jimeng_web.js](../../apps/desktop/src-tauri/src/codex/jimeng_web.js) 适配表单。[cloud-generation/runtime.ts](../../apps/agent-worker/src/cloud-generation/runtime.ts) 由独立 service 分派方舟模型。
- **调用**：从 [genProviders.ts](../../apps/desktop/src/lib/genProviders.ts) 查模型、能否使用坐标与 Cloud 兜底；[generate-proxy](../../apps/cloud/supabase/functions/generate-proxy/index.ts) 通过动态 service_costs 和 quote_bcoin_image 报价。
- **边界／状态**：即梦网页通路复用探索浏览器资料、项目任务和入库，只支持单张 2K；中断到即梦创作记录查原单。Cloud 复用原 job／hold，新增模型用独立服务，保留旧单所选档位。[Seedream 5.5 部署](../../apps/cloud/DEPLOY.md#2026-11-13-seedream-55-已部署)。

## 定位、导出及批量处理原件

- **用途／关键词**：原文件路径、外拖、ZIP、后台文件任务。
- **入口**：[external_files.rs](../../apps/desktop/src-tauri/src/core/external_files.rs) 的 Database::resolve_asset_original 共用原件解析；[assetArchive.ts](../../apps/desktop/src/lib/assetArchive.ts) 提供导出。[fileTasks.ts](../../apps/desktop/src/lib/fileTasks.ts) 提供 startFileTask。
- **调用**：菜单和画板在系统选择框前冻结素材 ID，走 [asset_archive.rs](../../apps/desktop/src-tauri/src/commands/asset_archive.rs) 校验及命名。批量操作由 [file_tasks.rs](../../apps/desktop/src-tauri/src/commands/file_tasks.rs) 管理，进度与重试复用 [FileTaskStatus](../../apps/desktop/src/components/FileTaskStatus.tsx)。
- **边界／状态**：只解析当前登记原件或已核验哈希的同素材历史路径。已清理或已回收时阻断；删除仍走独立的 preview_asset_originals 确认协议。[文件契约](../FOLDER-MODE.md)。

## 读取画板可见节点与生成组图

- **用途／关键词**：画板自动接线、组图、显式合组、来源索引。
- **入口**：[project_canvas.rs](../../apps/desktop/src-tauri/src/core/project_canvas.rs) 提供画板读取，[generation_gallery_manual.rs](../../apps/desktop/src-tauri/src/core/generation_gallery_manual.rs) 写入显式合组。
- **调用**：用 api.projectCanvasVisibleNodes 读指定可见实例；历史和会话恢复使用 api.projectCanvasGet。调用 api.mergeGenerationGalleries／undoGenerationGalleryMerge 修改展示，读取上一生成用 previousGalleryGeneration。
- **边界／状态**：catalog 和文件夹用 [with_gallery_cache](../../apps/desktop/src-tauri/src/core/generation_gallery.rs) 共用索引与失效条件。筛选、合组及解散按查询计算，0057 只存展示别名，生成及 provider 身份保持。[工作流](../CANVAS-WORKFLOW.md)。

## 通过 DSH 受控建卡

- **用途／关键词**：对话 v2、本机 Skill、create_canvas_cards、H3 R2V。
- **入口**：[本机 DSH](../../apps/desktop/src-tauri/src/commands/local_chat_dsh_local.rs) 与 [Cloud 桌面桥](../../apps/desktop/src-tauri/src/commands/local_chat_dsh_vps.rs) 复用 [建卡事务](../../apps/desktop/src-tauri/src/core/local_chat_cards.rs) 和 [共享工具定义](../../apps/cloud/supabase/functions/_shared/chat-card-tool.json)。
- **调用**：本机 preset 通过官方插件加载用户 Skill；[Worker](../../apps/agent-worker/src/cloud-chat/dsh.ts) 只加载服务端 Skill。Cloud 通过报价和请求协商 h3_r2v，referenceAliases 按本轮实际附件解析。
- **边界／状态**：桌面按图片、视频及独立音频端口核对类型，VPS 只返回建卡回执所需参数。[本机 Skill](../CHAT-PROVIDERS.md#2026-11-15-本机-dsh-在卡片第一轮使用-skill) · [Cloud 聊天](../../apps/cloud/CHAT.md)。

## 通过素材身份读取办公原件

- **用途／关键词**：DOCX 正文编辑、XLSX／CSV、IPC。
- **入口**：[text_documents.rs](../../apps/desktop/src-tauri/src/core/text_documents.rs) 统一访问原件，[office_documents.rs](../../apps/desktop/src-tauri/src/core/office_documents.rs) 负责办公格式。
- **调用**：句柄通过 read_text_document（可选 previewOnly）、save_docx_document 或 read_spreadsheet_document 使用，预览、编辑与转换共用读写规则。
- **边界／状态**：仅传 asset ID。DOCX 正文保存核对版本，表格只读。[文本与办公契约](../TEXT-LIBRARY.md)。

## 收发局域网文件

- **用途／关键词**：LocalSend、扫码、浏览器下载、原件发送。
- **入口**：[quick_transfer.rs](../../apps/desktop/src-tauri/src/commands/quick_transfer.rs) 管理 start／stop IPC，[send.rs](../../apps/desktop/src-tauri/src/quick_transfer/send.rs) 复用固定下载协议。
- **调用**：通过 quick_transfer_send_start(address, files)／quick_transfer_send_stop 发送，二维码及链接复用 QuickTransferConnection。
- **边界／状态**：状态单调、收发独立，仅交付显式选择的原件。[权限与生命周期](../QUICK-TRANSFER.md)。

## 读取或修改本机业务数据

- **用途／关键词**：素材、项目、设置、IPC、invoke、Tauri command。
- **入口**：[api.ts](../../apps/desktop/src/lib/api.ts) 导出的 `api`，例如 `api.listAssets`；对应 [commands/library.rs](../../apps/desktop/src-tauri/src/commands/library.rs) 的 `list_assets`，由 [lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 的 `tauri::generate_handler!` 注册。前端数据形状在 [types.ts](../../apps/desktop/src/lib/types.ts)；新增接口须同时核对 TS 参数、Rust 参数及序列化形状。
- **调用**：[App.tsx](../../apps/desktop/src/App.tsx) 调用 `api.listAssets(undefined, null, 200)`；列表查询还按集合、颜色、项目分路，不应只复用这个默认查询。
- **边界／状态**：**可跨模块复用（桌面前端）**。需 Tauri IPC；普通浏览器、MV3 扩展与云服务不能使用。已有 store action 涉及刷新、选择或任务生命周期时优先走 action，再由 action 调用 `api`，不要在组件重复状态编排。

## 判断账号权益和可用 provider

- **用途／关键词**：FeaturePolicy、Pro、BYO、门控、权益快照、本机 CLI 登录检测。
- **入口**：桌面从 `api.cloudEntitlement` 取快照。Rust 使用 [EntitlementService::current_or_sync](../../apps/desktop/src-tauri/src/cloud/entitlement.rs) 和 [FeaturePolicy::allows_generation_provider](../../apps/desktop/src-tauri/src/cloud/policy.rs)，Edge 使用 [policyForUser](../../apps/cloud/supabase/functions/_shared/feature-policy.ts)。
- **调用**：[entitlement Edge](../../apps/cloud/supabase/functions/entitlement/index.ts) 返回用户权限，[store.ts](../../apps/desktop/src/store.ts) 消费快照。[codex_create_image](../../apps/desktop/src-tauri/src/commands/codex.rs) 在提交前核验 policy，本机订阅通过同模块的 `require_generation_cli` 复查设置页所用的健康状态。[jimeng.rs](../../apps/desktop/src-tauri/src/commands/jimeng.rs) 用独立 CLI 的 `user_credit` 验证即梦授权，区分登录失效与网络故障，并将最新状态通知桌面。
- **边界／状态**：**可跨模块复用（各自运行时）**。UI 按用户快照展示，Rust 与 Edge 各自在执行边界校验。Edge 的 `policyForUser` 包含测试账号规则。调整字段时核对桌面响应类型、Rust 与 Edge。

## 增加图片、视频或理解能力

- **用途／关键词**：生成、视频、反推、命名、provider、Codex、Dreamina、Cloud。
- **入口**：[codex/mod.rs](../../apps/desktop/src-tauri/src/codex/mod.rs) 的 `GenProvider`／`resolve_gen_provider` 分派生成。[understand.rs](../../apps/desktop/src-tauri/src/codex/understand.rs) 的 `UnderstandProvider`／`resolve_entitled_understand_provider`／`resolve_understand_provider_with_choice` 分派理解。
- **调用**：[store.ts](../../apps/desktop/src/store.ts) 的 `startGeneration` 调用 `api.codexCreateImage`，携带 provider 与图片／视频参数。[commands/codex.rs](../../apps/desktop/src-tauri/src/commands/codex.rs) 在 `codex_create_image` 中解析生成 provider，反推路径按所选 provider 解析理解。
- **边界／状态**：**可跨模块复用（桌面 Rust provider 层）**。调用方继续校验账号、上传许可和任务门控。即梦支持生成，理解沿独立接口。`jimeng_video::response` 限桌面 provider 模块内解析 Dreamina stdout JSON。[视频模式](../SEEDANCE-2.5-INTEGRATION.md)。

## 展示生成进度与首张预览

- **用途／关键词**：生成阶段、Codex 首图预览、恢复进度、job／turn。
- **入口**：[codex/progress.rs](../../apps/desktop/src-tauri/src/codex/progress.rs) 的 `GenerationProgress`／`GenerationStage` 通过 `Chunk::Progress` 上报阶段，[codex_cli.rs](../../apps/desktop/src-tauri/src/codex/codex_cli.rs) 以 `Chunk::Preview` 上报完整首图。
- **调用**：Codex CLI、Dreamina 图片／视频和恢复 worker 共用 `codex://chunk`，由命令层补齐 job／turn。画板与详情按对应轮次读取内存预览。[桌面阶段反馈](DESKTOP.md#展示生成阶段)。
- **边界／状态**：阶段文案仅使用结构化状态。Codex 首图预览适用于新会话，续接已有会话等待正式交付，`thread.started` 提供会话身份。素材、引用、工作流输出和完成通知均读取正式入库结果。

## 保留生成任务、取消和启动恢复

H3 图片卡和视频卡的提示词优化复用 `CanvasWorkflowController` 及 `cloudAgentStart`／`cloudAgentGet`／`cloudAgentCancel` 文本改写协议。用户可点击独立优化，或开启默认关闭的自动优化并手动运行单卡。整条工作流、触发或循环运行跳过自动优化。`h3PromptOptimization` 提供 Skill 指令和图片引用占位符处理。优化请求身份、结果和生成输入保存在原工作流步骤，图片生成另用原生会话任务身份。调用沿用 Cloud DSH 测试权限及 Agent 计费。见 [工作流运行](../../apps/desktop/src/lib/canvasWorkflowRuntime.ts)、[Skill 指令](../../apps/desktop/src/lib/h3PromptOptimization.ts)及 [H3 优化契约](../COMFYUI-LOCAL-VIDEO.md#2026-11-06独立提示词优化源码待发布)。

对话渠道的 HyperFrames 能力沿 [local_chat.rs](../../apps/desktop/src-tauri/src/commands/local_chat.rs) 的受控动态工具接入 [agent_ds/chat_video.rs](../../apps/desktop/src-tauri/src/commands/agent_ds/chat_video.rs)，与 Agent 卡片共用 `video::execute` 和工程副本／入库契约。对话模型直接编写工程，不投递第二个 Agent；进度与视频附件复用 `local_chat_messages`，UI 复用 `VideoPlayer`。工具参数不接收绝对路径或任意命令；调用必须绑定已确认的当前对话轮次，Cloud 不开放此工具。

本机 Skill 视频制作复用 [agent_ds.rs](../../apps/desktop/src-tauri/src/commands/agent_ds.rs) 的 `agent_ds_workflow_start`／结果／入库协议，`purpose: agent-video` 由 [video.rs](../../apps/desktop/src-tauri/src/commands/agent_ds/video.rs) 提供固定版本 HyperFrames 环境、工程副本与 `serve` 工具桥。Codex 保留沙箱，只请求固定本机检查／截图／渲染命令；不能用视频生成 provider 或受限 HTML 截图 renderer 代替。独立编辑面板由 [video_studio.rs](../../apps/desktop/src-tauri/src/commands/agent_ds/video_studio.rs) 的 open／resize／close 管理服务与 WebView，React 使用 [VideoStudioPanel](../../apps/desktop/src/components/VideoStudioPanel.tsx)。这些是桌面 Agent 内部能力，不能跨运行时导入；Cloud 扩展继续沿统一 Harness。完整契约见 [VIDEO-SKILL.md](../VIDEO-SKILL.md)。

图片生成卡片、底部创作框和图片会话的编辑坞共用 [ProviderSelect](../../apps/desktop/src/components/creation/ProviderSelect.tsx)。本机 `minimax-h3-image` 通过 [H3 图片 provider](../../apps/desktop/src-tauri/src/codex/h3_image.rs) 运行受控图片图谱，沿用图片任务队列、续轮参考图和产物入库。环境入口复用 `ComfyEnvironmentControl` 和 `comfy_video_environment`，按 `image` 或 `edit` 检测及补齐模型。[工作流与安装版本](../COMFYUI-LOCAL-VIDEO.md)。

H3 图片文生图／编辑共用直接提示词图谱，`h3_image::reference_prompt` 将显式引用绑定为原顺序的 `<Picture N>`，不执行自动扩展。取消使用 `cancel_codex_create` 的内存运行守卫；守卫缺失时按原持久任务恢复取消，完成后复用 `generation_worker::update_creative_job_status` 同步任务与项目会话状态。`h3_image::cancel` 只取消原 UUID 并确认队列退出，不使用全局中断。

本机 H3 使用独立的既有持久任务协议：前端 [comfyVideo.ts](../../apps/desktop/src/lib/comfyVideo.ts) 的 `comfyVideo`／`comfyEnvironment`，Rust [comfy_video.rs](../../apps/desktop/src-tauri/src/commands/comfy_video.rs) 的固定模式 graph 与恢复、[comfy_setup.rs](../../apps/desktop/src-tauri/src/commands/comfy_setup.rs) 的按模式环境准备。`frames`／`reference`／`text` 由显式选择确定，缺省兼容旧首尾帧；[composerLocalVideo.ts](../../apps/desktop/src/lib/composerLocalVideo.ts) 让主屏和画板先保存同一 H3 卡片再执行。模式选择复用 `comfyVideoOptionsForMode`，环境响应的 `mode`／`modelsRequired` 用于当前模式就绪判断，`canAddModels` 仅表示托管环境可以补模型。此接口限定桌面与本机 loopback，不接受任意工作流；见 [三模式契约](../COMFYUI-LOCAL-VIDEO.md)。

普通 H3 视频生成使用现有 `prepare` 启动已选择的环境。取回已提交任务使用 `recover`，绑定原端口、模式与已记录的安装路径，并复用原请求 UUID 和入库记录。进程识别及崩溃恢复统一由 `comfy_setup.rs` 管理。[环境恢复](../COMFYUI-LOCAL-VIDEO.md#h3-视频环境自行恢复桌面源码)

H3 视频三模式共用可选录音素材 ID 与既有媒体连线，`comfy_video.rs` 通过素材原件解析和音频解码验证后送入本机 ComfyUI。首尾帧、文生从第 0 帧加入音频引导，单图采用 Ref2VA 音色参考。入口及实机证据见 [H3 视频参考录音](../COMFYUI-LOCAL-VIDEO.md#2026-11-20-h3-视频参考录音桌面源码)。

- **用途／关键词**：GenJob、jobId、submit_id、幂等、恢复、终态、入库。
- **入口**：[task_queue.rs](../../apps/desktop/src-tauri/src/core/task_queue.rs) 的 `GenJob`／`Task::upsert_gen_job`；[generation_worker.rs](../../apps/desktop/src-tauri/src/core/generation_worker.rs) 的 `spawn_recovery`／`finalize_generation_assets`。前端沿 `startGeneration`、`api.cancelCodexCreate`、`api.listGenJobs` 接入；**Cloud 视频取回原任务用 `api.recoverCloudVideo(jobId)`** → `recover_cloud_video`，不重新创建生成。
- **调用**：[commands/codex.rs](../../apps/desktop/src-tauri/src/commands/codex.rs) 正常生成和恢复共用收尾；[lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 启动恢复并注册 `recover_cloud_video`。[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 的 `retryTurn` 对 Cloud 视频失败末轮调用 `api.recoverCloudVideo(activeJob.id)`，失败交给 [notify.ts](../../apps/desktop/src/lib/notify.ts) 的 `notifyError`；历史失败轮有独立限制，不能对任意轮次复制该操作。
- **边界／状态**：**模块内部专用（普通生成子系统）**。可沿现有命令扩展，不把私有 task payload 当作通用任务 SDK。Cloud 原 job/key、即梦 submit_id 和项目／创作线程身份分别保留；未知结果不自动重发。Agent Run 有自己的租约、审批、账本，不直接塞进普通 `GenJob`。见 [项目画板](../PROJECT-CANVAS-PLAN.md)、[Cloud 视频恢复](../VIDEO-API-INTEGRATION.md)。

## 接入已有本地文件或保存新收到的媒体

视频音轨：`api.extractVideoAudio` → `commands/video_audio.rs::extract_video_audio`，复用 `media::tools`、`media::audio`、`ingest_generated` 和项目文件路径。仅已登记视频，固定第一音轨 PCM WAV；操作身份记录在 analyses，原视频保持。前端 `createVideoAudioExport` 冻结目标与重试状态；画板沿 `videoCollectionCanvas.ts::saveMediaAssetToCanvas` 的通用 Asset 投递接口（原 `saveCollectedVideoToCanvas` 保留别名），持久化仍由 `CanvasWorkspace` 负责，不直接绕过写入队列。

- **用途／关键词**：导入、单文件收集、收集箱、原位连接、原件、生成结果、去重、项目归属。
- **入口**：桌面文件选择沿 `api.importFiles` → [commands/library.rs](../../apps/desktop/src-tauri/src/commands/library.rs) 的 `import_files`；默认调用 [ingest.rs](../../apps/desktop/src-tauri/src/core/ingest.rs) 的 `ingest_file`（已有原件连接），显式 `collect=true` 调用 [file_intake.rs](../../apps/desktop/src-tauri/src/core/file_intake.rs) 的 `collect`（单独收集到共享收集箱，已连接／受管路径原位复用）。没有路径的 HTML 文件沿 [commands/media_import.rs](../../apps/desktop/src-tauri/src/commands/media_import.rs) 的 `video_import_begin/append/finish/cancel` 兼容命令分块接收，完成后走同一 `collect`。`ingest_new_file` 仍专用于临时来源首次持久保存；生成结果沿上一项收尾函数调用 `ingest_generated`，再委托 `ingest_generated_with_visibility`。
- **调用**：[TextDocumentEditor.tsx](../../apps/desktop/src/components/TextDocumentEditor.tsx) 用 `api.importFiles(paths)` 原位插入媒体；[mediaImport.ts](../../apps/desktop/src/lib/mediaImport.ts) 的单独拖入明确选择收集路径。命令层继续处理项目成员、asset protocol scope、后台分析和变更事件；[commands/layers.rs](../../apps/desktop/src-tauri/src/commands/layers.rs) 调用 `ingest_generated_with_visibility` 保存图层产物。
- **边界／状态**：**可跨模块复用（桌面 API／Rust 入库层）**。目录连接不复制已有原件，单文件收集不要求先建立连接；不要用 `ingest_new_file` 代替明确收集的 `collect`，也不要仅调用底层写文件就视为完成项目交付。连接目录使用 [connected_media.rs](../../apps/desktop/src-tauri/src/core/connected_media.rs) 的 `Database::index_connected_file` 做廉价索引，实际调用在 [folder_connections.rs](../../apps/desktop/src-tauri/src/core/folder_connections.rs)，并非通用立即生成全部预览的导入器。依赖 SQLite、`LibraryPaths`；先读 [文件契约](../FOLDER-MODE.md)。

## 读取已连接目录与补齐预览

- **入口／调用**：[folder_connections.rs](../../apps/desktop/src-tauri/src/core/folder_connections.rs) 的 `connection_folders_filtered`／`connection_entry_ids_filtered`／`connection_entry_groups` 供原生素材浏览命令使用；`read_connection_entries(ids)` 批量读索引，`resolve_connection_entries(ids)` 在同一读取基础上保留原件存在校验。浏览用前者，明确文件操作用后者；不能用索引可用状态代替删除前确认。
- **索引与预览**：[connected_media.rs](../../apps/desktop/src-tauri/src/core/connected_media.rs) 的 `prepare_connected_path` 在事务外读取有限容器头，`index_connected_in` 供普通扫描在同一批事务登记素材和目录条目。大于 32 MiB 的原件可先登记文件版本，`complete_connected_fingerprint` 延后补齐完整 SHA-256；已有完整读取的严格操作用 `register_connected_fingerprint` 绑定实测版本。`complete_connected_preview_versioned` 按已登记文件版本更新封面及元数据，`current_preview_changes` 批量核对待发送事件。[commands/external_files.rs](../../apps/desktop/src-tauri/src/commands/external_files.rs) 分开调度视频与图片补齐，沿用 `library://previews-changed` 更新现有页面。
- **扫描通知／边界**：`scan_connection_changes` 回调只标识内容是否变化；原 `scan_connection_with_progress`／`scan_connection_prioritized` 包装保留。命令层独立发 `library://connection-progress`，未变扫描不发素材失效。以上均为桌面本机目录模块内部能力；当前数据规模、基准与恢复限制见 [性能说明](../FOLDER-MODE.md#文件夹读取与预览性能2026-11-10)。

## 保持断开目录后的素材可见性

- 素材库与画布的「移动到项目」共用 [MoveAssetsToProjectDialog](../../apps/desktop/src/components/MoveAssetsToProjectDialog.tsx) 和 `api.moveAssetsToProject(sourceProjectId, targetProjectId, assetIds)`。来源由当前视图传入，全局范围传 `null`。原生事务更新所选项目成员和素材可见性，保留断联记录、其他成员、画板卡片及创作线程。
- 项目管理页与素材库项目选择器共用 `api.projectCovers()`。它按项目成员查询当前可见素材数及最多三张封面，排除库内隐藏、已回收和已清理失效原件，仍属于项目的断联素材按项目范围读取。[项目查询](../../apps/desktop/src-tauri/src/core/projects.rs)
- **入口／调用**：[folder_connections.rs](../../apps/desktop/src-tauri/src/core/folder_connections.rs) 的 `disconnect_directory(paths, id)` 将连接移除与断联事实写入同一事务；[external_files.rs](../../apps/desktop/src-tauri/src/core/external_files.rs) 的 `link_external_to_library` 记录明确独立收集并清除断联，重新连接也恢复原身份。
- **复用边界**：[material_catalog.rs](../../apps/desktop/src-tauri/src/core/material_catalog.rs) 的 crate 内部 `catalog_visibility`／`library_membership_sql` 统一供应分页、标签、旧列表／搜索／计数／色板及常用素材查询；不要另按 `library_hidden` 推断目录成员。0051 的独立收集／断联表只影响全局成员展示，不删除原件、缓存、创作资料或真实项目成员；其他连接／分身、独立收集与受管路径保留。旧版已经断开的来源不能可靠推断，升级不批量猜测隐藏。详见 [文件契约](../FOLDER-MODE.md)。

## 以文搜图

- **用途／关键词**：SigLIP2、语义索引、目录及生成来源筛选。
- **入口**：[Tauri 命令](../../apps/desktop/src-tauri/src/commands/semantic_search.rs) 及 [semanticSearch.ts](../../apps/desktop/src/lib/semanticSearch.ts)。[索引](../../apps/desktop/src-tauri/src/core/semantic_search/index.rs) 与 [调度](../../apps/desktop/src-tauri/src/core/semantic_search/schedule.rs) 使用 SQLite 0060／0061 持久化内容与轮次。
- **调用**：[LibrarySemanticSearch.tsx](../../apps/desktop/src/components/LibrarySemanticSearch.tsx) 发起查询、分页和选区。用 CatalogFilter::sql 及 [scope](../../apps/desktop/src-tauri/src/core/semantic_search/scope.rs) 定范围后精确打分。自动与手动更新共享 worker；更新、暂停和继续复用原操作。
- **边界／状态**：模型按需安装，原件校验 SHA-256，推理在主库锁外。全局设置待同步时暂停提交。模型门槛、校准样本和原生测量见 [模型专项](../../apps/desktop/src-tauri/src/core/semantic_search/model/README.md#搜索相关性校准与索引验收)。

## 回收原件或清理缺失引用

- **入口：** `assetOriginals.preview/trash` → [folder_connections.rs](../../apps/desktop/src-tauri/src/core/folder_connections.rs) 的 `preview_asset_originals`／`trash_asset_original`；同一确认协议区分真实回收与 `cleanup_missing_original` 元数据清理。确认前后均核对身份、路径和内容状态，不用缓存判断原件仍存在。
- **画板同步：** [project_canvas.rs](../../apps/desktop/src-tauri/src/core/project_canvas.rs) 的 crate 内 `hide_removed_original_canvas_nodes` 在调用方事务内，根据已回收／已清理路径解析全部身份，复用 `hide_asset_canvas_nodes` 和 `hide_empty_generation_cards_for_asset`。后者排除已回收／缺失清理的产物记录；不得以资产行仍存在判断图片仍有效。回收失败连同画板隐藏回滚，旧失效标记也能补齐清理；历史、素材和关系记录保留，不新增物理删除。验证见 [画板清理](../FOLDER-MODE.md#2026-11-08原件删除后的画板清理源码待发布)。

## 探测媒体、生成缩略图或调用 FFmpeg

- 音频与视频素材从 [videoTranscript.ts](../../apps/desktop/src/lib/videoTranscript.ts) 调用 [video_transcript.rs](../../apps/desktop/src-tauri/src/commands/video_transcript.rs) 的能力、核价、开始和状态接口。预览和视频批量共用 `useVideoTranscriptPrice` 判断是否显示新任务操作。预览通过 `useVideoTranscript` 独立读取本机文稿及原任务状态。MP3 提取复用 [speech.rs](../../apps/desktop/src-tauri/src/commands/video_replication/speech.rs) 的媒体工具，受限传输走 Cloud 公共签名入口。豆包标准版 2.0 的提交和查询在 [file-speech.ts](../../apps/agent-worker/src/cloud-understand/file-speech.ts)，按原 Cloud 任务 UUID 恢复。[视频素材](../VIDEO-MEDIA.md#素材视频管理的识别路线) · [音频素材](../AUDIO-LIBRARY.md#音频详情与转录)
- [音频裁剪命令](../../apps/desktop/src-tauri/src/commands/audio_trim.rs) 与 [视频裁剪命令](../../apps/desktop/src-tauri/src/commands/video_trim.rs) 共用编码运行与串行保护。音频另存采用原格式入库，覆盖仅接受受管原件并使旧版本文稿失效。
- 强化复刻（Cloud 已部署，桌面源码待发布）：`commands/video_replication/enhanced.rs`、`enhanced/{finish,markers}.rs` 经原 `video_replication` 的 `enhanced-*` 操作连接 `EnhancedReplication.tsx`；复用 reference 校验、媒体工具／probe／audio、understand 队列／计费、`codex_create_image` 即梦任务与 generation history，新增切片及分步骤回执、WAV 契约／豆包语音适配、词标记和字幕成片编排。`enhanced-frame` 沿项目／源哈希校验提取缓存中点帧，`replicationAnalysisNote` 适配原内容卡片两列 payload；正式输出复用图片入库和项目建卡接口。均为复刻内部接口，未另建 Agent runner；上线、验收和限制见 [复刻专项](../VIDEO-REPLICATION.md#强化复刻首版cloud-已部署桌面源码待发包)。

- **用途／关键词**：probe、缩略图、ffprobe、FFmpeg、视频封面、二进制发现。
- **入口**：[media/probe.rs](../../apps/desktop/src-tauri/src/media/probe.rs) 的 `probe` 与 [media/thumb.rs](../../apps/desktop/src-tauri/src/media/thumb.rs) 的 `generate`／`generate_video`；确需启动工具时，用 crate 内 [media/tools.rs](../../apps/desktop/src-tauri/src/media/tools.rs) 的 `resolve(Tool::Ffmpeg/Ffprobe)`、`command`。
- **调用**：连接索引用 `probe_connected_video_header` 读取受限的 ISO BMFF 容器头。`generate_video_with_meta` 可从隔离的封面 Worker 同次取得视频尺寸和时长。`probe_video_ffprobe` 与封面 FFmpeg 回退沿用工具 resolver。
- **边界／状态**：**可跨模块复用（桌面 Rust crate 内）**。resolver 只缓存成功解析的绝对路径，处理显式配置、随包目录和平台发现；不安装工具或修改 PATH。`tools` 是 `pub(crate)`，不是给外部应用导入的库；不要另写字符串 `ffmpeg` 子进程绕过同源探测和 Windows 隐藏窗口处理。播放 UI 另见 [桌面地图](DESKTOP.md)。

## 从本机调用需要登录的 Cloud 接口

- **通信与恢复契约（2026-11-06）**：先用 `CloudConfig.endpoint` 的闭集路由；桌面与官网共用 [cloud-routes.json](../../website/cloud-routes.json)，未知接口不得回退直连。Agent Storage 使用 `agent_transfer_url`，原文字识别查询使用 `understand_lookup_endpoint`，不手拼上游地址。正式创建请求经 `AuthClient` 保存无正文的原请求身份；Agent 失去创建响应只查 `get_by_key`。新增入口须通过桌面构建中的路由检查及对应传输测试。完整边界、上线顺序与回滚见 [Cloud 通信](../CLOUD-TRANSPORT.md)。

- **用途／关键词**：HTTP、Bearer、刷新 token、401、超时、云客户端。
- **入口**：[cloud/client.rs](../../apps/desktop/src-tauri/src/cloud/client.rs) 的 `CloudClient::http`／`config` 构造请求；[cloud/auth.rs](../../apps/desktop/src-tauri/src/cloud/auth.rs) 的 `AuthClient::send_authorized` 负责已登录 Function 请求。构造 client 本身不联网。
- **调用**：[cloud/entitlement.rs](../../apps/desktop/src-tauri/src/cloud/entitlement.rs) 的 `EntitlementService::sync` 和 [codex/understand.rs](../../apps/desktop/src-tauri/src/codex/understand.rs) 的 Cloud 理解请求均调用 `send_authorized`。
- **边界／状态**：**可跨模块复用（桌面 Rust）**。要求可 clone 的请求体；只对 401 串行刷新 token 并重试一次，不提供任意业务失败重试，也不负责幂等账本。下载签名 URL、浏览器站点 Cookie、扩展取图各有独立权限与传输语义，不通用套 Bearer。原始错误到界面的转换遵循 [错误规范](../USER-FACING-ERRORS.md)。

## 新增 Edge Function 的鉴权、响应和错误

- **用途／关键词**：Supabase、Deno、鉴权、request_id、JSON、错误码。
- **入口**：[_shared/auth.ts](../../apps/cloud/supabase/functions/_shared/auth.ts) 的 `requireUser` 返回已核验 `user` 与 `admin`；[_shared/errors.ts](../../apps/cloud/supabase/functions/_shared/errors.ts) 的 `ApiError`、`requestId`、`jsonResponse`、`errorResponse`、`safeLog` 统一协议。
- **调用**：[generate-proxy/index.ts](../../apps/cloud/supabase/functions/generate-proxy/index.ts) 先 `requireUser` 再处理请求，异常由 `errorResponse(error, id, cors)` 返回；[entitlement/index.ts](../../apps/cloud/supabase/functions/entitlement/index.ts) 复用同一入口。
- **边界／状态**：**可跨模块复用（Cloud Edge Functions）**。依赖 Deno 环境变量与 Supabase SDK；`admin` 不替代业务所有权、配额、审批检查。`safeLog` 只接受有限摘要，不能塞入 prompt/token/完整请求。不可把该文件导入浏览器或 Node Worker；机器 worker 的认证协议另行核验。

Edge 接收 JSON 对象时可复用 [_shared/limits.ts](../../apps/cloud/supabase/functions/_shared/limits.ts) 的 `readJsonBody`，传入接口的字节预算。支付通知需要原始正文验签，沿用 `readPaymentBody`。

VPS 的 Agent、生成、理解和视觉提炼消费循环复用 [ControlTransport](../../apps/agent-worker/src/control-plane/control-transport.ts) 发送控制请求。每个串行消费者单独持有实例，按领取和续租回执跟踪有效期。控制请求超时后按原任务恢复，模型请求、签名对象传输仍由各自的客户端处理。

## 复用 Bcoin 预授权与结算

- **用途／关键词**：余额、hold、幂等键、确认、回滚、待结算。
- **入口**：[_shared/billing.ts](../../apps/cloud/supabase/functions/_shared/billing.ts) 的 `holdCredits`、`confirmCredits`、`rollbackCredits`、`markPendingSettlement` 封装账本 RPC；`ensureDailyCredits` 是保留的历史名称，当前传 `p_amount: 0`，不能据此新增每日赠币。
- **调用**：[理解与视觉提炼上传](../../apps/cloud/supabase/functions/_shared/text-job-upload.ts) 通过 [0086](../../apps/cloud/supabase/migrations/0086_text_job_upload_retention.sql) 事务化受理、凭原输入哈希续传、入队与过期回收（[2026-11-11 部署](../../project_logs/2026-11-11-audit-cloud-deployment.md)）；旧同步理解独占预留后结算；[agent-run/index.ts](../../apps/cloud/supabase/functions/agent-run/index.ts) 在创建与容量失败路径调用 hold／rollback。
- **边界／状态**：**可跨模块复用（Cloud Edge Functions）**。需已验证用户、admin client、当前 migrations 与服务端 service 定价；异步任务各自拥有持久化与结算状态机，不能复制同步接口的 catch 就统一退款。供应商结果未知与可确认失败不同；新计费服务先读 [当前定价](../Bowerbird定价方案v2-订阅积分制.md)、[收费化计划](../ARCH-ADJUST-PLAN.md)。

## 接入微信支付与恢复原订单

- **用途／关键词**：Native、扫码、下单、支付通知、查单、退款、日账。
- **入口**：Cloud [_shared/wechatpay.ts](../../apps/cloud/supabase/functions/_shared/wechatpay.ts) 提供 `WechatPayClient`、签名验签及通知解密；[_shared/wechatpay-service.ts](../../apps/cloud/supabase/functions/_shared/wechatpay-service.ts) 提供业务入口、订单绑定与恢复；[_shared/wechatpay-bill.ts](../../apps/cloud/supabase/functions/_shared/wechatpay-bill.ts) 核对日账。
- **调用**：`create-checkout`、`checkout-status`、`payment-webhook`、`payment-admin`、`payment-reconcile`；桌面通过 `api.cloudCreateCheckout`／`cloudCheckoutStatus`／`cloudCheckoutCapability` 和原账号网关调用。
- **边界／状态**：**Cloud 共用能力，生产已开放购买**。仅服务端持商户私钥并调用原子入账／退款 RPC。扫码前以服务端待付状态为准。11 月 13 日隔离账号验证了真实 ¥1 扫码付款、通知入账和全额退款，11 月 17 日确认对账后开放公开购买。[微信支付及验收记录](../../apps/cloud/WECHATPAY.md#验证记录)。

## 在 Agent 卡片发送、取回或新建会话

- **用途／关键词**：Agent 卡片、统一对话、原轮恢复、同卡新会话、工作流结果。
- **入口**：[localChatStore](../../apps/desktop/src/lib/localChatStore.ts) 和 [local_chat.rs](../../apps/desktop/src-tauri/src/commands/local_chat.rs) 提供发送及原请求查询。[workflowAgentChat](../../apps/desktop/src/lib/workflowAgentChat.ts) 与 [工作流 Agent 执行器](../../apps/desktop/src/lib/workflowAgentExecutor.ts)的 `chatResult` 负责适配工作流输入及轮次输出。
- **调用**：发送走 `local_chat_send`，以 SQLite 事务绑定同 `nodeId` 的会话及 Agent 投影，取回走 `local_chat_get_by_request`。`localChat.newOnCard` 走 `local_chat_new_on_card`，校验项目、卡片、原会话与运行锁，旧会话进入项目历史，新会话沿原连线运行。全文及表格交付复用 [workflowAgentResult](../../apps/desktop/src/lib/workflowAgentResult.ts) 和 [workflowAgentOutputs](../../apps/desktop/src/lib/workflowAgentOutputs.ts)。
- **边界／状态**：`localDsRequestId`／`agentRunId` 仅恢复旧任务。统一对话及 Agent 卡片已随 Windows 26.11.1001 公开发布，Cloud 新轮走 v2 并按试用资格受理。各平台范围和后续增量按发布记录核对。[Windows 发布回执](../DESKTOP-UPDATES.md#windows-26111001-已发布2026-11-10) · [桌面对话](../CHAT-PROVIDERS.md) · [Cloud v2](../../apps/cloud/CHAT.md)。

## 给 Agent 增加受控工具

- **用途／关键词**：Tool Gateway、DSH、审批、lease、durable、工具账本、TaskAuthorization。
- **入口**：Worker [scoped-tool-gateway.ts](../../apps/agent-worker/src/harness/scoped-tool-gateway.ts) 的 `ScopedToolGateway`／`ToolGatewayDefinition` 校验工具、阶段、授权和参数；外部副作用通过 [durable-tool-dispatcher.ts](../../apps/agent-worker/src/kernel/durable-tool-dispatcher.ts) 的 `DurableToolDispatcher`。v3 能力额度与动作 journal 由 [adaptive-tool-gateway.ts](../../apps/agent-worker/src/harness/adaptive-tool-gateway.ts) 的 `AdaptiveToolGateway` 管理。
- **调用**：[unified-planning-tool-bridge.ts](../../apps/agent-worker/src/harness/unified-planning-tool-bridge.ts) 的 `createUnifiedPlanningToolBridge` 组合 scoped gateway；[unified-planning-run-processor.ts](../../apps/agent-worker/src/cloud-agent/unified-planning-run-processor.ts) 实例化 adaptive gateway；[controlled-image-executor.ts](../../apps/agent-worker/src/providers/ark/controlled-image-executor.ts) 使用 durable dispatcher。
- **边界／状态**：**可跨模块复用（Worker 内受控工具）**。Scoped 与 Adaptive 是不同层次，不能互换；需控制面 run/lease、授权交集、可信 slot 与 checkpoint。不得用模型自报 callId 执行副作用，也不为新内容能力另建 Runner。新工具契约修改要同步 Cloud 与 Worker 校验；先读 [通用 Harness](../UNIFIED-AGENT-HARNESS-PLAN.md)，不据源码存在推断已对所有用户开放。

## 从浏览器扩展采集图片或视频

- **用途／关键词**：MV3、网页取图、浏览器会话、save_blob、WebSocket、采集回执。
- **入口**：[collection-utils.js](../../apps/extension/collection-utils.js) 经 `globalThis.BowerbirdCollection` 暴露 `uploadBytes`／`checkVideoSupport`；[background.js](../../apps/extension/background.js) 的消息监听接收 `save_image`／`save_video`。桌面入口为 [collect/ws_server.rs](../../apps/desktop/src-tauri/src/collect/ws_server.rs) 的 `start`，解析元数据帧和二进制帧。
- **调用**：`background.js` 的 `fetchVideo` 调用 `BowerbirdCollection.uploadBytes`；桌面 [lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 启动 `collect::ws_server::start`，视频保存走 [video_blob.rs](../../apps/desktop/src-tauri/src/collect/video_blob.rs) 的 `save`；内置探索 [source_browser_capture.rs](../../apps/desktop/src-tauri/src/commands/source_browser_capture.rs) 也复用该保存层。
- 桌面主窗口通过 `pair_extension` 登记扩展安装公钥。后台 `pairing.js` 为每个连接签发绑定浏览器来源的限时凭据；页面只取得单次上传授权。兼容 URL 下载复用 `core/public_network.rs` 的公网地址判定，每跳独立固定解析结果。
- 图片采集共用 `core/ingest.rs` 的近似／字节精确去重：仅复用当前可读且未隐藏、未清理、未断开的原件，丢弃新副本前再核对登记路径与可见性。有项目时保留 `LibraryPaths::for_project` 的目标目录；扩展 bytes／URL 和探索全局采集复用 `Database::link_external_to_library` 登记 `independent_library_assets`，使项目内原件的全局用途参与项目删除保护。
- **边界／状态**：**模块内部专用（扩展采集协议）**；视频保存层在 Rust crate 内已有跨入口调用。扩展 JS 是 classic script/global 导出，不是 React 模块；浏览器下载保持站点会话，上传只发字节及来源，不导出 Cookie。视频必须能力协商。内置探索和扩展的下载范围不同，不能拿一侧流媒体支持替另一侧作保证；见 [扩展 README](../../apps/extension/README.md)、[探索契约](../EMBEDDED-BROWSER.md)。

## 为官网或桌面配置 Cloud 反向代理入口

- **用途／关键词**：官网、Node、网关、账号代理、签名上传下载、路由白名单。
- **入口**：[account-proxy.mjs](../../website/account-proxy.mjs) 的 `createAccountProxy` 处理账号/auth 和购买查单固定路由；[cloud-proxy.mjs](../../website/cloud-proxy.mjs) 的 `createCloudProxy` 按共同契约处理六个 Function、受限原任务查询与 Storage 签名路径；[payment-proxy.mjs](../../website/payment-proxy.mjs) 的 `createPaymentProxy` 原样转发微信签名通知。
- **调用**：[server.mjs](../../website/server.mjs) 的 `startServer` 按 `/api/account/`、`/api/cloud/` 和 `/api/pay/` 分派。
- **边界／状态**：**模块内部专用（website Node server）**。各 handler 的超时、路由、大小、流式传输及断连行为不同；都不能成为任意 URL 代理，不携带 service key，不自动重试。支付通知不能 JSON 解析后重序列化。可以扩展其明确支持的路由，不从桌面直接 import，也不把 `server.mjs` 内早期生成函数当作通用 provider API。

## 本机角色声音与配音

- `commands/voice.rs` 提供 voice_configure／snapshot／save／start／cancel／recover／manage／export；前端 `lib/voice.ts` 是类型化入口。参考裁剪复用音频解码与 media::tools 的 FFmpeg，发布复用 ingest_generated、LibraryPaths 与素材变更事件；持久化运行身份及回执属于声音模块，不跨模块复用其内部 JSON 文件。
- `commands/voice_setup.rs` 提供 voice_environment 的 status／check／install／pause，专用目录托管 Python、依赖与固定模型，复用库内原子 JSON 写入；不要向其他模块暴露其安装状态全局锁。模型／uv 下载清单在 voice-downloads.json。Windows x64 + NVIDIA，保留高级手动连接，不新增 Cloud 或 Agent 执行器。
- `VoiceCard` 的生成由 `CanvasWorkflowController.runVoice` 执行。voiceApi.start 接收独立恢复标识，原生回执保存 request_key。工作流步骤保存输入对应的试听身份、原任务和产物，复用与 H3 共用的媒体落点逻辑。配音通过已有媒体端口传递音频；克隆试听在卡内播放。旧项目草稿通过 readVoiceDraft 接续，卡片字段写入画板工作流。见 [声音卡片](../VOICE-STUDIO.md)。

## 重复候选与覆盖边界

- **模块内部专用（各端契约）；共用源提取仍为候选**：Cloud [_shared/task-authorization.ts](../../apps/cloud/supabase/functions/_shared/task-authorization.ts) 与 Worker [contracts/task-authorization.ts](../../apps/agent-worker/src/contracts/task-authorization.ts) 各自维护 `TaskAuthorization`／`parseTaskAuthorization`。前者经 [_shared/unified-agent-plan.ts](../../apps/cloud/supabase/functions/_shared/unified-agent-plan.ts) 消费，后者经 `AdaptiveToolGateway` 消费。2026-11-06 新增 [task-authorization-sync.test.ts](../../apps/agent-worker/src/contracts/task-authorization-sync.test.ts)，由现有 Worker `test` 自动纳入：仅统一 CRLF/LF 后比较完整源码，变更契约须同步两端。此检查不改变运行时隔离，不提供跨包生产导入入口，也不代替授权行为测试。
- **尚待确认**：两个 website proxy 都有 `readLimited`／限流片段，但失败状态码、输入输出方向及流控策略不完全相同；先比较测试与传输契约，再决定是否值得提取。Rust/Edge/TS 三份 FeaturePolicy 则有本机门控、服务端用户策略、序列化类型之分，不推荐仅凭同名合并。
- 本页抽查了桌面接口、生成和文件接入、Cloud 鉴权计费、Worker 工具、扩展与官网网关；没有穷举 Rust DB 查询、每个 provider、所有 Edge Function、安装更新、支付、renderer 内部与平台原生分支。这里只验证静态入口及调用关系，未联网调用或验证部署状态。
