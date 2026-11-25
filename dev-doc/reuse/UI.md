# UI、布局与交互复用

[返回复用地图](../Bowerbird开发计划.md#复用地图)。本页按 2026-11-03 当前工作区源码核对，包含未提交实现；状态表示可用边界，不表示已发版。视觉规则和样式加载顺序仍以 [UI-DESIGN-SPEC 第 11 节](../UI-DESIGN-SPEC.md#11-实现入口与使用顺序) 为入口，不在这里复制色值与动效规范。

## 拖放采集落点

- **入口：** [ExploreWorkspace.tsx](../../apps/desktop/src/components/ExploreWorkspace.tsx) 和 [FileDropImport.tsx](../../apps/desktop/src/components/FileDropImport.tsx) 共用 [captureDropTarget.ts](../../apps/desktop/src/lib/captureDropTarget.ts) 与 [CaptureDropFeedback.tsx](../../apps/desktop/src/components/CaptureDropFeedback.tsx)。预览和松手均按实际命中的目录行或瀑布流分组解析。文件夹使用 `data-file-import-collection-id`，标签使用 `data-tag-id`／`data-tag-section`。同一分栏内对应的行与分组同步描边，已离线文件夹在入库前拦截。
- **交付：** 文件夹复用 `folderConnections.references`，标签复用 [localClassification.ts](../../apps/desktop/src/lib/localClassification.ts) 的全局／项目 `example` 人工归属接口。
- **边界：** 两条入口均在松手时冻结项目和落点。探索采集明确投放到标签时传 `skipClassification`，沿现有采集队列重试；`ingest_from_bytes_with_classification` 控制单次自动入队。未分类分组继续原流程。探索分类契约见 [探索浏览器](../EMBEDDED-BROWSER.md#2026-11-04标签落点直接归类源码待发布)。

## 让新界面沿用主题、按钮和字段

- 需要在报价旁显示 Bcoin 单位时，复用 [BcoinAmount](../../apps/desktop/src/components/BcoinAmount.tsx) 的本地化数字、顶栏同款图标和可读单位。该组件仅负责呈现，使用调用方已查得的有效金额。

图片右键「维度」由 `AssetContextMenu` 的单图菜单提供，素材库与画板共用；复用 store `openCaptionRing` 按需加载维度及全局 `CaptionRing`。画板通过既有 `bowerbird://board-asset-peek` 传入节点元素作为锚点，避免同一素材多处出现时定位到素材栏；多选不提供此操作。素材缩略图和画板图片共用 DimensionBadge，单击左上角标签即可开环。生成卡缩略图的 × 只断开图片；右键输入加号可按维度名称单独断开正文，兼容既有共线记录。激活创作框后点标签插入；浏览画板时拖动标签复用工作流自动连接，按目标端口保存所选维度正文快照和来源图片。

工作流模板预览与首次运行前的 Agent 详情共用 `workflowPromptPreview` 将提示词内的引用标记显示为对应名称。[工作流提示词](../../apps/desktop/src/lib/canvasWorkflow.ts)

画板和工作流卡片共用 [JobProgressText](../../apps/desktop/src/components/JobProgressText.tsx)。进度文字按任务 ID 单独订阅。卡片宿主根据会话身份、运行状态和已交付结果更新布局。

画板视频卡的提示词框复用 `fitContent`。H3 使用 [CanvasTextarea](../../apps/desktop/src/components/CanvasTextarea.tsx)，初始高度为 64px。即梦和 Cloud 使用 [WorkflowPromptEditor](../../apps/desktop/src/components/WorkflowPromptEditor.tsx)，初始高度为四行。输入区随正文增减，在高度上限内使用共用悬浮滚动条。

手动组图复用 [GenerationGroupMenuItem.tsx](../../apps/desktop/src/components/GenerationGroupMenuItem.tsx) 的 `MergeGenerationGroupMenuItem`（图片多选）和 `GenerationGroupMenuItem`（解散）。调用为 `AssetContextMenu` 与 `CanvasWorkspace`，显示继续共用 `GenerationGroupControls`／`CanvasConversationImages`。普通图片创作框的「并入上个生成」是显式选择，不复用模型会话作为展示别名；实现见 [显式合组](../CANVAS-WORKFLOW.md#2026-11-11显式抽卡与手动合组源码待发布)。

视频模型／分辨率／时长复用 `VideoControls` 与 `videoGeneration.ts` 的 `videoResolutions`／`videoDurationRange`，建卡和切模式直接使用已确认配置；不要重新引入 `dreaminaVideoModels` 或 CLI 帮助读取作为 UI 前置条件。该控制组件供创作框及工作流共用，保留本机登录／权益及 Cloud 门控。[背景与巡检](../SEEDANCE-2.5-INTEGRATION.md#2026-11-10建卡免核验与后台每日规格巡检)。

角色声音使用 `CanvasWorkflowLayer` 的工作流卡片、输入输出连线与复制／移动交互。`VoiceCard` 复用 TacticalSelect、AudioWaveform、VoiceReferenceTrim 和项目音频检索；`VoiceEnvironmentControl` 沿用 H3 标题栏环境状态点和公共弹窗。`VoiceReferenceTrim` 与视频共享 MediaTrimTimeline 的双端手柄、时间输入与键盘细调。见 [声音卡片](../VOICE-STUDIO.md)。

强化分析输出复用 `CanvasTextCard` 与 `canvasNotes` 的图片／文字单元格，每镜头一行、图片与分析两列；`replicationAnalysisNote` 仅负责业务数据适配。`VideoPlayer.seekRequest` 是可选的外部时间定位请求，强化分析点击镜头时暂停并定位原片；旧调用方不传时保持原行为。

视频控件改版已于 2026-11-10 确认接入 `VideoPlayer.tsx/.css`，各原入口共用；`VideoTrimTimeline` 负责胶片裁剪，`videoFineScrub` 共用于时间轴和端点长按细调。倍速复用 `TacticalSelect`，新增可选 `portalContainer` 仅供全屏挂载，其他调用默认 body 保持；Lightbox 对打开菜单的 Esc 让路。复刻工作台取消比例限宽。原[确认预览](../../apps/desktop/scripts/fixtures/video-redesign/README.md) 留存，正式宿主验证使用 `scripts/fixtures/video-player-live`，不加载设计稿覆盖 CSS。[验证](../../project_logs/2026-11-10-video-controls.md)。

Cloud 文本 Skill 只传标识与参数：`h3PromptOptimization.h3OptimizationInstruction` 生成 H3 选择信封，`textAgent.startTextAgent` 的 Cloud 分支生成 text-editor 信封；原文通过 `startCloudTextRewrite` 的 source 提交。VPS 统一复用 `apps/agent-worker/src/skills/cloud-text-skills.ts` 加载只读方法并冻结到既有 processor 的 checkpoint；禁止界面另行 raw-import Skill。普通用户要求及本机 Codex 方法不受影响。H3 卡片的续聊通过既有 `LocalChatPanel` 展示原文和结果，继续发送沿用普通 DSH · Cloud 对话的原生会话读取机制。[服务端维护契约](../UNIFIED-AGENT-HARNESS-PLAN.md#2026-11-08cloud-dsh-skill-的服务端归属)。

H3 图片卡和视频卡在原文框下复用 `H3OptimizationActions` 和 `H3PromptPreview`，负责手动优化、稿件编辑、历史恢复和续聊入口。优化按钮复用 `H3OptimizeButton`，积分说明可在悬停时查看。两类卡片通过 `AppSettings.h3_auto_optimize_prompt` 共享全局 AUTO，开启后由同一工作流先取回优化后提示词，再提交生成。底部创作框继续通过 `composerLocalVideo` 调用文本改写。视频优化保留官方结构化字段和旧版纯正文。[卡片工具条](../../apps/desktop/src/components/creation/H3OptimizationActions.tsx) · [优化后提示词编辑](../../apps/desktop/src/components/creation/H3PromptPreview.tsx) · [底部创作框](../../apps/desktop/src/lib/composerLocalVideo.ts) · [文本改写](../../apps/desktop/src/lib/textAgent.ts) · [H3 卡片](../COMFYUI-LOCAL-VIDEO.md)

- **用途／关键词：** 深浅色、tokens、工程蓝、button、input、Tailwind。
- **入口：** [styles.css](../../apps/desktop/src/styles.css) 的 `--bb-*`、`.app-button-primary`／`.app-button-secondary`、`.app-modal-button`；[IndustrialTheme.css](../../apps/desktop/src/components/IndustrialTheme.css) 覆盖当前色板与状态；[tailwind.config.js](../../apps/desktop/tailwind.config.js) 把 `canvas`／`panel`／`ink`／`muted` 映射到变量。主题切换走 [theme.ts](../../apps/desktop/src/lib/theme.ts) 的 `applyTheme`／`loadCachedTheme`。
- **实用证据：** [main.tsx](../../apps/desktop/src/main.tsx) 加载基础 CSS 并应用缓存主题，[App.tsx](../../apps/desktop/src/App.tsx) 在既有 Tactical 样式之后加载三个 Industrial 文件；[ConfirmDialog.tsx](../../apps/desktop/src/components/ConfirmDialog.tsx) 使用 `.app-modal-button`。
- **范围／状态：可跨模块复用。** 这是桌面 CSS 接口，并非独立 React Button/Input 组件库。复用语义变量和合适的控件类；画布 HUD 阴影、菜单规则分别由 `IndustrialCanvas.css`、`IndustrialMenus.css` 负责，不能把全局按钮类套到所有卡片。独立截图窗口不经过主 App 同一入口，不能假定主题覆盖相同。

## 新建模态表单或二次确认

- **用途／关键词：** dialog、确认、焦点循环、Esc、忙碌锁定、固定动作栏。
- **入口：** [ModalShell.tsx](../../apps/desktop/src/components/ModalShell.tsx) 的 `ModalShell`；简单确认用 [ConfirmDialog.tsx](../../apps/desktop/src/components/ConfirmDialog.tsx) 的 `ConfirmDialog`。布局和状态样式沿用现有 `.app-modal-*`。
- **实用证据：** [SettingsDialog.tsx](../../apps/desktop/src/components/SettingsDialog.tsx) 用于设置长表单；[CollectionDialogs.tsx](../../apps/desktop/src/components/CollectionDialogs.tsx) 用 `preventClose={busy}`；[ProjectDeleteDialog.tsx](../../apps/desktop/src/components/ProjectDeleteDialog.tsx) 组合复杂删除内容；[BatchBar.tsx](../../apps/desktop/src/components/BatchBar.tsx) 调用 `ConfirmDialog`。
- 顶栏、侧栏和提供方提示通过 `settingsRequest` 跳转，由 [AccountOnboarding](../../apps/desktop/src/components/AccountOnboarding.tsx) 承载同一个设置面板。[SettingsToggle](../../apps/desktop/src/components/SettingsToggle.tsx) 提供带可访问名称的布尔开关，[SubscriptionCard](../../apps/desktop/src/components/SubscriptionCard.tsx) 提供自有订阅的账号状态和重新检测入口。顶栏 [ScreenshotMenu](../../apps/desktop/src/components/ScreenshotMenu.tsx) 复用 `ContextMenu` 展示截图动作，快捷键与自动入库仍由设置面板编辑。
- **范围／状态：可跨模块复用。** 宿主控制挂载与 `onClose`，Shell 管遮罩、首焦点、Tab 和关闭后焦点恢复。字段可标 `data-modal-autofocus`。Tab 在实际可用的控件间回绕，跳过隐藏分区、`inert` 区域和未展开的详情内容。`ConfirmDialog.confirmDisabled` 只禁用确认按钮，不锁住取消／Esc；异步忙碌需要关闭锁时用 `ModalShell.preventClose`。全页项目管理和图片／会话预览不强套模态表单壳。
- 设置页和旧侧栏共用 [AccountLogoutConfirmation](../../apps/desktop/src/components/AccountLogoutConfirmation.tsx)，确认时核对打开弹窗时的账号身份。

## 添加普通单选下拉

单素材详情使用 [AssetTagPicker.tsx](../../apps/desktop/src/components/AssetTagPicker.tsx)，接素材 ID、当前 `AssetTag[]` 与刷新回调，宿主按素材 ID 设置 key。多选工具栏和素材右键共用同文件的 `BatchAssetTagDialog`，接收冻结的素材 ID 列表。两者共用标签名称查找、按需创建、`localClassification.labels/save/example` 和 `OverlayScrollArea`。批量写入按 100 项分批，失败后在弹窗内重试会沿用同一标签和已提交进度。字母归组与比较统一来自 [materialCatalogOrder.ts](../../apps/desktop/src/lib/materialCatalogOrder.ts) 的 `catalogInitial/compareTagNames`。

- **用途／关键词：** select、listbox、选项组、方向键、输入定位、禁用。
- **入口：** [TacticalSelect.tsx](../../apps/desktop/src/components/TacticalSelect.tsx) 的 `TacticalSelect`／`TacticalSelectProps`；传 `<option>`／`<optgroup>`，接 `onValueChange`，值统一为字符串。解析、方向导航与定位由同目录 [tacticalSelectLogic.ts](../../apps/desktop/src/components/tacticalSelectLogic.ts) 提供，消费者优先用组件。
- **实用证据：** [LibraryComposer.tsx](../../apps/desktop/src/components/LibraryComposer.tsx) 的项目选择；[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 的详情选择；[CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的画板选择；[CanvasWorkflowLayer.tsx](../../apps/desktop/src/components/CanvasWorkflowLayer.tsx) 的触发器四模式菜单。
- **范围／状态：可跨模块复用。** 普通单选与键盘交互；菜单视觉由 `IndustrialMenus.css` 最终覆盖。它是按钮 + listbox，非原生 `<select>`，有 `name` 才输出隐藏表单值；不承担动作子菜单、模型计费信息或任意富内容选择。当前弹层直接挂 `document.body`，局部焦点边界见下文。

## 添加右键菜单与动作子菜单

素材库与画布同步维护素材右键操作。`AssetTransferMenuItems` 统一提供项目移动、文件夹移动及导出子菜单；普通素材按素材 ID 操作，文件夹宿主传入条目移动回调。画布节点与空白处选区使用相同组件，菜单关闭后的目标选择弹窗由宿主保留。

`AssetContextMenu` 统一提供图片「编辑」；[CanvasSelectionMenuItems.tsx](../../apps/desktop/src/components/CanvasSelectionMenuItems.tsx) 为素材及画布节点菜单共用调整层级、整理和添加图片到对话框的选项，画布提供节点范围和可引用图片数量。空白处的选区子菜单通过 `ContextSubmenu` 保留嵌套导出和删除；键盘逐层返回。

声明式菜单以项目菜单试点。[contextMenuModel.ts](../../apps/desktop/src/lib/contextMenuModel.ts) 定义数据，[projectMenu.ts](../../apps/desktop/src/lib/projectMenu.ts) 计算项目选项，[ContextMenuItems.tsx](../../apps/desktop/src/components/ContextMenuItems.tsx) 使用公共菜单壳渲染；命令与弹窗生命周期由宿主负责。公共菜单与 Plate 段落菜单共用 [contextMenuOwnership.ts](../../apps/desktop/src/lib/contextMenuOwnership.ts) 交接焦点，原生文本菜单通过同一广播让应用菜单退出。

画布空白和卡片菜单使用 [canvasContextMenu.ts](../../apps/desktop/src/lib/canvasContextMenu.ts) 生成选项，[CanvasContextMenu.tsx](../../apps/desktop/src/components/CanvasContextMenu.tsx) 渲染并通过插槽复用素材操作、组图、层级及分区色块。画布在右键时冻结命中的对象与选区快照，一次收集素材和可引用图片。

素材菜单的单选双列、多选和残缺选区由 [assetContextMenu.ts](../../apps/desktop/src/lib/assetContextMenu.ts) 生成，继续复用声明式渲染器和素材操作插槽。[useAssetMenuHost.ts](../../apps/desktop/src/components/useAssetMenuHost.ts) 处理全局与嵌入式宿主的选择和导航，[assetMenuCommands.ts](../../apps/desktop/src/lib/assetMenuCommands.ts) 执行文件、素材归属及生成相关命令。需要变更素材菜单时由这三个入口核对规则与动作，勿另建宿主专用菜单。

单条视频的「转录文稿」由共用 [AssetContextMenu.tsx](../../apps/desktop/src/components/AssetContextMenu.tsx) 打开 [LibraryVideoPreview.tsx](../../apps/desktop/src/components/LibraryVideoPreview.tsx) 的文稿工作区。用户打开视频预览即可看到当前报价，点击带报价的按钮后才核对原件并提交。

视频浏览由共用预览承载，`AssetDetail` 的嵌入模式提供属性和「视频分析」入口。预览把素材及来源版本传给 [VideoTranscriptPanel.tsx](../../apps/desktop/src/components/VideoTranscriptPanel.tsx)，复用已读报价和任务状态。[VideoTranscriptReader.tsx](../../apps/desktop/src/components/VideoTranscriptReader.tsx) 使用共用滚动条和可见段渲染，负责文稿全文搜索、复制和原生字词时间跳转。

[openCatalogMenu.ts](../../apps/desktop/src/lib/openCatalogMenu.ts) 复用虚拟视图已加载的素材或目录条目。只有缺项才读取索引，后一次菜单请求、离开工作区或 Esc 可取消迟到结果。连接目录按条目 ID 解析，分类素材按 Asset ID 解析。[CanvasLayerMenuItem.tsx](../../apps/desktop/src/components/CanvasLayerMenuItem.tsx) 的显式单步操作与原按住滑动及键盘操作共享画布层级命令。

视频导出使用 `VideoExportMenu`，复用 `ContextMenu` 的动作语义和焦点。通过 `anchor` 跟随按钮，底部空间不足时向上展开。浮层挂在预览对话框内、动画容器外，全屏时挂在播放器内。画板音轨卡及展开素材组直接复用 `AudioWaveform`。

- **素材业务菜单：** `CategorizedLibrary`、`ConnectedCollections` 与嵌入工作区共用 `AssetContextMenu`；文件夹通过 `fileSelection.entries` 提供条目数量和改名／移动／移出分身回调，不能按 Asset ID 代替目录条目 ID。普通素材操作不另写一套菜单；目录树自身仍使用 `ContextMenu` 的文件夹操作。

2026-11-06：公共 `ContextMenu` 的首焦点与方向键导航同时覆盖普通菜单项、单选菜单项和多选菜单项（`menuitem`／`menuitemradio`／`menuitemcheckbox`）；文本编辑器的 `TextSegmentMenu` 使用此入口并保存块身份；正文／标题类型切换已由完整 Plate EditorKit 接管。

- **用途／关键词：** context menu、右键、操作、删除子菜单、焦点恢复。
- **入口：** [ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 的 `ContextMenu`、`ContextSubmenu`、`DeleteSubmenu`。宿主提供指针坐标或触发按钮 `anchor`，以及关闭回调、`button[role="menuitem"]` 与禁用状态。锚定模式要求浮层使用视口坐标，焦点移动只滚动菜单内部。筛选代价高的子菜单可把 children 写为函数，展开时才计算条目，画板「连接已有卡片」使用此方式。
- **实用证据：** [AssetContextMenu.tsx](../../apps/desktop/src/components/AssetContextMenu.tsx) 使用子菜单和删除分组；[ProjectContextMenu.tsx](../../apps/desktop/src/components/ProjectContextMenu.tsx) 使用同一菜单壳。
- **范围／状态：可跨模块复用。** 共用边缘定位、菜单家族互斥、键盘／外部点击关闭和滚动包装；`ContextSubmenu` 必须位于该菜单 Context 内。`AssetContextMenu`／`ProjectContextMenu` 自身绑定素材、项目和 store 行为，是领域入口，不作其他业务的通用菜单模板。

### 保留文本右键编辑菜单

- **入口：** [textContextMenu.ts](../../apps/desktop/src/lib/textContextMenu.ts) 的 `installTextContextMenu` 在 `main.tsx`／`screenshot-main.tsx` 的 React 挂载前注册，返回卸载函数供热更新清理；覆盖主树、弹窗 portal 和截图标注，不要求每个文本框逐项接线。
- **边界：** 文本类 input、textarea、实际可编辑的嵌套元素及命中选区矩形的阅读文字，捕获阶段只阻断自定义菜单处理，不取消浏览器默认行为，复制等编辑能力继续由系统 WebView 提供。非文本控件、卡片空白和其他位置的选区不拦截；不主动复制密码，也不重写编辑器剪贴板或撤销协议。
- **验证：** `text-context-menu-ui.test.mjs` 先在正式画板复现旧菜单拦截，再验证画板、普通／只读／搜索／多行、嵌套富文本、结果文字、ProseMirror、Plate 与截图文本；检查菜单默认行为、复制事件与选区、卡片／媒体菜单、键盘及清理。复制测试拦截写入，不覆盖用户剪贴板。原文字选择和画板焦点回归、TypeScript 与独立 Vite 构建通过；浏览器验证不代替 Windows／Mac 原生菜单逐项实测，未更新安装包。

### 编辑完整富文本文档

- **入口：** [TextPlateEditor.tsx](../../apps/desktop/src/components/TextPlateEditor.tsx) 与 [EditorKit](../../apps/desktop/src/components/text-editor/plate/components/editor/editor-kit.tsx)。宿主传入文档值、素材、变更回调及拖入解析；实例公开插入素材、Markdown 和预留光标插入接口。
- **调用方：** 放大工作区 `TextWorkspace`、原文件详情 `TextDocumentEditor`。两者共用块编辑、工具栏、媒体与文档内讨论；布局和保存归属由宿主控制。放大工作区的 `RecentTextDocuments` 复用 Plate dropdown 和工作区 portal 展示本机最近文档，`TextAutosaveStatus` 显示真实保存状态。
- **本机最近与恢复：**`recentTextDocuments.ts` 统一 IndexedDB 文档身份、来源指纹、最近列表和事务 revision；`textDocumentAutosave.ts` 负责串行保存、输入合并和退出冲刷；`useRecentTextDocument` 接入放大编辑器。宿主通过 `origin` 与 `isSourceDocument` 保留生成草稿／画板卡片边界，不将最近文档直接写入当前卡片。
- **服务：** `TextEditorServices` 让两个宿主的工具栏和段落气泡复用 `EditorAgentModel`、同一模型选项和每篇文档的 `TextAgentTask`。本机 Codex 和 Cloud DSH 的增量展示为回复预览，终态沿原选区或段落校验后才进入正文。媒体复用导入服务，附件走本机受控命令，文档导出独立懒加载。评论、修订、提及仅本机，完整状态经 `documentState.ts` 保存。
- **边界：** 与桌面 store、Tauri API、应用 portal 和主题相关，不是独立跨运行时 UI 包。不要直接跨模块调用某个上游 kit 内部实现；新增文档入口优先复用 `TextPlateEditor`。来源、样式生成、格式边界及验收见 [Plate 适配说明](../../apps/desktop/src/components/text-editor/plate/README.md) 与 [文本专项](../TEXT-LIBRARY.md)。

## 给画布卡片添加统一连接加号

- **用途／关键词：** 端口、加号、输入输出、磁吸、整卡接收、自动连接、热区。
- **单元格宿主：** `CanvasTextCard` 复用同一控件及手势，`CanvasTextCard.css` 仅覆盖单元格的 28×32 画布像素热区与悬停显隐；`CanvasWorkflowLayer` 以 `scope` 复用自动连接、菜单和 `useWorkflowPortGeometry` 的单元格边界。格内图片复用 `useCreationImageInteraction` 和 `AssetContextMenu`，引用不携带父表格实例身份；菜单传单素材集合和局部移除回调，避免删除父卡。
- **入口：** [CanvasConnectionHandle.tsx](../../apps/desktop/src/components/CanvasConnectionHandle.tsx) 的 `CanvasConnectionHandle`／`CanvasConnectionHandleProps` 兼容原生 button 属性，提供 `side: "input" | "output"`、`active` 及转发 ref；宿主提供事件回调。卡片或热区悬浮／选中／键盘显隐、禁用命中关闭、同比缩放的 92.16px 热区与 25.2px 标记（100% 基准）、紧凑方框与斜纹加号造型、视觉磁吸、重叠热区就近选择及减少动态效果均由组件与同名 CSS 共用，尺寸与动效见 [端口规范](../UI-DESIGN-SPEC.md#8-输入输出端口)。
- **实用证据：** [CanvasWorkflowLayer.tsx](../../apps/desktop/src/components/CanvasWorkflowLayer.tsx) 用于工作流／素材数据连接，[CanvasTextCard.tsx](../../apps/desktop/src/components/CanvasTextCard.tsx) 与 [CanvasDocumentCard.tsx](../../apps/desktop/src/components/CanvasDocumentCard.tsx) 用于原生卡片。控件随画布容器的 transform 缩放，容器在草稿期间提供 `data-canvas-connecting`，发起卡片的 `data-canvas-connection-source` 保留对应一侧入口，按钮输出 `data-canvas-connect-side`；键盘激活由宿主按按钮中心打开连接菜单。
- **范围／状态：画布领域共用。** 组件只管理命中与可见反馈，不提交连接或解释媒体类型。交互状态统一归 `CanvasWorkflowLayer`（轻点菜单、180ms 长按或超过 5px 拖动牵线、发起标记隐藏、整卡命中、空白菜单、右键取消），类型交集归 [workflowAutoConnect.ts](../../apps/desktop/src/lib/workflowAutoConnect.ts) 的 `planAutomaticConnection`，持久化归 [canvasWorkflowRuntime.ts](../../apps/desktop/src/lib/canvasWorkflowRuntime.ts) 的 `connectAutomatic`／`disconnectAutomatic`；消费者不复制手势层或直接写入多条 typed 绑定。菜单复用 `ContextMenu`／`ContextSubmenu`，旧精确端口位置仍由 [useWorkflowPortGeometry.ts](../../apps/desktop/src/lib/useWorkflowPortGeometry.ts) 缓存。
- **显示边界：** `CanvasWorkspace` 以既有 `liveGraphNodes` 提供 `visibleGraphNodeIds`，供 `CanvasWorkflowLayer` 限定名称和会话热区；完整 `graphNodes` 仍供历史引用解析。新增覆盖层应沿同一可见投影，避免 Agent 收纳／归档节点留下空热区；`canvas-overlay-visibility-ui.test.mjs` 覆盖隐藏与恢复。
- **验证：** `canvas-connection-handle-ui.test.mjs` 验证不同缩放下的实际尺寸、磁吸／取消、编辑与键盘及重叠命中；`canvas-auto-connect-ui.test.mjs` 验证实际交互层。运行、原子保存与兼容边界见 [工作流协议](../CANVAS-WORKFLOW.md#2026-11-04统一加号与自动内容连接源码未发布)。

## 选择对话模型与推理强度

- Agent 卡片的 `AgentChatControls` 组合现有 `ChatProviderSelect` 与 `CodexModelSelect`。流式回复、详情、续聊和恢复共用 `LocalChatPanel`，旧任务通过 `WorkflowAgentDetail` 查看结果。卡面只提供运行状态和详情入口，内容输出和直接建卡复用现有交付逻辑。卡片绑定 chatConversationId，复制时清除，模板 v6 只保留 provider／模型配置。

- 对话 provider 集合与标签统一由 `lib/chatProvider.ts` 提供。创作框和 Agent 卡片复用 `ChatProviderSelect`，按共享状态切换。模型设置的 `DshSubscriptionCard` 统一提供本机 DSH 的安装授权、状态复核和手动服务地址，分别调用 `localChat.dshAccount` 和 `localChat.dshStatus/dshSetup`。
- DSH 接入沿 `local_chat.rs` 分派，历史与建卡复用 SQLite 和 `local_chat_cards::create_cards`。本机桥复用 `agent_ds::dsh_connection/dsh_client`；新版 Cloud 桥由 `local_chat_dsh_vps.rs` 按原任务身份收发。卡片、创作框与详情复用 [DshSkillSelect](../../apps/desktop/src/components/creation/DshSkillSelect.tsx)，仅传技能 ID 与用户参数。详见[对话 provider](../CHAT-PROVIDERS.md)。
- Codex CLI 和本机 DSH 共用 [AgentCardQuestion](../../apps/desktop/src/components/AgentCardQuestion.tsx)。提问与工作流卡片的右上关闭按钮共用 `canvas-tactical-card-close` 样式。待答快照与回答分别使用 `localChat.questions` 和 `localChat.answerQuestion`，桌面根据 provider 将答案交给原生会话。
- Agent 卡片的回复操作在 [AgentCardConversation](../../apps/desktop/src/components/AgentCardConversation.tsx)。复制与详情共用 `useCopyChatReply`，重跑沿用画布的单卡运行入口。
- 本机／Cloud 来源使用 `creation/ChatProviderSelect.tsx`，模型和推理参数使用 `creation/CodexModelSelect.tsx`，由 Agent 卡片、`CreationBoard` 和 `LocalChatPanel` 共用。Agent 卡片启用选择器的紧凑图标显示。能力快照由 [chatCapabilities.ts](../../apps/desktop/src/lib/chatCapabilities.ts) 在主窗口启动时读取。Cloud 报价按登录账号隔离，本机 Codex 安装／登录变化后重读目录，DSH 设置结果同步到所有选择器。发送仍由原生执行路径验证。
- 型号及支持的推理强度来自 `localChat.models()` 的本机 CLI 能力目录。只用于桌面对话，不把图片生成 provider 当成 Codex 子模型；Cloud 隐藏且不发送这些参数。
- 参数属于下一轮消息，未发送选择随草稿保留，已发送选择从会话恢复。更换型号时重新核对该型号支持的强度，过期选项不静默替换。

## 选择生成模型或图片比例

- 卡片、创作框和会话续轮使用 [generationProviderIssue](../../apps/desktop/src/lib/generationAvailability.ts) 检查本次实际提交的图片或视频 provider。[ProviderIssueNotice](../../apps/desktop/src/components/creation/ProviderIssueNotice.tsx) 展示原因，并按返回的设置目标打开对应的自有订阅授权卡或账号页。工作流各卡片的渠道映射在 [workflowProviderIssue.ts](../../apps/desktop/src/lib/workflowProviderIssue.ts)。
- 有自有订阅权益的用户可选中尚未配置的 GPT Image 2，卡片和创作框显示原因及「配置自有订阅」，直达「模型设置 → ChatGPT」。配置就绪前禁用生成和设为默认。
- **用途／关键词：** provider、模型、比例、ratio、默认模型、Bcoin。
- **入口：** [creation/ProviderSelect.tsx](../../apps/desktop/src/components/creation/ProviderSelect.tsx) 的 `ProviderSelect` 负责图片 provider 选择；其内部用 [ModelSelect.tsx](../../apps/desktop/src/components/creation/ModelSelect.tsx) 的 `ModelSelect`。比例图形菜单用 [RatioSelect.tsx](../../apps/desktop/src/components/creation/RatioSelect.tsx) 的 `RatioSelect`。
- **实用证据：** [CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx) 调用 `ProviderSelect` 与 `RatioSelect`；`ProviderSelect` 生成 `ModelOption[]` 后调用 `ModelSelect`。
- **范围／状态：模块内部专用（创作／生成领域）。** `ProviderSelect` 依赖账号权益、引擎健康、store 和设置 API；`ModelSelect` 共用来源分栏、模型收藏和二级菜单。Bcoin 图片模型中的 Seedream 版本归入同名子菜单。比例菜单表示 `string | null` 的自动／固定比例，模型面板提供来源、禁用原因及默认项；不能仅因都是下拉就直接换成 `TacticalSelect`，也不推荐非生成板块导入这些业务选择器。

## 把弹层留在嵌入工作区的焦点边界内

- **用途／关键词：** portal、嵌套弹窗、浮层宿主、stacking、focus。
- **入口：** [portalTarget.tsx](../../apps/desktop/src/lib/portalTarget.tsx) 的 `PortalTargetContext`／`usePortalTarget`；无 Provider 时回退 `document.body`。
- **实用证据：** [TextWorkspace.tsx](../../apps/desktop/src/components/TextWorkspace.tsx) 以编辑面板 DOM 提供 Context；[ModalShell.tsx](../../apps/desktop/src/components/ModalShell.tsx) 与 [ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 调用 `usePortalTarget()` 再创建 portal。
- **范围／状态：可跨模块复用。** 只选择挂载目标，不替代焦点管理和坐标系统。2026-11-06 复核：`ModelSelect` 已使用 `usePortalTarget`；`TacticalSelect`、`RatioSelect` 仍直接挂 body，**不能把 Context 当成所有弹层都已接入的保证**；在局部工作区接入菜单时要核实实际消费者及键盘行为。

## 添加不占内容宽高的滚动区域

- **用途／关键词：** scrollbar、悬浮滚动条、横向滚动、虚拟列表、scrollRef。
- **入口：** [OverlayScrollbars.tsx](../../apps/desktop/src/components/OverlayScrollbars.tsx) 的 `OverlayScrollbars`／`enableOverlayScrollbars` 是 React 接入层，DOM 管理器唯一实现为 [overlayScrollbars.js](../../apps/desktop/src/lib/overlayScrollbars.js)；需要现成 viewport／content 结构时用 [CollectionScrollArea.tsx](../../apps/desktop/src/components/CollectionScrollArea.tsx) 的 `OverlayScrollArea`，集合特化包装为 `CollectionScrollArea`。
- **实用证据：** [main.tsx](../../apps/desktop/src/main.tsx) 挂载全局 `OverlayScrollbars`；[ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 和 [CanvasDocumentCard.tsx](../../apps/desktop/src/components/CanvasDocumentCard.tsx) 使用 `OverlayScrollArea`。
- **范围／状态：可跨模块复用。** 根入口与包装器引用计数共享 manager，普通滚动元素在主应用中无需每处另挂管理器；独立包装器会自行启用。`scrollRef` 指向真实 viewport，保留虚拟列表绑定；包装器不负责虚拟化。原生 Pinterest 由 [source_browser_pinterest_chrome.js](../../apps/desktop/src-tauri/src/commands/source_browser_pinterest_chrome.js) 注入同一 DOM 实现和 `OverlayScrollbars.css`，支持文档根滚动；React 接入层本身不能跨 WebView 控制网页，其他站点未启用。

## 面板边缘把手与退出按钮

- **入口／用途**　[PanelEdgeHandle.tsx](../../apps/desktop/src/components/PanelEdgeHandle.tsx) 提供窄页签、退出按钮、拖动握柄和 separator 语义。默认 tab 沿用素材库样式。探索使用 14.4 × 76 px 的 overlay 切角外观，画板中上方关闭、下方拖动，支持 Escape。一级探索收起素材流时，同一页签显示展开文字。
- **实用证据**　`CanvasLibraryResize` 与 `ExploreWorkspace` 共用该组件和 `.canvas-library-*` 样式。各宿主管理宽度和开合状态。探索把手位于网页左边缘内侧，`SourceBrowserPanel.boundsFor` 量取实际矩形、贴边方向和切角值，交给原生局部裁剪和命中透传。Windows 已实测，Mac 待实机验收。[原生遮罩](../../apps/desktop/src-tauri/src/commands/source_browser_overlay.rs)
- **探索非模态浮层**　[SourceBrowserPopover](../../apps/desktop/src/components/SourceBrowserPopover.tsx) 接收顶栏按钮、标题与关闭回调。右侧网页布局下优先利用网页左侧空间，宽度不足时按实际相交避让。浮层复用应用 Portal，支持 Esc、关闭后焦点恢复及外点关闭。采集记录和快捷站点设置各自负责内容和状态。
- **范围／状态：可跨模块复用。** 宿主提供 `grip` 的鼠标／键盘行为、宽度 ARIA 值与 `onClose`，不共用业务状态；关闭的页签通过宿主隐藏或 `collapsed` 退出 Tab 顺序。

## 记忆探索浏览器的上次网址

- 入口：[sourceDiscovery.ts](../../apps/desktop/src/lib/sourceDiscovery.ts) 的 `readLastSourceAddress`／`rememberSourceAddress`，共用 `normalizeSourceAddress` 与既有本机存储键。`App` 在首次显式打开探索时读取，`SourceBrowserPanel` 随真实地址变化保存。
- 边界：本机存储只保留最新的有效 HTTP(S) 网址。地址栏补全使用 `SourceBrowserPanel` 在本会话维护的访问记录。原生 `source-browser://location` 补齐 SPA 地址变化，加载状态沿用 status 事件。存储不可用时仍可浏览。

## 给图片加统一悬浮定位动效

- **用途／关键词：** hover、方点、对角定位、contain、画布缩放。
- **入口：** [MediaHoverMark.tsx](../../apps/desktop/src/components/MediaHoverMark.tsx) 的 `MediaHoverMark`；画布命中适配用 [CanvasMediaHover.tsx](../../apps/desktop/src/components/CanvasMediaHover.tsx) 的 `CanvasMediaHover`，动画和几何仍由前者承担。
- **实用证据：** [FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 在未选中 hover 时挂载 `MediaHoverMark`；`CanvasMediaHover` 调用它并传真实图片 `target`。
- **范围／状态：可跨模块复用。** 默认依赖父层 `.folder-media-preview`；其他媒体宿主须提供正确 `target` 和定位容器，不能对任意空容器直接挂载。宿主决定是否 hover、选中或拖动；`CanvasMediaHover` 的命中选择器专属于画板，不直接移入其他布局。规范与动效时长见 [媒体 hover 与多选](../UI-DESIGN-SPEC.md#72-媒体-hover-与多选)。

## 展示素材卡片和多选状态

- **用途／关键词：** 素材缩略图、多选、selection、图片／音频／文本卡、虚拟列表重挂。
- **入口：** [FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 的 `FileMediaCard`／`FileMediaCardProps` 是文件媒体卡入口，按类型选择内部卡片；仅需同构多选装饰时用 [LibrarySelectionMark.tsx](../../apps/desktop/src/components/LibrarySelectionMark.tsx) 的 `LibrarySelectionMark`。
- **实用证据：** [ConnectedCollections.tsx](../../apps/desktop/src/components/ConnectedCollections.tsx) 与 [CanvasFrequentAssets.tsx](../../apps/desktop/src/components/CanvasFrequentAssets.tsx) 均调用 `FileMediaCard`；[AudioFileMediaCard.tsx](../../apps/desktop/src/components/AudioFileMediaCard.tsx) 复用 `LibrarySelectionMark`。
- **文档预览：** [DocumentCardPreview.tsx](../../apps/desktop/src/components/DocumentCardPreview.tsx) 是素材库 `TextFileMediaCard` 与画板 `CanvasDocumentCard` 的共用阅读面；与 `catalogVirtualLayout.masonryRatios`、`canvasDocumentHeight` 共用 `textMedia.TEXT_CARD_ASPECT_RATIO`（3:4）。画板传入 `scrollable` 开启正文滚动及滚轮隔离，并给正文提取传入无限长度；素材库默认保持有界摘要。两个宿主按需加载 [documentPreviewText](../../apps/desktop/src/lib/documentPreview.ts)，由 `documentCodec.parseMarkdownAst` 共用编辑器语法解析、提取有界正文文字，不展示 Markdown／HTML 源码、不加载文档内媒体或编辑器。素材库复用 `textDocuments.read`、`createFilePreviewQueue`，版本／刷新失效、邻近可见时读取；画板直接读取文档 payload，保留独立编辑与端口交互。验证入口为 `text-catalog-ui.test.mjs`、`canvas-document-preview-ui.test.mjs` 与 `canvas-auto-connect-ui.test.mjs`，边界见 [文本素材](../TEXT-LIBRARY.md#素材库文档卡片2026-11-06)。
- **范围／状态：可跨模块复用（文件素材展示）。** 卡片依赖 `LocalFileEntry`、预览队列及本机拖出接口；选区由回调归宿主管理，不能当作纯图片组件。装饰依赖 `.folder-media-preview` DOM 和对应 CSS，只负责几何与进入动画，不负责选择、键盘或列表布局；画布节点选中、hover 与多选不可混成同一状态。

## 展示生成会话组图

- **生成来源：** 普通工作流生成、H3／HyperFrames 视频由 `canvasConversationCards` 归组，`CanvasWorkspace` 的标准素材卡复用 `GenerationGroupControls`；Agent 工作流卡片的子生图、直接交付与 Cloud 最终图片逐张展示。本机 [generation_gallery.rs](../../apps/desktop/src-tauri/src/core/generation_gallery.rs) 共用于画板、catalog 和文件夹查询，从精确任务／会话记录恢复历史，也覆盖对话视频与缺少 provider session 的素材；Agent 图片投影为独立键并保留生成来源。显式内容格保留各自会话；来源身份不充当 provider 续接句柄。入口矩阵见 [生成归组复核](../CANVAS-WORKFLOW.md#2026-11-06同会话生成组图源码未发布)，Agent 例外见 [独立图片展示](../CANVAS-WORKFLOW.md#2026-11-07agent-卡片图片独立展示源码待发布)。
- **入口：** [CatalogAssetCard.tsx](../../apps/desktop/src/components/CatalogAssetCard.tsx) 接资产与按时间升序的组成员，包裹既有 `FileMediaCard`，默认最新；[GenerationGroupControls.tsx](../../apps/desktop/src/components/GenerationGroupControls.tsx) 提供页码和键盘可用的左右按钮。`VirtualCatalog` 有实际调用，预览／选择／菜单回调交付当前显示资产。
- **画板：** [CanvasConversationImages.tsx](../../apps/desktop/src/components/CanvasConversationImages.tsx) 由 `CanvasWorkspace` 的会话卡和内容格共用；[canvasConversationCards.ts](../../apps/desktop/src/lib/canvasConversationCards.ts) 只做展示归组，保留精确任务／轮次／资产身份。内容格用 `allOutputs` 浏览续轮，独立展示仍用收纳后的 `outputs`。
- **边界：** 组成员必须来自相同查询范围；分页前去重与数量计算由本机 catalog 完成，不能在已分页列表上再折叠。文件夹内也先按当前范围归组，但保留 `ConnectedCollections` 的独立条目身份。`CatalogAssetCard` 的 `itemKey`／`renderMedia` 仅用于适配目录条目，轮播状态与最新成员恢复不复制实现；不以 Asset ID 覆盖 entry ID。

- **解散组合：** [GenerationGroupMenuItem.tsx](../../apps/desktop/src/components/GenerationGroupMenuItem.tsx) 由素材菜单与画板会话菜单共用，仅由真实展示组提供 target；复用 `dissolveGenerationGroup`，不改生成执行身份。本机 `generation_gallery` 保存显示偏好，catalog／文件夹查询和画板快照统一读取，避免各视图各存一份开关。

## 素材拖出到其他应用的反馈

- **入口：** [externalDrag.ts](../../apps/desktop/src/lib/externalDrag.ts) 的 `startExternalDrag` 共用原生会话、body 模糊层、两帧绘制等待和取消清理；`externalDragHud.tsx` 与 `externalDrag.css` 提供源位置投影及操作提示。
- **调用方：** `FileMediaCard` 在素材库原生拖动阈值后调用并传入源媒体矩形；`CanvasWorkspace` 在 600ms 长按后传 `source: canvas`、矩形及项目取消信号。
- **边界：** 两种来源共用视觉，只有画布来源拦截同窗投递；素材库保留集合／画板投递，草稿图层不进入原生外拖；新增 `useLibraryDragHold` 同样排除 `[data-draft-library]`，700ms 长按后仍复用内部图层拖入。复用前必须先登记 `dragPayload` 身份；原件由后台解析，HUD 不承担文件传输。原生验收范围见 [素材拖出](../EXTERNAL-DRAG.md)。

## 在新创作入口保留统一编辑框与参数

- **共用表面与动效：** [IndustrialCanvas.css](../../apps/desktop/src/components/IndustrialCanvas.css) 的 `.creation-dock.composer-glass` 控制无框全息布局、左轨投影标签和内容自适应高度；[ComposerProjection.tsx](../../apps/desktop/src/components/creation/ComposerProjection.tsx) 仅负责鼠标穿透的局部渐隐上弧线、羽化中线贴合弧线并叠加椭圆衰减的 mask、呼吸方点及三层小叉视差（无竖直侧边）；2026-11-08 接入确认的轮廓光膜：同一组件内定义独立 ID 的深浅色 SVG 轮廓滤镜，由共用 CSS 的 backdrop-filter 直接读取真实后景，替代 14.4px 模糊并叠加 24% 斜向眩光，不复制素材或画板内容；左轨内移与标签独立 6px 磨砂由共用 CSS 控制；`collapsed` 复用静态弧面，配合 54px 单行入口，从自身 DOM 父节点定位宿主并在 layout effect 中完成首帧前测量，观察尺寸／主题／可见性并在收起、隐藏和减少动态时停刷；投影高度排除入场平移，避免激活后底部露缝。底部间距共用 `CreationBoard.css` 的 `--composer-bottom-gap`（常规 12px／窄窗口 8px），素材库多选避让保留。[useTerminalCaret.ts](../../apps/desktop/src/components/creation/useTerminalCaret.ts) 使用 `useCreationEditor` 返回的 `viewRef` 与原生选区绘制窄块光标，不更改编辑器文档或选择。项目继续使用 `TacticalSelect` 与 `library-project-menu`；品牌与参数沿原选择器。独立 `.composer-references` 展示条已暂时移除；图片仅通过正文的引用 chip 呈现，继续复用 `BoardChipPreview`，顺序、删除与发送仍走编辑器。无添加素材按钮，Tab／双击维持原路径。`CreationBoard` 仅在真实收起后播放展开动画，模式切换仍由 `CreativeComposer` 保留独立草稿但不重播整框动效；输入区与发送控件共用 `--composer-end-inset` 对齐右缘。宽度继续使用 `CreationBoard.css` 的 68%／1080px 上限；`LibraryComposer.css` 负责主屏贴底与多选避让。轮廓像素／真实后景移动／双主题／减少透明效果验收见 `composer-contour-ui.test.mjs` 与 [实装记录](../../project_logs/2026-11-08-composer-contour.md)；既有验证入口 `composer-mode-continuity-ui.test.mjs`、`composer-projection-ui.test.mjs`、`composer-hud-ui.test.mjs`、`composer-header-ui.test.mjs` 与 `library-creation-parity-ui.test.mjs`，见 [记录](../../project_logs/2026-11-04-composer-projection.md)。
- **用途／关键词：** 创作输入、composer、图片／视频／对话、草稿、继续生成。
- **入口：** [CreativeComposer.tsx](../../apps/desktop/src/components/CreativeComposer.tsx) 的 `CreativeComposer` 管理三种模式各自草稿，内部嵌入 [CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx) 的 `CreationBoard`。优先按完整创作契约接入，而不是复制输入框 DOM。
- **实用证据：** [LibraryComposer.tsx](../../apps/desktop/src/components/LibraryComposer.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 都使用 `CreativeComposer`；[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 的继续编辑另用 [useCreationEditor.ts](../../apps/desktop/src/components/creation/useCreationEditor.ts) 的 `useCreationEditor`，与 `CreationBoard` 共用编辑核心。
- **范围／状态：可跨模块复用（桌面创作领域）。** 宿主必须提供草稿持久化、项目／线程解析及发送回调，组件仍依赖桌面 store、API、provider 与编辑器事件；不是通用富文本表单。`GenerationPanel` 带历史／续轮语义，不与首轮入口直接互换；普通文档编辑使用 Plate 文本工作区，不复用整个生成框。编辑核心、文档转换与引用约束见 [桌面逻辑地图](DESKTOP.md)。

## 保持主屏和画板的创作模式标记、图片手势一致

- **用途／关键词：** 创作状态、单击预览、双击引用、拖动抑制、迟到回包。
- **入口：** [CreationModeIndicator.tsx](../../apps/desktop/src/components/CreationModeIndicator.tsx) 的 `CreationModeIndicator`；行为用 [useCreationImageInteraction.ts](../../apps/desktop/src/components/useCreationImageInteraction.ts) 的 `useCreationImageInteraction`／`CreationImageTarget`，宿主只负责解析媒体归属与绑定 gesture。
- **实用证据：** [App.tsx](../../apps/desktop/src/App.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 都挂标记；后者调用手势 Hook，[useHomeCreationImage.ts](../../apps/desktop/src/components/useHomeCreationImage.ts) 适配主屏并由 [HomeWorkspace.tsx](../../apps/desktop/src/components/HomeWorkspace.tsx) 绑定事件。
- **范围。** 项目画板与素材库主页共用该手势。浏览图片时单击预览，创作时双击添加引用。「视频」或「对话」创作框激活后，视频同样支持单击播放、双击引用。画板通过 `handlesVideo` 把鼠标松开后的打开动作交给同一手势处理，点击组图时取当前显示项。Hook 校验当前项目、素材身份、修饰键与拖动状态，通过 `BOARD_ASSET_PICK_EVENT` 投递引用。
- **图片详情复用：** [CreationImagePreview.tsx](../../apps/desktop/src/components/CreationImagePreview.tsx) 右侧使用 [AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 的 `panelOnly` 与显式 `selection`，`initialAsset` 支持不在当前列表中的图片先显示元信息；详情数据和编辑仍走原接口。该模式直接展示信息，不挂载页签、再创作内容、详情页工具栏、原图或组内导航，也不重复读取生成历史；中间原图及左侧生成记录由预览宿主管理，独立详情默认保留原页签。「双击添加参考图」由共用 `CreationBoard` 的输入区底部留白展示，仅「双击」加粗；`CreationModeIndicator` 保留顶部创作状态。
- 视频预览传入 `video` 复用同一组可收起面板，中间挂载 [VideoPlayer.tsx](../../apps/desktop/src/components/VideoPlayer.tsx)。画板传入站内导出／裁剪回调，素材库入口由 [LibraryVideoPreview.tsx](../../apps/desktop/src/components/LibraryVideoPreview.tsx) 提供相应回调。
- 素材视频的文稿由 [VideoTranscriptPanel](../../apps/desktop/src/components/VideoTranscriptPanel.tsx) 挂入同一右栏，经 `seekRequest` 定位句段。生成会话保持挂载以保留草稿。批量入口 [VideoTranscriptBatch](../../apps/desktop/src/components/VideoTranscriptBatch.tsx) 复用素材库工具栏和 `ModalShell`。两处共用素材转录能力和本机报价，单条按一条完整音轨确认，批量按所选范围汇总。取回已经提交的任务沿用原编号和报价。
- **预览与画布续轮：** [ImagePreviewContinuation.tsx](../../apps/desktop/src/components/ImagePreviewContinuation.tsx) 提供放大页输入与画布浮层 `CanvasImageContinuation`。两处保留独立草稿，复用 store 的显式 `sendGenRevise(jobId, ...)`／`cancelGeneration(jobId)`。[imagePreviewContinuation.ts](../../apps/desktop/src/lib/imagePreviewContinuation.ts) 按当前资产读取历史，发送时恢复真实任务及原项目／线程，拒绝歧义并保留路由、关闭、权益门控。旧轮或单轮多图续改以所选图片作为精确参考。宿主以 `workflowOrigin` 标记画布生成来源，以 `navigation` 提供真实组图成员。放大页左侧「生成记录」的单轮图片展示生成参数，多轮图片和视频复用 `GenerationPanel` 只读视图并定位当前产物。仅跟进本预览提交的新轮，完成后按实际资产切换主图。两侧收起均保持挂载以保留草稿与阅读位置。
- **自由图片舞台：** 同一预览支持普通导入图片，没有会话时只显示图片和详情。详情／会话均可独立收起，工具栏保留重开入口；详情保持挂载以保留未完成编辑和滚动位置。`CreationImagePreview.css` 仅在窗口边界裁切，图片与角标共同变换；预览私有 [useImagePreviewHud.ts](../../apps/desktop/src/components/useImagePreviewHud.ts) 按图片边界定位四组标题／控制，维持屏幕尺寸、窗口安全边距及侧面板避让，并将预览中心换算成每侧局部坐标作为共同旋转／透视原点，不作为跨模块布局接口。拖拽／滚轮只从图片开始，空白单击退出，按下／松手来源和移动距离防止拖图误关。外围投影线保留，面板及图片后层沿用 `ProjectManagerPanel.css`／`ProjectCreateCard.css` 的层叠与短闪语汇，不导入项目卡片内部逻辑；两侧正文与底板同属一个虚拟平面，选取／输入／键盘聚焦时共享姿态锁定，原图保持平面。缩放复用 [useImageZoom.ts](../../apps/desktop/src/lib/useImageZoom.ts) 的 `zoomBy`／`reset`；宿主显式允许 0.1–16 倍，原灯箱与普通详情仍默认 1–8 倍。已移除没有消费者的空白舞台滚轮参数。
- **渐进加载与渲染：** 图片先绘制，缩略图可先于原件显示；`AssetDetail.onReady(assetId)` 在首次分析、标签、集合读取全部 settled 后通知预览宿主，不等待 CLI 健康检查；独立详情另读生成来源。宿主按请求身份及图片入场状态显现两侧，`GenerationPanel` 的只读提示词视图延后挂载，固定投影区避免资料加载后重排。后景滤镜只保留两侧玻璃阅读面，全屏背景、点阵、四角控件和详情吸顶栏不再叠加滤镜。`useCompatibleImagePath(path, onError?)` 可选回调用于转换失败时释放图片加载门控，原调用保持兼容；旧详情页仍逐项呈现初始数据。`image-preview-rendering-ui.test.mjs` 核对滤镜范围、历史读取次数、空闲停刷及独立详情兼容；不代表高 GPU 负载下的原生帧率验收。

## 素材库侧栏与模式

- **控件与批量操作：** [LibraryCatalogControls.tsx](../../apps/desktop/src/components/LibraryCatalogControls.tsx) 共用素材类型、来源、颜色准备及窄栏收纳，文件夹只通过 children 增加刷新同步；颜色准备由宿主传递查询范围与刷新回调。`CatalogSelectionBar` 共用取消／全选／文件夹分配及画板或新项目动作，宿主保留素材 ID 或目录条目 ID 的解析。两者由 `CategorizedLibrary`、`ConnectedCollections` 同时调用。
- **以文搜图：** 首页与展开的画板素材栏为全部／项目平铺图片视图启用 [LibrarySemanticSearch.tsx](../../apps/desktop/src/components/LibrarySemanticSearch.tsx)，沿用浮动控件收纳。每栏维护提交、取消、结果会话与退出焦点，目录范围和名称／来源／颜色筛选仍由 `CatalogFilter` 表达。[VirtualCatalog.tsx](../../apps/desktop/src/components/VirtualCatalog.tsx) 通过 `readPage`／`pageScope` 显示会话排序并隔离缓存，范围选择／全选同样读取会话 ID；复用素材卡、预览、拖动和上下文菜单。退出结果恢复原浏览位置，素材库变化校验当前会话，模型或索引重置立即退出对应结果。文件夹、标签及文本编辑器维持原入口。[桌面交互回归](../../apps/desktop/scripts/library-semantic-search-ui.test.mjs)。

- **用途／关键词：** 目录切换、整栏转场、catalog、素材栏、减少动态效果。
- **导航** — [LibrarySidebar.tsx](../../apps/desktop/src/components/LibrarySidebar.tsx) 常驻于主页、画板和文本工作区共用的素材库壳层。Q 切回层级，E 切入全局标签，Tab 在画板内开合抽屉。项目行通过 `useProjectAssetDrop` 与全局项目右键菜单复用操作。
- **标签管理** — [LibraryCatalog.tsx](../../apps/desktop/src/components/LibraryCatalog.tsx) 由两种侧栏模式或 [CatalogTagIndex.tsx](../../apps/desktop/src/components/CatalogTagIndex.tsx) 的右键菜单打开共用 [LocalClassificationDialog](../../apps/desktop/src/components/LocalClassificationDialog.tsx)。弹窗使用打开时的浏览项目范围，可按标签 ID 直开编辑或删除确认。点弹窗里的标签名会关闭弹窗、展开当前栏的全局标签模式、清除名称搜索并调用既有分区定位。
- **投影外观：** `LibraryControlProjection` 与 `LibraryProjection.css` 覆盖在既有 `.file-view-heading`。导航与旁侧控件保留指针锚定，窄栏由 `LibraryFloatingControls` 收纳。选中标签一直可读，较长项目名截断并保留完整可访问名称。
- **路由和搜索** — [LibraryCatalog.tsx](../../apps/desktop/src/components/LibraryCatalog.tsx) 把目录树和 `CatalogTagIndex` 挂到稳定的侧栏。右侧由 `CategorizedLibrary` 或 `ConnectedCollections` 复用 `VirtualCatalog`，项目和连接目录按分段读取。文件夹多选保留目录条目身份，项目总览按素材身份去重。
- **实用证据：** [LibraryHome.tsx](../../apps/desktop/src/components/LibraryHome.tsx) 和 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 共用该入口。
- **探索素材流**　[ExploreLibrary.tsx](../../apps/desktop/src/components/ExploreLibrary.tsx) 以独立素材栏身份复用 `LibraryCatalog` 和 `VirtualCatalog`。目录点击更新浏览范围，进入画板仍由宿主决定。紧凑密度与显隐只应用于探索，采集回执在匹配的项目、文件夹、标签或全库范围优先展示本次素材。
- **范围／状态：可跨模块复用（已有素材目录）。** 接口沿用 `CategorizedLibrary` props，DOM 与动画绑定目录侧栏及 `all/tags/collections` 语义；不能作为通用路由转场容器。内部 `floatSidebar` 等是模块内部专用，不独立导入或复制成其他板块动效。
- **验证：** `test:library:navigation` 覆盖悬浮导航几何、来源查询、视角独立切换、Q／E／F／Tab、深浅主题、分栏与项目菜单。`library-tab-memory-ui.test.mjs` 验证重启和跨项目返回。`material-catalog-ui.test.mjs` 和 `folder-view-parity-ui.test.mjs` 验证搜索覆盖、清空与位置恢复。`canvas-library-projection-ui.test.mjs` 核对 480px 抽屉和筛选收纳。

## 切页时保留浏览状态和滚动位置

- **用途／关键词：** 保活、suspended、inert、暂停视频、返回位置。
- **入口：** [PreservedWorkspace.tsx](../../apps/desktop/src/components/PreservedWorkspace.tsx) 的 `PreservedWorkspace`。
- **实用证据：** [App.tsx](../../apps/desktop/src/App.tsx) 在详情／项目切换保留工作区；[HomeWorkspace.tsx](../../apps/desktop/src/components/HomeWorkspace.tsx) 包装素材库和项目页。
- **范围／状态：可跨模块复用。** 保持子树挂载、记录垂直滚动、隐藏时 `inert` 并暂停 video；宿主仍要控制页面布局、`active`／快捷键和异步副作用。它不会取消后台任务、暂停所有音频或持久化整个页面状态，也不替代应用导航 store。

## 给嵌入素材侧栏提供调宽与关闭

- **用途／关键词：** resize、侧栏、separator、分栏、拖动宽度、键盘调宽。
- **入口：** [CanvasLibraryResize.tsx](../../apps/desktop/src/components/CanvasLibraryResize.tsx) 的 `CanvasLibraryResize`；按 `panelId` 绑定素材面板，可指定 `storageKey`、`reserveWidth` 和 `initialWidth`。
- **实用证据：** [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 调用默认侧栏入口；[TextWorkspaceLibrary.tsx](../../apps/desktop/src/components/TextWorkspaceLibrary.tsx) 用独立存储键和正文保留宽度复用。
- **范围／状态：可跨模块复用（同构素材侧栏）。** 强依赖 `.canvas-workspace`、目录导航 DOM、`--canvas-source-width` 和已有侧栏 CSS；其他布局不能仅导入组件就获得通用 splitter。[LibraryHome.tsx](../../apps/desktop/src/components/LibraryHome.tsx) 的私有 `PaneDivider` 按相邻两栏比例调整，双击均分；本组件按像素调侧栏、双击恢复最大宽度。`PaneDivider` 为**模块内部专用**，两者不是可直接合并的重复实现。

覆盖及后续候选统一见 [核验记录](REVIEW.md)。本页未审计所有弹层／独立窗口，也未枚举每个 CSS 选择器；新增能力仍需按关键词跨板块查调用。

- 视频链接采集入口：`VideoCollectionEntry` 由 `SourceBrowserPanel` 在探索工具栏使用；`ExploreWorkspace` 传递主应用的新建项目回调。素材库不再挂载入口，采集与画板交付继续复用原实现。

- 文档卡片文本输出：`canvasNoteValue` 复用 `documentPreviewText` 的语法树正文提取，传入无限长度以避免摘要截断；素材引用先由 `documentWorkflowValue` 投影，再移除 Markdown 标记。编辑器回填仍使用原投影。

## 头像、登录与余额

顶栏 [SidebarAccount](../../apps/desktop/src/components/SidebarAccount.tsx) 将登录、账号概览和积分明细分别送到对应面板。微信或邮箱登录后，[AccountOnboarding](../../apps/desktop/src/components/AccountOnboarding.tsx) 打开同一 [SettingsDialog](../../apps/desktop/src/components/SettingsDialog.tsx) 的账号分区。复用 [CreditDetails](../../apps/desktop/src/components/CreditDetails.tsx) 展示真实收支，[AccountBilling](../../apps/desktop/src/components/AccountBilling.tsx) 处理可展开的方案与充值，[RedeemCodeCard](../../apps/desktop/src/components/RedeemCodeCard.tsx) 处理兑换与回执。概览与顶栏使用 `accountEntitlement` 核对账号和快照有效状态。
