# 接口、文件接入与执行服务复用

[返回复用地图](../Bowerbird开发计划.md#复用地图)。2026-11-03 按当前工作区源码核验；以下“可跨模块复用”均限定所在运行时，不表示可以跨应用直接 import。发布状态与产品约定仍以 [PROJECT](../../PROJECT.md) 为准。

## 读取或修改本机业务数据

文档原件统一由 [text_documents.rs](../../apps/desktop/src-tauri/src/core/text_documents.rs) 按已登记素材身份访问。其 `office` 子模块 [office_documents.rs](../../apps/desktop/src-tauri/src/core/office_documents.rs) 提供 DOCX 正文／包读取、版本保护的 `save_docx` 和 XLSX／CSV `read_spreadsheet`；对应 IPC 为 `read_text_document`（可选 `previewOnly`）、`save_docx_document`、`read_spreadsheet_document`。调用方只能传 asset ID，不能指定任意读写路径。正文预览、全量编辑与画板内容转换共用格式边界；表格只读原件，DOCX 不走 UTF-8 保存。依赖固定版本、读取限制与验收见 [办公文档支持](../TEXT-LIBRARY.md#办公文档素材2026-11-09)。

局域网文件收发使用 [quick_transfer.rs](../../apps/desktop/src-tauri/src/commands/quick_transfer.rs) 的显式 start/stop IPC；发送端调用 `quick_transfer_send_start(address, files)`／`quick_transfer_send_stop`，共享单调版本状态，独立于接收。底层 [send.rs](../../apps/desktop/src-tauri/src/quick_transfer/send.rs) 复用固定 LocalSend 浏览器下载协议，仅交付显式选择的原件；不拿缩略图作交付，不开启目录浏览。二维码／复制链接共用 `QuickTransferConnection`。完整权限和生命周期见[快传协议](../QUICK-TRANSFER.md)。

- **用途／关键词**：素材、项目、设置、IPC、invoke、Tauri command。
- **入口**：[api.ts](../../apps/desktop/src/lib/api.ts) 导出的 `api`，例如 `api.listAssets`；对应 [commands/library.rs](../../apps/desktop/src-tauri/src/commands/library.rs) 的 `list_assets`，由 [lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 的 `tauri::generate_handler!` 注册。前端数据形状在 [types.ts](../../apps/desktop/src/lib/types.ts)；新增接口须同时核对 TS 参数、Rust 参数及序列化形状。
- **调用**：[App.tsx](../../apps/desktop/src/App.tsx) 调用 `api.listAssets(undefined, null, 200)`；列表查询还按集合、颜色、项目分路，不应只复用这个默认查询。
- **边界／状态**：**可跨模块复用（桌面前端）**。需 Tauri IPC；普通浏览器、MV3 扩展与云服务不能使用。已有 store action 涉及刷新、选择或任务生命周期时优先走 action，再由 action 调用 `api`，不要在组件重复状态编排。

## 判断账号权益和可用 provider

- **用途／关键词**：FeaturePolicy、Pro、BYO、门控、并发、权益快照。
- **入口**：桌面用 `api.cloudEntitlement` 获取快照；后端用 [entitlement.rs](../../apps/desktop/src-tauri/src/cloud/entitlement.rs) 的 `EntitlementService::current_or_sync` 和 [policy.rs](../../apps/desktop/src-tauri/src/cloud/policy.rs) 的 `FeaturePolicy::allows_generation_provider`。服务端按用户计算用 [_shared/feature-policy.ts](../../apps/cloud/supabase/functions/_shared/feature-policy.ts) 的 `policyForUser`。
- **调用**：[commands/codex.rs](../../apps/desktop/src-tauri/src/commands/codex.rs) 的 `codex_create_image` 在执行前核验 policy；[entitlement/index.ts](../../apps/cloud/supabase/functions/entitlement/index.ts) 把 `policyForUser(tier, user)` 写入权益响应；[store.ts](../../apps/desktop/src/store.ts) 消费 `api.cloudEntitlement()`。
- **边界／状态**：**可跨模块复用（各自运行时）**。TS `FeaturePolicy` 是响应类型，Rust policy 是本机执行门控，Edge policy 还包含测试账号规则；不能仅按 tier 在 UI 重建权限，也不能把 `policyFor` 的基础值当作用户最终授权。改字段需核对三端，禁止用 UI 禁用替代服务端校验。

## 增加图片、视频或理解能力

- 生成进度复用 [codex/progress.rs](../../apps/desktop/src-tauri/src/codex/progress.rs) 的 `GenerationProgress`／`GenerationStage` 及 `Chunk::Progress`。Codex CLI、Dreamina 图片／视频和恢复 worker 共用 `codex://chunk`，命令层补齐 job／turn 身份。`jimeng_video::response` 仅在桌面 provider 模块内复用为 Dreamina stdout JSON 解析器；它不是跨模块／跨运行时 API。不将原始工具参数、推理或诊断正文写入用户阶段标签。

- **用途／关键词**：生成、反推、命名、provider、Codex、Dreamina、Cloud。
- **入口**：[codex/mod.rs](../../apps/desktop/src-tauri/src/codex/mod.rs) 的 `GenProvider`／`resolve_gen_provider` 分派生成；[understand.rs](../../apps/desktop/src-tauri/src/codex/understand.rs) 的 `UnderstandProvider`／`resolve_entitled_understand_provider`／`resolve_understand_provider_with_choice` 分派理解。UI 从 [store.ts](../../apps/desktop/src/store.ts) 的 `startGeneration` 等既有 action 进入。
- **调用**：[commands/codex.rs](../../apps/desktop/src-tauri/src/commands/codex.rs) 的 `codex_create_image` 调用 `resolve_gen_provider`，反推路径调用 `resolve_understand_provider_with_choice`；store 的 `startGeneration` 调用 `api.codexCreateImage`。
- **边界／状态**：**可跨模块复用（桌面 Rust provider 层）**。底层 factory 本身不代替账号、上传许可和任务门控。`api.codexCreateImage` 虽带 Codex 名称，实际传入 provider 与 image/video 参数；不要按名字再建另一套 Cloud UI 通路。理解和生成接口不等价，即梦不承担理解；视频模式另读 [视频接入](../SEEDANCE-2.5-INTEGRATION.md)。

## 保留生成任务、取消和启动恢复

H3 的独立提示词优化复用 [canvasWorkflowRuntime.ts](../../apps/desktop/src/lib/canvasWorkflowRuntime.ts) 的 `optimizeComfyPrompt` 和既有 `cloudAgentStart`／`cloudAgentGet`／`cloudAgentCancel` 文本改写协议。调用入口必须是用户明确点击的付费优化动作，不能放入普通生成、触发或循环路径。Skill 和模式指令由 [h3PromptOptimization.ts](../../apps/desktop/src/lib/h3PromptOptimization.ts) 提供，限定 H3 卡片文本；结果保存于原工作流步骤供选用，不写入图片输出，不新增 Runner。通路依旧受 Cloud DSH 测试权限与 Agent 计费限制；见 [H3 优化契约](../COMFYUI-LOCAL-VIDEO.md#2026-11-06独立提示词优化源码待发布)。

对话渠道的 HyperFrames 能力沿 [local_chat.rs](../../apps/desktop/src-tauri/src/commands/local_chat.rs) 的受控动态工具接入 [agent_ds/chat_video.rs](../../apps/desktop/src-tauri/src/commands/agent_ds/chat_video.rs)，与 Agent 卡片共用 `video::execute` 和工程副本／入库契约。对话模型直接编写工程，不投递第二个 Agent；进度与视频附件复用 `local_chat_messages`，UI 复用 `VideoPlayer`。工具参数不接收绝对路径或任意命令；调用必须绑定已确认的当前对话轮次，Cloud 不开放此工具。

本机 Skill 视频制作复用 [agent_ds.rs](../../apps/desktop/src-tauri/src/commands/agent_ds.rs) 的 `agent_ds_workflow_start`／结果／入库协议，`purpose: agent-video` 由 [video.rs](../../apps/desktop/src-tauri/src/commands/agent_ds/video.rs) 提供固定版本 HyperFrames 环境、工程副本与 `serve` 工具桥。Codex 保留沙箱，只请求固定本机检查／截图／渲染命令；不能用视频生成 provider 或受限 HTML 截图 renderer 代替。独立编辑面板由 [video_studio.rs](../../apps/desktop/src-tauri/src/commands/agent_ds/video_studio.rs) 的 open／resize／close 管理服务与 WebView，React 使用 [VideoStudioPanel](../../apps/desktop/src/components/VideoStudioPanel.tsx)。这些是桌面 Agent 内部能力，不能跨运行时导入；Cloud 扩展继续沿统一 Harness。完整契约见 [VIDEO-SKILL.md](../VIDEO-SKILL.md)。

本机 H3 使用独立的既有持久任务协议：前端 [comfyVideo.ts](../../apps/desktop/src/lib/comfyVideo.ts) 的 `comfyVideo`／`comfyEnvironment`，Rust [comfy_video.rs](../../apps/desktop/src-tauri/src/commands/comfy_video.rs) 的固定模式 graph 与恢复、[comfy_setup.rs](../../apps/desktop/src-tauri/src/commands/comfy_setup.rs) 的按模式环境准备。`frames`／`reference`／`text` 由显式选择确定，缺省兼容旧首尾帧；[composerLocalVideo.ts](../../apps/desktop/src/lib/composerLocalVideo.ts) 让主屏和画板先保存同一 H3 卡片再执行。模式选择复用 `comfyVideoOptionsForMode`，环境响应的 `mode`／`modelsRequired` 用于当前模式就绪判断，`canAddModels` 仅表示托管环境可以补模型。此接口限定桌面与本机 loopback，不接受任意工作流；见 [三模式契约](../COMFYUI-LOCAL-VIDEO.md)。

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

## 保持断开目录后的素材可见性

- **入口／调用**：[folder_connections.rs](../../apps/desktop/src-tauri/src/core/folder_connections.rs) 的 `disconnect_directory(paths, id)` 将连接移除与断联事实写入同一事务；[external_files.rs](../../apps/desktop/src-tauri/src/core/external_files.rs) 的 `link_external_to_library` 记录明确独立收集并清除断联，重新连接也恢复原身份。
- **复用边界**：[material_catalog.rs](../../apps/desktop/src-tauri/src/core/material_catalog.rs) 的 crate 内部 `catalog_visibility`／`library_membership_sql` 统一供应分页、标签、旧列表／搜索／计数／色板及常用素材查询；不要另按 `library_hidden` 推断目录成员。0051 的独立收集／断联表只影响全局成员展示，不删除原件、缓存、创作资料或真实项目成员；其他连接／分身、独立收集与受管路径保留。旧版已经断开的来源不能可靠推断，升级不批量猜测隐藏。详见 [文件契约](../FOLDER-MODE.md)。

## 回收原件或清理缺失引用

- **入口：** `assetOriginals.preview/trash` → [folder_connections.rs](../../apps/desktop/src-tauri/src/core/folder_connections.rs) 的 `preview_asset_originals`／`trash_asset_original`；同一确认协议区分真实回收与 `cleanup_missing_original` 元数据清理。确认前后均核对身份、路径和内容状态，不用缓存判断原件仍存在。
- **画板同步：** [project_canvas.rs](../../apps/desktop/src-tauri/src/core/project_canvas.rs) 的 crate 内 `hide_removed_original_canvas_nodes` 在调用方事务内，根据已回收／已清理路径解析全部身份，复用 `hide_asset_canvas_nodes` 和 `hide_empty_generation_cards_for_asset`。后者排除已回收／缺失清理的产物记录；不得以资产行仍存在判断图片仍有效。回收失败连同画板隐藏回滚，旧失效标记也能补齐清理；历史、素材和关系记录保留，不新增物理删除。验证见 [画板清理](../FOLDER-MODE.md#2026-11-08原件删除后的画板清理源码待发布)。

## 探测媒体、生成缩略图或调用 FFmpeg

- 强化复刻（Cloud 已部署，桌面源码待发布）：`commands/video_replication/enhanced.rs`、`enhanced/{finish,markers}.rs` 经原 `video_replication` 的 `enhanced-*` 操作连接 `EnhancedReplication.tsx`；复用 reference 校验、媒体工具／probe／audio、understand 队列／计费、`codex_create_image` 即梦任务与 generation history，新增切片及分步骤回执、WAV 契约／豆包语音适配、词标记和字幕成片编排。`enhanced-frame` 沿项目／源哈希校验提取缓存中点帧，`replicationAnalysisNote` 适配原内容卡片两列 payload；正式输出复用图片入库和项目建卡接口。均为复刻内部接口，未另建 Agent runner；上线、验收和限制见 [复刻专项](../VIDEO-REPLICATION.md#强化复刻首版cloud-已部署桌面源码待发包)。

- **用途／关键词**：probe、缩略图、ffprobe、FFmpeg、视频封面、二进制发现。
- **入口**：[media/probe.rs](../../apps/desktop/src-tauri/src/media/probe.rs) 的 `probe` 与 [media/thumb.rs](../../apps/desktop/src-tauri/src/media/thumb.rs) 的 `generate`／`generate_video`；确需启动工具时，用 crate 内 [media/tools.rs](../../apps/desktop/src-tauri/src/media/tools.rs) 的 `resolve(Tool::Ffmpeg/Ffprobe)`、`command`。
- **调用**：`probe_video_ffprobe` 用 `resolve(Tool::Ffprobe)` 和 `command`；`generate_video` 的 FFmpeg 分支用同一 resolver。它们也保留平台原生媒体分支，不要求所有操作强制 FFmpeg。
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

## 复用 Bcoin 预授权与结算

- **用途／关键词**：余额、hold、幂等键、确认、回滚、待结算。
- **入口**：[_shared/billing.ts](../../apps/cloud/supabase/functions/_shared/billing.ts) 的 `holdCredits`、`confirmCredits`、`rollbackCredits`、`markPendingSettlement` 封装账本 RPC；`ensureDailyCredits` 是保留的历史名称，当前传 `p_amount: 0`，不能据此新增每日赠币。
- **调用**：[understand-proxy/index.ts](../../apps/cloud/supabase/functions/understand-proxy/index.ts) 调用 hold／confirm／rollback；[agent-run/index.ts](../../apps/cloud/supabase/functions/agent-run/index.ts) 在创建与容量失败路径调用 hold／rollback。
- **边界／状态**：**可跨模块复用（Cloud Edge Functions）**。需已验证用户、admin client、当前 migrations 与服务端 service 定价；异步任务各自拥有持久化与结算状态机，不能复制同步接口的 catch 就统一退款。供应商结果未知与可确认失败不同；新计费服务先读 [当前定价](../Bowerbird定价方案v2-订阅积分制.md)、[收费化计划](../ARCH-ADJUST-PLAN.md)。

## 接入微信支付与恢复原订单

- **用途／关键词**：Native、扫码、下单、支付通知、查单、退款、日账。
- **入口**：Cloud [_shared/wechatpay.ts](../../apps/cloud/supabase/functions/_shared/wechatpay.ts) 提供 `WechatPayClient`、签名验签及通知解密；[_shared/wechatpay-service.ts](../../apps/cloud/supabase/functions/_shared/wechatpay-service.ts) 提供业务入口、订单绑定与恢复；[_shared/wechatpay-bill.ts](../../apps/cloud/supabase/functions/_shared/wechatpay-bill.ts) 核对日账。
- **调用**：`create-checkout`、`checkout-status`、`payment-webhook`、`payment-admin`、`payment-reconcile`；桌面通过 `api.cloudCreateCheckout`／`cloudCheckoutStatus`／`cloudCheckoutCapability` 和原账号网关调用。
- **边界／状态**：Cloud 共用能力，仅服务端持商户私钥。沿用原子 Bcoin 入账／退款，不能从桌面调用 service-only RPC。二维码只表达待付订单，权益以服务端为准；详见 [微信接入](../../apps/cloud/WECHATPAY.md)。源码及隔离测试完成，不代表已部署或真实收款通过。

## 给 Agent 增加受控工具

Agent 卡片与对话框的新请求统一复用 `localChatStore` → `local_chat_send`；`workflowAgentChat` / `CanvasWorkflowController.chatResult` 仅适配工作流输入和原轮次输出，不新增 runner。SQLite 原子绑定同 nodeId 的会话／Agent 投影；`local_chat_get_by_request` 只读原请求身份，既有 `localDsRequestId` / `agentRunId` 仅用于恢复。全文和表格结果复用 `workflowAgentResult` / `workflowAgentOutputs`。Cloud 共用聊天服务，0084 与聊天 Worker／Edge／网关于 2026-11-09 经用户确认后部署并核验；桌面源码尚未发布安装包，详见[当前统一契约](../CHAT-PROVIDERS.md)。

- **用途／关键词**：Tool Gateway、DSH、审批、lease、durable、工具账本、TaskAuthorization。
- **入口**：Worker [scoped-tool-gateway.ts](../../apps/agent-worker/src/harness/scoped-tool-gateway.ts) 的 `ScopedToolGateway`／`ToolGatewayDefinition` 校验工具、阶段、授权和参数；外部副作用通过 [durable-tool-dispatcher.ts](../../apps/agent-worker/src/kernel/durable-tool-dispatcher.ts) 的 `DurableToolDispatcher`。v3 能力额度与动作 journal 由 [adaptive-tool-gateway.ts](../../apps/agent-worker/src/harness/adaptive-tool-gateway.ts) 的 `AdaptiveToolGateway` 管理。
- **调用**：[unified-planning-tool-bridge.ts](../../apps/agent-worker/src/harness/unified-planning-tool-bridge.ts) 的 `createUnifiedPlanningToolBridge` 组合 scoped gateway；[unified-planning-run-processor.ts](../../apps/agent-worker/src/cloud-agent/unified-planning-run-processor.ts) 实例化 adaptive gateway；[controlled-image-executor.ts](../../apps/agent-worker/src/providers/ark/controlled-image-executor.ts) 使用 durable dispatcher。
- **边界／状态**：**可跨模块复用（Worker 内受控工具）**。Scoped 与 Adaptive 是不同层次，不能互换；需控制面 run/lease、授权交集、可信 slot 与 checkpoint。不得用模型自报 callId 执行副作用，也不为新内容能力另建 Runner。新工具契约修改要同步 Cloud 与 Worker 校验；先读 [通用 Harness](../UNIFIED-AGENT-HARNESS-PLAN.md)，不据源码存在推断已对所有用户开放。

## 从浏览器扩展采集图片或视频

- **用途／关键词**：MV3、网页取图、浏览器会话、save_blob、WebSocket、采集回执。
- **入口**：[collection-utils.js](../../apps/extension/collection-utils.js) 经 `globalThis.BowerbirdCollection` 暴露 `uploadBytes`／`checkVideoSupport`；[background.js](../../apps/extension/background.js) 的消息监听接收 `save_image`／`save_video`。桌面入口为 [collect/ws_server.rs](../../apps/desktop/src-tauri/src/collect/ws_server.rs) 的 `start`，解析元数据帧和二进制帧。
- **调用**：`background.js` 的 `fetchVideo` 调用 `BowerbirdCollection.uploadBytes`；桌面 [lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 启动 `collect::ws_server::start`，视频保存走 [video_blob.rs](../../apps/desktop/src-tauri/src/collect/video_blob.rs) 的 `save`；内置探索 [source_browser_capture.rs](../../apps/desktop/src-tauri/src/commands/source_browser_capture.rs) 也复用该保存层。
- **边界／状态**：**模块内部专用（扩展采集协议）**；视频保存层在 Rust crate 内已有跨入口调用。扩展 JS 是 classic script/global 导出，不是 React 模块；浏览器下载保持站点会话，上传只发字节及来源，不导出 Cookie。视频必须能力协商。内置探索和扩展的下载范围不同，不能拿一侧流媒体支持替另一侧作保证；见 [扩展 README](../../apps/extension/README.md)、[探索契约](../EMBEDDED-BROWSER.md)。

## 为官网或桌面配置 Cloud 反向代理入口

- **用途／关键词**：官网、Node、网关、账号代理、签名上传下载、路由白名单。
- **入口**：[account-proxy.mjs](../../website/account-proxy.mjs) 的 `createAccountProxy` 处理账号/auth 和购买查单固定路由；[cloud-proxy.mjs](../../website/cloud-proxy.mjs) 的 `createCloudProxy` 按共同契约处理六个 Function、受限原任务查询与 Storage 签名路径；[payment-proxy.mjs](../../website/payment-proxy.mjs) 的 `createPaymentProxy` 原样转发微信签名通知。
- **调用**：[server.mjs](../../website/server.mjs) 的 `startServer` 按 `/api/account/`、`/api/cloud/` 和 `/api/pay/` 分派。
- **边界／状态**：**模块内部专用（website Node server）**。各 handler 的超时、路由、大小、流式传输及断连行为不同；都不能成为任意 URL 代理，不携带 service key，不自动重试。支付通知不能 JSON 解析后重序列化。可以扩展其明确支持的路由，不从桌面直接 import，也不把 `server.mjs` 内早期生成函数当作通用 provider API。

## 本机角色声音与配音

- `commands/voice.rs` 提供 voice_configure／snapshot／save／start／cancel／recover／manage／export；前端 `lib/voice.ts` 是类型化入口。参考裁剪复用音频解码与 media::tools 的 FFmpeg，发布复用 ingest_generated、LibraryPaths 与素材变更事件；持久化运行身份及回执属于声音模块，不跨模块复用其内部 JSON 文件。
- `commands/voice_setup.rs` 提供 voice_environment 的 status／check／install／pause，专用目录托管 Python、依赖与固定模型，复用库内原子 JSON 写入；不要向其他模块暴露其安装状态全局锁。模型／uv 下载清单在 voice-downloads.json。Windows x64 + NVIDIA，保留高级手动连接，不新增 Cloud 或 Agent 执行器。
- `VoiceStudio` 复用 ModalShell、AudioWaveform、共享播放器、MediaTrimTimeline、materialCatalog、importFiles 与 saveMediaAssetToCanvas。 2026-11-11 收敛为录音克隆；voiceApi.start 不再提供描述参数，原生命令拒绝无参考或非空描述请求，历史记录继续可读。工具箱由 CanvasWorkspace 先固化项目再提交；voiceStudioDraft 只负责本功能的按项目草稿与试听输入身份。边界和验证见 [角色声音](../VOICE-STUDIO.md)。

## 重复候选与覆盖边界

- **模块内部专用（各端契约）；共用源提取仍为候选**：Cloud [_shared/task-authorization.ts](../../apps/cloud/supabase/functions/_shared/task-authorization.ts) 与 Worker [contracts/task-authorization.ts](../../apps/agent-worker/src/contracts/task-authorization.ts) 各自维护 `TaskAuthorization`／`parseTaskAuthorization`。前者经 [_shared/unified-agent-plan.ts](../../apps/cloud/supabase/functions/_shared/unified-agent-plan.ts) 消费，后者经 `AdaptiveToolGateway` 消费。2026-11-06 新增 [task-authorization-sync.test.ts](../../apps/agent-worker/src/contracts/task-authorization-sync.test.ts)，由现有 Worker `test` 自动纳入：仅统一 CRLF/LF 后比较完整源码，变更契约须同步两端。此检查不改变运行时隔离，不提供跨包生产导入入口，也不代替授权行为测试。
- **尚待确认**：两个 website proxy 都有 `readLimited`／限流片段，但失败状态码、输入输出方向及流控策略不完全相同；先比较测试与传输契约，再决定是否值得提取。Rust/Edge/TS 三份 FeaturePolicy 则有本机门控、服务端用户策略、序列化类型之分，不推荐仅凭同名合并。
- 本页抽查了桌面接口、生成和文件接入、Cloud 鉴权计费、Worker 工具、扩展与官网网关；没有穷举 Rust DB 查询、每个 provider、所有 Edge Function、安装更新、支付、renderer 内部与平台原生分支。这里只验证静态入口及调用关系，未联网调用或验证部署状态。
