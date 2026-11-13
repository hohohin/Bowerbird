# 桌面业务与状态复用

[返回复用地图](../Bowerbird开发计划.md#复用地图)。以下入口按 2026-11-03 当前工作区源码及生产调用核对，包含未提交实现；不代表已发布。公共入口均指桌面应用内部，不是供 Cloud、扩展或官网直接导入的包。API 与原生边界见 [服务与接口](SERVICES.md)，外观入口见 [UI](UI.md)。

## 切换项目、读取任务和共用身份

- 生成会话标题共用 [projectActivity.ts](../../apps/desktop/src/lib/projectActivity.ts) 的 `generationSessionTitle`，取首轮原文的第一行非空文字。`loadGenJobs(jobId)` 可按 ID 恢复超出近期列表的会话，`openGenerationJob(jobId)` 打开对应会话并定位到所属项目。创作框的「并入上个生成」气泡使用同一合组目标 ID。

- [generationGallery.ts](../../apps/desktop/src/lib/generationGallery.ts) 的 `reportGalleryMerge` 统一发出当前项目的合组撤销回执及通知，供 `CreationBoard`、合组菜单和 `CanvasWorkspace` 共用；只恢复展示关系，不回滚生成任务或原文件。画板组图计算继续使用 `canvasConversationCards`，显式选择的引用节点可归组，未选复制引用保持独立。[边界与验证](../CANVAS-WORKFLOW.md#2026-11-11显式抽卡与手动合组源码待发布)。

- 画布撤销复用 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的 `pushCanvasUndo`／`undoCanvasAction` 与现有有序写入队列，业务编辑显式记账，自动布局／任务进度不另造用户历史。[canvasNoteUndo.ts](../../apps/desktop/src/lib/canvasNoteUndo.ts) 的 `restoreCanvasNoteEdit` 按格 ID 和字段恢复内容，保留后到的其他格结果；`CanvasTextCard.onChange` 的第三参数区分普通编辑／连续输入／自动撑高。当前画布会话专用，不用它回滚原文件或服务端任务；覆盖与验证见 [画布撤销](../CANVAS-WORKFLOW.md#2026-11-10画布编辑撤销源码待发布)。

- 产物落点复用 [canvasReferencePlacement.ts](../../apps/desktop/src/lib/canvasReferencePlacement.ts) 的 `placeCanvasCardNearSource`（输出可指定最小横坐标）及 `canvasOutputGrid`；[canvasOutputPlacement.ts](../../apps/desktop/src/lib/canvasOutputPlacement.ts) 提供可见占位、工作流缓存尺寸、输出落点与整理连线关系，实际调用为 `canvasWorkflowRuntime`、`CanvasWorkspace`。`canvasArrangement` 继续承担用户显式整理；生成自动落点只创建新位置，不调用全分支整理。原生对应入口在 `core/project_canvas/placement.rs`，不能跨运行时导入 TS 或将 DOM 测量作为后台唯一依赖。[契约与验证](../CANVAS-WORKFLOW.md#2026-11-09产物卡片紧凑布局源码待发布)。

- 生成阶段复用 [generationProgress.ts](../../apps/desktop/src/lib/generationProgress.ts) 的 `applyGenerationProgress`／`generationProgressLabel`：store 按运行中 job＋turn 接收，GenerationPanel、CanvasWorkspace 与 `libraryGenerationActivity` 共用文案。只呈现后端观察到的阶段和有效队列数字；不从耗时或调用次数推算百分比。恢复／终态及协议证据见 [生成阶段反馈](../CANVAS-WORKFLOW.md#2026-11-08生成阶段反馈与-cli-进度核查源码待发布)。

- 用途／关键词：路由、scope、flush、任务状态、Asset、Project、GenJob、CanvasNode。
- 入口：[store.ts](../../apps/desktop/src/store.ts) 的 `useStore`，通过 action（如 `enterProject`、`exitProject`、`startGeneration`）操作；领域数据类型从 [types.ts](../../apps/desktop/src/lib/types.ts) 导入。实际调用：[App.tsx](../../apps/desktop/src/App.tsx) 调用 `enterProject`／`exitProject`；[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 订阅 `genJobs` 并调用生成 action。
- 边界：action 包含离开前保存、路由排队、原生 scope 成功后提交状态等规则，不用 `setState({ activeProjectId })` 绕过。Asset ID、目录条目 ID、画板实例 ID、任务 ID 不可互换；文档专用类型另见下文。页面局部草稿不应全部塞进全局 store。
- 状态：**可跨模块复用**。项目持久化契约见 [项目画板](../PROJECT-CANVAS-PLAN.md)。

## 启动工作流或恢复定时预约

- 展示当前工作流输入时，[workflowBindingAssetIds](../../apps/desktop/src/lib/canvasSessionOutputs.ts) 读取素材、内容格或上游本轮产物；[workflowSourceMediaLabel](../../apps/desktop/src/lib/workflowCanvasCapabilities.ts) 根据素材元数据或已知生成类型标注来源。卡片、输入引用和断开菜单使用同一套显示名称，输入绑定仍由原端口和编号定位。

- 生成结果直连下游时，[canvasSessionOutputs.ts](../../apps/desktop/src/lib/canvasSessionOutputs.ts) 的 `workflowGenerationResultAnchor` 供画板绘线和整理共用，返回本轮产物所在的可见卡片或单元格。`workflowGenerationPreviewIds` 用于素材预览；调度、重跑和提示词引用继续通过生成卡的输出身份取值。[生成结果接入下游](../CANVAS-WORKFLOW.md#2026-11-13生成结果接入下游桌面源码待发布)。

- 项目删除后的收尾复用 `canvasWorkflowRuntime.ts` 导出的 `discardProjectWorkflow(projectId)`：store 在原生删除成功后调用，只停止该项目本地调度、计时器和后续保存，不等待 provider 终态、不宣称远端已取消。删除入口复用 `useProjectDeletion` → `ProjectDeleteDialog` → `deleteProjectCanvas`，不另建任务状态确认。详见 [项目删除](../PROJECT-CANVAS-PLAN.md#2026-11-10确认删除项目后不再由任务状态否决源码待发布)。

- 用途／关键词：触发器、定时、跨画板、执行锁、运行恢复。
- 入口：[canvasWorkflowRuntime.ts](../../apps/desktop/src/lib/canvasWorkflowRuntime.ts) 的 `canvasWorkflowController(projectId)` 持有项目控制器；手动启动复用 `start`，定时在同一控制器复用启动路径，不另建任务提交器。[WorkflowScheduleCoordinator.tsx](../../apps/desktop/src/components/WorkflowScheduleCoordinator.tsx) 由 `App` 挂载，以 `setTriggerTimersEnabled` 维护非归档项目的计时生命周期。
- Agent 会话通过 `create_canvas_cards` 配置本批触发卡，用 `runCard` 指定本批单个运行入口。主窗口的 `WorkflowScheduleCoordinator` 领取已保存的动作并通过项目控制器 `start` 启动，断线取回读取原回执。
- 四种模式共用 [workflowTriggerSchedule.ts](../../apps/desktop/src/lib/workflowTriggerSchedule.ts) 的 `workflowTriggerMode`，兼容旧卡配置；定时入口使用 `activeTriggerSchedule` 排除其他模式的停用预约。一次性与每日模式使用同文件的 `nextDailyTrigger`、`triggerScheduleOccurrence`、`advanceTriggerSchedule`，供卡片表单和运行时计算本机日历时刻、每次运行身份及下一次预约，不供其他模块创建独立调度器。
- 边界／状态：**工作流模块内部专用**。只在桌面应用运行期间调度；不承担系统唤醒、关闭后执行或云端 cron。到点消费检查点由原生 SQLite 事务保护；复制入口清除 `triggerSchedule`。当前契约和验证见 [画板工作流](../CANVAS-WORKFLOW.md#2026-11-05触发器定时执行源码未发布)。

## 在新面板里嵌入独立素材浏览状态

- 用途／关键词：分栏、嵌入素材库、筛选、滚动位置、缩略图尺寸、pane。
- 入口：[libraryPane.tsx](../../apps/desktop/src/lib/libraryPane.tsx) 的 `createLibraryPane`、`LibraryPaneContext`、`useLibraryModeStore`、`useLibraryThumbnail`；实际调用：[LibraryHome.tsx](../../apps/desktop/src/components/LibraryHome.tsx) 创建首页 pane，[TextWorkspaceLibrary.tsx](../../apps/desktop/src/components/TextWorkspaceLibrary.tsx) 创建文本工作区独立 pane 并挂 Provider。
- 边界：`id` 决定尺寸／固定项的持久化键，复用浏览组件时应明确状态归属；未挂 Provider 会回退全局 `useLocalFileMode`。共享 Asset 与项目身份，独立持有浏览模式、位置和偏好，不另建素材数据源。
- 会话数据缓存：[catalogCache.ts](../../apps/desktop/src/lib/catalogCache.ts) 的 `catalogCache` 提供有上限的快照、读取合并与版本失效；[useCatalogRevision.ts](../../apps/desktop/src/lib/useCatalogRevision.ts) 的 `useCatalogRevision`／`invalidateCatalog` 统一订阅和本地操作后的失效。实际调用为 `CategorizedLibrary`、`ConnectedCollections`、`VirtualCatalog`；概览键包含项目上下文，分页键包含完整过滤条件和段落／页码，不能以 pane ID 或组件内从零开始的 revision 代替。只缓存桌面浏览数据，不缓存显式选取的 ID／原件解析，不跨应用重启持久化；关闭全部面板仍接收原生变更。只有用户手动刷新调用 `folderConnections.refresh(folderId, force)`（默认 true）；打开／回焦只读索引，禁止再调用此扫描入口。后台同步复用原生 watcher 和建联队列。[契约与验证](../FOLDER-MODE.md#素材库会话缓存2026-11-10源码待发布)。
- 导航状态：[localFileMode.ts](../../apps/desktop/src/lib/localFileMode.ts) 的 `view` 表示全部／项目／集合／标签一级入口，`source` 是实际查询范围，`tagSource` 保留标签范围；`setView`、`setTagSource` 和 `openSource` 统一切换，不再按媒体和来源各存一套隐藏分类。`contextProjectId` 是宿主项目（主页为 null），`browseProjectId` 是所选素材库项目；宿主调用 `setProjectContext` 恢复 `bowerbird.libraryProject.<项目ID或home>` 本机记忆，未记忆的项目上下文默认自身。`selectProject` 仅改变浏览项目并记忆，不调用项目导航；项目失效时由 `LibraryCatalogTransition` 展示选择器，不能以空项目范围退回全库。`copyLibraryPane` 复制视图、标签范围与项目浏览状态，分栏继续独立；切换媒体保持一级视图，导入后由 `showImportedMedia` 回到对应范围的平铺列表。
- 项目边界：[CategorizedLibrary.tsx](../../apps/desktop/src/components/CategorizedLibrary.tsx) 的 `browseProjectId` 用于项目素材查询、位置记忆、标签／分类及导入归属，`projectId` 仍表示当前创作项目，用于添加到画板、引用和截帧目标。新增嵌入宿主必须明确二者；不得为了浏览其他项目而修改 `activeProjectId`。`FileDropImport` 在完成后核对浏览项目身份，迟到结果不会切换另一个项目的素材视图。
- 页签记忆：`createLocalFileMode(paneId)` 按 pane＋主页／项目上下文保存 `view`、`tagSource`，`setProjectContext` 恢复后推导一致的 `source`／`mode`；`createLibraryPane(id)` 自动传入 pane ID，复制分栏仍复制当前选择。普通打开只用 `setOpen(true)`，不要用 `openSource("global")` 覆盖记忆；`openSource`／`setView` 保留给用户明确切换、快捷键或显式结果定位。临时菜单不持久化，存储失败保留会话内记忆。[契约与验证](../FOLDER-MODE.md#2026-11-11素材库页签记忆源码待发布)。
- 现有画板入口：[Toolbar.tsx](../../apps/desktop/src/components/Toolbar.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 共用 `useStore.canvasLibraryOpen`／`setCanvasLibraryOpen` 和 `useLocalFileMode.setOpen(true)`；顶栏先恢复上次素材视图，展开后显示既有连接操作。`ConnectedCollections` 复用公共 `catalog-tree-row` 的 hover／focus／`is-menu-open` 名称避让，不给空闲目录名称无条件预留操作宽度。
- 局部通知：`subscribeCatalogPreviews`／`subscribeConnectionProgress` 沿会话监听分发原生事件；`patchCatalogPage`／`patchConnectionProgress` 同时用于缓存、在途响应和可见页，禁止将预览／扫描进度重新转成全库失效。`useCatalogRevision(colorFiltered)`、`catalogCache.revision(colorFiltered)` 与 `read(key, loader, colorFiltered)` 必须使用一致的颜色范围；普通预览仅局部补字段，颜色筛选单独重验成员。`VirtualCatalog`、`ConnectedCollections` 是实际调用方，语义见 [性能说明](../FOLDER-MODE.md#文件夹读取与预览性能2026-11-10)。
- 状态：**可跨模块复用**；仅适合桌面素材浏览宿主，不是通用全应用状态容器。

## 给素材列表加入单选、持续多选和 Shift 选择

- 用途／关键词：选择、Ctrl、Cmd、Shift、范围、anchor。
- 入口：[catalogSelection.ts](../../apps/desktop/src/lib/catalogSelection.ts) 的 `selectCatalogItem`；实际调用：[CategorizedLibrary.tsx](../../apps/desktop/src/components/CategorizedLibrary.tsx) 与 [ConnectedCollections.tsx](../../apps/desktop/src/components/ConnectedCollections.tsx) 的 `select`。
- 边界：公共函数只处理单项增删与多选模式，**不负责取范围内 ID**。标签／全部视图选择 Asset ID，真实集合选择 entry ID；两宿主分别解析 section、分页、范围起点与迟到结果保护，不能直接复制或互换其 `select` 闭包。
- 状态：单项规则 **可跨模块复用**；两处范围分页编排是 **待提取候选**，提取前须保留身份差异与异步取消语义。

## 顺序保存画板，失败时阻止后续覆盖

- 用途／关键词：FIFO、保存队列、写屏障、失败重试、journal。
- 实现：[orderedWriteJournal.ts](../../apps/desktop/src/lib/orderedWriteJournal.ts) 的 `createOrderedWriteJournal`、`drainOrderedWriteJournal`；实际调用：[CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的 `writeJournalRef` 与保存／离开流程。
- 边界：失败队首保留，显式重试前阻止后续写；该 helper 自身没有并发 drain 锁，串行启动和项目生命周期由画板宿主承担。查看画板保存流程时从宿主入手，不把它当通用并发任务调度器或网络重试器直接接入其他板块。
- 状态：**模块内部专用**（当前生产调用仅画板）；可泛化性尚未验证。

## 读取素材的色板 JSON

- 用途／关键词：颜色、色板、JSON、parseColors。
- 入口：[assetColors.ts](../../apps/desktop/src/lib/assetColors.ts) 的 `parseColors`；实际调用：[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 解析 `asset.colors`，[MasonryGrid.tsx](../../apps/desktop/src/components/MasonryGrid.tsx) 的 `Thumb` 解析 `shown.colors`。
- 边界：空值、非法 JSON 和非数组返回空数组；数组只保留字符串，保持顺序、重复项和原始字符串，不验证或规范化色值。`useFileColors` 是文件颜色查询 Hook，不承担此解析职责。
- 状态：**可跨模块复用（桌面纯函数）**。边界验证见 [asset-colors.test.mjs](../../apps/desktop/scripts/asset-colors.test.mjs)。

## 显示 HEIC 原件或列表缩略图

- 用途／关键词：HEIC、HEIF、兼容预览、原件、缩略图队列。
- 入口：[useCompatibleImagePath.ts](../../apps/desktop/src/lib/useCompatibleImagePath.ts) 的 `useCompatibleImagePath`，内部通过 [externalFiles.ts](../../apps/desktop/src/lib/externalFiles.ts) 的 `externalFiles.media` 获取兼容显示路径；实际调用：[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx)、[CreationImagePreview.tsx](../../apps/desktop/src/components/CreationImagePreview.tsx)、[Lightbox.tsx](../../apps/desktop/src/components/Lightbox.tsx)。
- 边界：返回的是显示路径，不改 Asset 原件身份；需要 URL 时宿主使用 Tauri `convertFileSrc`。列表的 [FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 另通过 [filePreviewQueue.ts](../../apps/desktop/src/lib/filePreviewQueue.ts) 的 `createFilePreviewQueue(externalFiles.preview)` 做缩略图优先级／缓存；不要拿缩略图用于文件交付或模型原件输入。
- 状态：兼容显示 hook **可跨模块复用**；列表队列实例 **模块内部专用**，不同尺寸与源版本的缓存键不能混用。

## 让画布媒体只在可见时占用资源

- 用途／关键词：懒加载、可见性、IntersectionObserver、缩放、分级预览。
- 入口：[useMediaVisibility.ts](../../apps/desktop/src/lib/useMediaVisibility.ts) 的 `useMediaVisibility`；图片优先使用 [CanvasImage.tsx](../../apps/desktop/src/components/CanvasImage.tsx) 的 `CanvasImage`／`CanvasMediaProvider`，内部结合 [canvasImagePreview.ts](../../apps/desktop/src/lib/canvasImagePreview.ts) 的 `requestCanvasImagePreview`。实际调用：`CanvasImage` 与 [VideoPoster.tsx](../../apps/desktop/src/components/VideoPoster.tsx) 使用此 hook。
- 边界：按最近 `.canvas-stage` 共用观察器，识别 `is-view-hidden`，无画布祖先才使用窗口；保留卡片几何，仅释放媒体。Provider 负责稳定后的缩放和 DPR；不能用显示预览替代原图编辑／输出。音频波形目前有自己的可见性订阅，不应假定已全部接入此 hook。
- 状态：hook **可跨模块复用**（须符合宿主可见性契约）；画布分级预览 **模块内部专用**。详见 [画板媒体](../PROJECT-CANVAS-PLAN.md)。

## 播放视频、悬停预览并保存截帧

- 用途／关键词：VideoPlayer、视频播放、悬停、当前帧、尾帧、sourceKey、来源版本。
- 完整播放器入口：[VideoPlayer.tsx](../../apps/desktop/src/components/VideoPlayer.tsx) 的 `VideoPlayer`；实际调用：[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 与 [Lightbox.tsx](../../apps/desktop/src/components/Lightbox.tsx)。传本机 `path`，组件内部 `convertFileSrc`；Asset 来源版本通过 [videoSourceKey.ts](../../apps/desktop/src/lib/videoSourceKey.ts) 的 `videoSourceKey` 同步到 `sourceKey`／React key，避免原文件改变后沿用旧媒体。`onAddFrame`／`onAddFrameToCanvas`／`onReferenceFrame` 接收 [videoFrame.ts](../../apps/desktop/src/lib/videoFrame.ts) 的 `VideoFrame`，宿主决定保存／投递目标。
- 素材库弹层推荐 [LibraryVideoPreview.tsx](../../apps/desktop/src/components/LibraryVideoPreview.tsx)，封装 Lightbox 与 [saveVideoFrame.ts](../../apps/desktop/src/lib/saveVideoFrame.ts) 的 `saveVideoFrame`，保留源视频路径／时间并冻结目标项目；[CategorizedLibrary.tsx](../../apps/desktop/src/components/CategorizedLibrary.tsx) 有真实调用。被动悬停使用 [VideoHoverPreview.tsx](../../apps/desktop/src/components/VideoHoverPreview.tsx)，[FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 传 `version`／`enabled`，500ms 后静音、全局单 owner，依赖祖先 button 并在滚动／隐藏等条件释放；它不承担截帧。另有 [MediaPreview.tsx](../../apps/desktop/src/components/MediaPreview.tsx) 的 `playback` 原生 video controls 分支，仅是轻量预览，不能视为全部播放入口已统一。
- 状态：播放器、素材库弹层与悬停入口 **可跨模块复用**，按完整操作／素材库保存／被动预览选择；不是网页视频采集器。新增完整操作优先 `VideoPlayer`，不要复制截帧与缓存逻辑；具体项目交付、格式和生命周期见 [视频媒体](../VIDEO-MEDIA.md)。

## 给素材卡和详情加入音频试听与波形

- 生成卡和 Agent 卡的素材预览、工作流断开菜单共用 [AudioWaveformThumbnail](../../apps/desktop/src/components/AudioWaveform.tsx)。它共用波形请求缓存和绘制函数，仅在预览进入可见范围时订阅，不创建播放器。

- 用途／关键词：音频、试听、连续播放、peaks、源版本、单播放器。
- 推荐 UI 入口：[AudioWaveform.tsx](../../apps/desktop/src/components/AudioWaveform.tsx) 的 `AudioWaveform`；底层为 [audioPreview.ts](../../apps/desktop/src/lib/audioPreview.ts) 的 `playAudioPreview`／`stopAudioPreview` 与 [audioPreviewPeaks.ts](../../apps/desktop/src/lib/audioPreviewPeaks.ts) 的 `requestAudioWaveform`。实际调用：[AudioFileMediaCard.tsx](../../apps/desktop/src/components/AudioFileMediaCard.tsx) 和 [AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 都渲染 `AudioWaveform`。
- 边界：一个 `HTMLAudioElement` 跨卡片持有持续播放；卸载只结束临时试听，不能随意停持续播放。原件修改／回收前释放对应句柄，`expectedVersion` 是原件指纹，不是 UI revision；波形按可见订阅和有限并发获取，不全量解码到 React。不是多轨混音器或视频播放器。
- 状态：**可跨模块复用**；格式与生命周期约束见 [音频素材库](../AUDIO-LIBRARY.md)。
- 画布独立音频卡片通过 `AudioWaveform.onWavePointerDown` 接入既有 `beginNodeDrag`，保留波形单击试听并在拖动／取消／多选后抑制误播；加载中也可拖动，完成后焦点回到卡片以支持撤销。素材库、详情与组内试听无需传此入口。[回归记录](../AUDIO-LIBRARY.md#画布音频拖动修复2026-11-10)。

## 在应用内拖素材，或把原件拖到其他应用

- 用途／关键词：drag、drop、payload、Asset ID、原生拖出、hold。
- 入口：[dragPayload.ts](../../apps/desktop/src/lib/dragPayload.ts) 的 `setDragAssets`／`getDragAssets` 管应用内身份；[externalDrag.ts](../../apps/desktop/src/lib/externalDrag.ts) 的 `startExternalDrag` 发起系统拖出。[FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 通过 `dragAssetIds` 取得 VirtualCatalog／ConnectedCollections／CanvasFrequentAssets 的完整选择并设置载荷；[CanvasWorkflowLayer.tsx](../../apps/desktop/src/components/CanvasWorkflowLayer.tsx) 读取。素材库原地长按复用 [useLibraryDragHold.ts](../../apps/desktop/src/lib/useLibraryDragHold.ts)，与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 共用 600ms 控制器及 `hold` 原生桥。
- 边界：模块载荷解决 WKWebView 自定义 MIME 丢失，需配合 `text/plain` 起拖信号并在结束清理；不能用于跨窗口／跨进程传输。系统拖出需 Tauri、登记后的 Asset ID，由 [core/external_drag.rs](../../apps/desktop/src-tauri/src/core/external_drag.rs) 的 `files` 解析图片／视频／音频原件并去重，当前不接受文本文件；画布需传 `source: "canvas"` 与取消 signal。`pickup` 是兼容协议，现行入口用 `hold`。
- 反馈：两种来源均传 `sourceRect`，共用 `externalDragHud`、两帧绘制等待和取消 ACK。素材库原地长按允许不超过 4px 微抖，传 `externalOnly: true` 后立即持续显示 HUD，并像画布一样拦截同窗投递；普通直接拖动在同窗 `dragenter`／`dragover` 仅隐藏 HUD／模糊，离窗恢复，保持内部落点与原生载荷。`visibility:hidden` 同时让 `SourceBrowserPanel` 恢复原生网页，不另建遮罩或以 `opacity:0` 替代。
- 状态：**可跨模块复用**；手势、平台和取消边界见 [跨应用拖动](../EXTERNAL-DRAG.md)。

## 接收文件／位图粘贴，或复制画板结构

- 用途／关键词：clipboard、paste、File、导入、原位连接、画板复制。
- 文件入口：[mediaImport.ts](../../apps/desktop/src/lib/mediaImport.ts) 的 `prepareMediaImport`、`importDroppedMedia`；实际调用：[FileDropImport.tsx](../../apps/desktop/src/components/FileDropImport.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的粘贴处理。单独拖入无需目录连接：有路径用 `api.importFiles(..., collect=true)`，无路径沿现有 `video_import_*` 分块命令接收，统一进入收集箱；可识别的已连接／受管路径不复制。包括 `.txt/.md/.markdown`；`showImportedMedia` 让纯文本切到文本、混合批次切到全部类型。[explorerCanvasDrop.ts](../../apps/desktop/src/lib/explorerCanvasDrop.ts) 的 `prepareExplorerCanvasDrop` 由正式画板接收，冻结项目与坐标，图片／视频创建素材卡，文本读取后创建独立的 3:4 文档卡；素材库内部文本拖入共用此入口。已知路径的文件粘贴仍原位引用，无文件路径的剪贴板位图走首次保存；先校验冻结的项目及 route revision。后端保存入口见 [服务地图](SERVICES.md#接入已有本地文件或保存新收到的媒体)。
- 结构入口：[canvasClipboard.ts](../../apps/desktop/src/lib/canvasClipboard.ts) 的 `captureCanvasClipboard`、`parseCanvasClipboard`、`cloneCanvasClipboard`，由 `CanvasWorkspace` 调用；使用 `BOWERBIRD_CANVAS_V1` 协议并重映射节点／工作流身份、清除执行结果，不能拿来导入普通媒体或复制运行任务。
- 状态：文件导入 **可跨模块复用**；结构剪贴板 **模块内部专用**。两套对应文件与画板身份，不能合成一个“通用粘贴”函数。

## 避免中文输入法确认被当成提交

- 用途／关键词：IME、composition、Enter、重命名。
- 入口：[useImeGuard.ts](../../apps/desktop/src/lib/useImeGuard.ts) 的 `useImeGuard`；实际调用：[ProjectRenameDialog.tsx](../../apps/desktop/src/components/ProjectRenameDialog.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的标题编辑。
- 边界：同时接入 `onCompositionStart`、`onCompositionEnd`，按键检查 `isComposing(event.nativeEvent)`；按钮提交路径也应考虑 `composing.current`。这是原生文本输入防误提交，不替代 ProseMirror／Plate 自身的编辑事务与快捷键。
- 状态：**可跨模块复用**。

## 给图片标注和截图共用绘制、文字与撤销规则

- 用途／关键词：annotation、截图、箭头、折线、荧光笔、马赛克、模糊、橡皮擦、文字布局、描边滚轮、undo。
- 完整工具复用入口与两宿主边界见 [标注地图](ANNOTATION.md)。
- 入口：[annotation.ts](../../apps/desktop/src/lib/annotation.ts) 的 `DrawShape`、`drawShapeCanvas`／`drawShapes`、`applyTextEdit`；配合 [useAnnotationHistory.ts](../../apps/desktop/src/lib/useAnnotationHistory.ts) 的 `useAnnotationHistory`、[useAnnotationStrokeWheel.ts](../../apps/desktop/src/lib/useAnnotationStrokeWheel.ts) 的 `useAnnotationStrokeWheel` 及 [AnnotationTextEditor.tsx](../../apps/desktop/src/components/AnnotationTextEditor.tsx)。实际调用：[ImageAnnotator.tsx](../../apps/desktop/src/components/ImageAnnotator.tsx) 和 [ScreenshotWindow.tsx](../../apps/desktop/src/components/ScreenshotWindow.tsx)。
- 工具与预览：[AnnotationTools.tsx](../../apps/desktop/src/components/AnnotationTools.tsx) 统一十种工具、图标与提示；[useAnnotationDrawing.ts](../../apps/desktop/src/lib/useAnnotationDrawing.ts) 接收归一化落点及约束用像素尺寸，处理拖绘、Shift 约束、折线及取消，通过回调交付完整形状；[useAnnotationCanvas.ts](../../apps/desktop/src/lib/useAnnotationCanvas.ts) 接收原始底图与尺寸，统一全分辨率合成和临时预览。原图含透明像素时只合成一次；区域效果临时层替换已提交层，避免透明度叠加。新增工具须在公共类型、工具组及绘制核心维护，再核验两处调用。
- 边界：几何归一化、字号／粗细相对图片宽度，调用方提供显示尺寸与坐标；连续滚轮一组撤销，各编辑器保留自己的历史。图片还保存变换操作，截图保留捕获／像素选区／输出适配；不要把两者全部状态合并，或把 `DrawShape` 无验证地当成持久化 `AnnotationShape`。
- 状态：**可跨模块复用**；共享绘制／编辑核心，宿主操作仍模块专用。

## 复用带参考图和维度的创作输入

- 工作流生成卡的参考素材顺序由 [canvasWorkflow.ts](../../apps/desktop/src/lib/canvasWorkflow.ts) 中的 `orderedGenerationReferences` 统一到缩略图和生成请求。`reorderGenerationReferences` 为每条输入的当前成员记录顺位，画布仍通过原有编辑与撤销入口保存。[工作流说明](../CANVAS-WORKFLOW.md#2026-11-13生成卡参考图拖排桌面源码待发布)。

- 用途／关键词：prompt、ProseMirror、参考图、维度 chip、finalPrompt、草稿。
- 入口：[creation/useCreationEditor.ts](../../apps/desktop/src/components/creation/useCreationEditor.ts) 的 `useCreationEditor`／`CreationEditorDraft`；内部通过 [creation/serialize.ts](../../apps/desktop/src/components/creation/serialize.ts) 的 `serializeDoc` 得到 `finalPrompt`、`references`、`referenceNodeIds` 与维度来源。实际调用：[CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx) 和 [GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 的继续编辑框。
- 边界：虽位于业务目录，已是这两个创作入口共用内核；依赖 store、窗口事件和 ProseMirror schema。`draftKey: null` 禁用自身持久化，继续编辑框不能覆盖主创作草稿；全局点图／维度事件要求活动消费者互斥。新增宿主应优先沿现有创作组件接入，不能当无上下文的通用富文本 Hook 任意并挂。
- 状态：**可跨模块复用**（限同一创作协议）；不适合普通 Markdown 文档或独立聊天编辑器。

## 编辑 Markdown／TXT，并回填创作草稿

DOCX 及表格接入同一文档类型。`textDocuments.preview` 读取有界正文，`read` 对 DOCX 按需调用 [officeDocuments.ts](../../apps/desktop/src/lib/officeDocuments.ts) 的 Plate 编解码；`save` 按格式选择原件保存接口。表格由 [spreadsheetDocuments.ts](../../apps/desktop/src/lib/spreadsheetDocuments.ts) 读取并转换二维内容卡；[fileContentCards.ts](../../apps/desktop/src/lib/fileContentCards.ts) 的 `readFileContentCards` 是画板拖入／添加的共同转换入口，支持仅选定工作表。已核对 `TextFileMediaCard`、`TextDocumentEditor`、`AssetDetail`／`SpreadsheetDocumentViewer`、`CanvasWorkspace` 与 `materialActions`，不要把 DOCX ZIP 字节送进纯文本读取或把表格变成图片。能力边界见 [办公文档](../TEXT-LIBRARY.md#办公文档素材2026-11-09)。

- 用途／关键词：Plate、Slate、Markdown、源码、正文、文档媒体、放大编辑。
- 文档入口：[documentTypes.ts](../../apps/desktop/src/lib/documentTypes.ts) 的 `DocumentValue`／`TextWorkspaceDocument` 与 [documentCodec.ts](../../apps/desktop/src/lib/documentCodec.ts) 的 `parseMarkdown`／`serializeMarkdown`；实际调用：[TextDocumentEditor.tsx](../../apps/desktop/src/components/TextDocumentEditor.tsx)。[TextPlateEditor.tsx](../../apps/desktop/src/components/TextPlateEditor.tsx) 是正文编辑组件，不是生成请求序列化器。其 [TextInputRules.ts](../../apps/desktop/src/components/TextInputRules.ts) 通过 Plate core 规则启用 Markdown 快捷输入；[TextFormatToolbar.tsx](../../apps/desktop/src/components/TextFormatToolbar.tsx) 让固定／选区浮动栏共用格式按钮与公开变换，浮层沿 `usePortalTarget`。两者仅供 Plate 文档入口，不直接用于 ProseMirror 创作框。顶层段落侧栏由 `TextBlockShell` 接入 Plate aboveNodes；`textBlockTransforms.ts` 复用 getListChildren 处理父子列表整组变换，`TextBlockType` 复用公共 ContextMenu 与选区书签。
- 转换入口：[documentComposer.ts](../../apps/desktop/src/lib/documentComposer.ts) 的 `creationDraftToDocument`／`documentToPromptLoad`，由 [useTextWorkspace.tsx](../../apps/desktop/src/components/useTextWorkspace.tsx) 调用并校验源草稿。Plate `children` 与 ProseMirror `content` 是不同结构；保留原始语法块／媒体身份，通过显式转换回填，不能直接互传 JSON。文件保存另经 `TextDocumentEditor` 的版本／草稿保护，不以编辑器值直接覆盖原件。
- 文件正文：[textDocuments.ts](../../apps/desktop/src/lib/textDocuments.ts) 的 `textDocuments.read`／`save` 使用已登记素材身份及版本检查；`textDocumentMarkdown` 保留 Markdown，按需复用 `serializeMarkdown` 将 TXT 转为字面段落，实际由画板文本拖入调用，避免把 TXT 中的 Markdown／HTML 标记解释成格式。该转换创建画板正文副本，不建立源文件自动回写关系。
- 状态：编解码与转换 **可跨模块复用**；两种编辑模型按用途共存，不是已确认可合并的重复实现。文件约束见 [文本素材](../TEXT-LIBRARY.md)。

## 按实际参考素材选择视频模式并校验参数

- 用途／关键词：Seedance、自动识别、首尾帧、多参考、时长、比例、音频参考。
- 入口：[videoGeneration.ts](../../apps/desktop/src/lib/videoGeneration.ts) 的 `GenerationSettings`、`VideoOptions`、`resolveVideoOptions`、`videoInputError`、`videoRatio`；实际调用：[CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx)、[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 和 [CanvasWorkflowLayer.tsx](../../apps/desktop/src/components/CanvasWorkflowLayer.tsx) 解析本次引用。
- 边界：仅首尾帧为显式模式，其余按提交引用推导；不能把只是连接到工作流的素材全部当成引用。历史恢复保留冻结参数，不用当前自动识别重写；本机 H3 用自身固定工作流。前端校验不替代 Rust／服务端能力与权益校验。
- 状态：**可跨模块复用**；模型／模式契约见 [Seedance](../SEEDANCE-2.5-INTEGRATION.md) 与 [Cloud 视频](../VIDEO-API-INTEGRATION.md)。

## 把已登记图片／视频加入当前画板

- 用途／关键词：添加到画板、当前项目、中心落位、素材动作。
- 入口：[materialActions.ts](../../apps/desktop/src/lib/materialActions.ts) 的 `addMaterialAssets`；实际调用：[CategorizedLibrary.tsx](../../apps/desktop/src/components/CategorizedLibrary.tsx)、[ConnectedCollections.tsx](../../apps/desktop/src/components/ConnectedCollections.tsx) 与 [LocalFileWorkspace.tsx](../../apps/desktop/src/components/LocalFileWorkspace.tsx) 的添加动作。
- 边界：依赖全局活动项目、可见 `.canvas-stage`、关闭面板回调及已有 `prepareExplorerCanvasDrop`；无项目时由宿主提供建项目回调。拒绝音频／文本；创建文本卡走文档保存协议。不能用它向后台非活动项目静默投递，也不是可供后端复用的纯数据函数。
- 状态：**可跨模块复用**（限当前桌面画板投递场景）。

## 展示失败原因，并取回原 Cloud 视频

- 用途／关键词：错误、中文提示、notify、恢复、原任务、recover、诊断。
- 展示入口：[userError.ts](../../apps/desktop/src/lib/userError.ts) 的 `userErrorMessage`／`generationErrorMessage`，通知用 [notify.ts](../../apps/desktop/src/lib/notify.ts) 的 `notifyError(error, fallback)`。实际调用：[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 用 `generationErrorMessage(turn.error, { provider })` 显示轮次错误，用 `notifyError` 显示取回失败。
- 恢复入口：[api.ts](../../apps/desktop/src/lib/api.ts) 的 `api.recoverCloudVideo(jobId)`；同一面板的取回按钮按 provider 分流到该方法或 `api.jimengRetrieveOrphan`，成功后 `loadGenJobs`。保持原 job，不能改成 `startGeneration`；只有当前可操作任务才能恢复，历史只读轮次不能操作后续任务。错误转换仅在展示边界执行，不覆盖原始诊断、持久化错误或业务判断。
- 状态：错误展示 **可跨模块复用**；视频恢复是 **可跨模块复用** 的专用接口，限 Cloud 视频原任务，不能当通用重试。错误契约见 [用户错误提示](../USER-FACING-ERRORS.md)，恢复协议见 [Cloud 视频](../VIDEO-API-INTEGRATION.md)。

覆盖到的重复候选、未检查部分与模拟导航验收统一见 [核验记录](REVIEW.md)。未收录的 `lib`／业务 helper 仍需跨板块检索；导出并不自动意味着允许跨模块使用。

- 内容卡行列尺寸：`canvasNotes.ts` 的 `canvasGridWeights` 供 `CanvasTextCard` 布局和 `readCanvasNote` 草稿读取共用；维数不匹配、非有限值或非正值沿既有等分回退，避免显示修复后仍把非法尺寸再次提交。拖动约束须同时考虑相邻两格的可分配范围；53 行／列保存与恢复见 `canvas-large-grid-resize-ui.test.mjs`。
- 文档卡的展示、框选和连线端点共用 `canvasDocumentHeight(width)`。卡片保持 3:4 比例，接近视口时通过 `requestDocumentReading(source, "card")` 在共用 Worker 中生成可滚动全文；素材目录使用同一队列的 `"excerpt"` 模式。
- 可移植 Markdown 和 Agent 文本调用 `serializeReadableMarkdown`；需要完整恢复的编辑器保存调用 `serializeMarkdown`，由 `parseMarkdown` 校验并恢复。外部富文本粘贴通过 `documentPasteData` 处理统一的网页默认字体，内部 Slate 复制沿原有剪贴板格式传递。
- 工作流读取文档时，`canvasSessionOutputs.ts` 的 `canvasWorkflowInputState` 检查端口，`canvasInputAssetIds` 返回有序素材 ID，`canvasInputValue` 提供实际执行需要的完整文本与引用。画板文档编辑沿用 `TextDocumentAutosave`，`stage` 暂存最新编辑，`capture` 和 `flush` 分别用于同步读取和等待保存。

## 视频采集与复刻原件添加画板

- CanvasWorkspace 的 addCollectedVideo 复用画板快照、避让落点、串行写入及失败恢复；独立采集事件与复刻 onAddVideo 共用。属于画板宿主内部实现，不跨模块直接导入。复刻先经 media 校验原件，再用 api.importFiles 的 collect 模式转存，避免画板仅依赖复刻任务副本。
