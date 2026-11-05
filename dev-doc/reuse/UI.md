# UI、布局与交互复用

[返回复用地图](../Bowerbird开发计划.md#复用地图)。本页按 2026-11-03 当前工作区源码核对，包含未提交实现；状态表示可用边界，不表示已发版。视觉规则和样式加载顺序仍以 [UI-DESIGN-SPEC 第 11 节](../UI-DESIGN-SPEC.md#11-实现入口与使用顺序) 为入口，不在这里复制色值与动效规范。

## 探索采集直接落入标签

- **入口：** [ExploreWorkspace.tsx](../../apps/desktop/src/components/ExploreWorkspace.tsx) 读取标签目录／分组的 `data-tag-id`／`data-tag-section`，复用 [localClassification.ts](../../apps/desktop/src/lib/localClassification.ts) 的全局／项目 `example` 人工归属接口；不另建标签体系。
- **边界：** 明确标签落点冻结项目和标签，沿现有采集队列重试；传 `skipClassification` 到原生采集，内部 `ingest_from_bytes_with_classification` 控制单次自动入队，普通 `ingest_from_bytes` 默认保持自动处理。只用于明确的人工落点，不修改全局开关。未分类分组继续原流程。契约与验证见 [探索浏览器](../EMBEDDED-BROWSER.md#2026-11-04标签落点直接归类源码待发布)。

## 让新界面沿用主题、按钮和字段

- **用途／关键词：** 深浅色、tokens、工程蓝、button、input、Tailwind。
- **入口：** [styles.css](../../apps/desktop/src/styles.css) 的 `--bb-*`、`.app-button-primary`／`.app-button-secondary`、`.app-modal-button`；[IndustrialTheme.css](../../apps/desktop/src/components/IndustrialTheme.css) 覆盖当前色板与状态；[tailwind.config.js](../../apps/desktop/tailwind.config.js) 把 `canvas`／`panel`／`ink`／`muted` 映射到变量。主题切换走 [theme.ts](../../apps/desktop/src/lib/theme.ts) 的 `applyTheme`／`loadCachedTheme`。
- **实用证据：** [main.tsx](../../apps/desktop/src/main.tsx) 加载基础 CSS 并应用缓存主题，[App.tsx](../../apps/desktop/src/App.tsx) 在既有 Tactical 样式之后加载三个 Industrial 文件；[ConfirmDialog.tsx](../../apps/desktop/src/components/ConfirmDialog.tsx) 使用 `.app-modal-button`。
- **范围／状态：可跨模块复用。** 这是桌面 CSS 接口，并非独立 React Button/Input 组件库。复用语义变量和合适的控件类；画布 HUD 阴影、菜单规则分别由 `IndustrialCanvas.css`、`IndustrialMenus.css` 负责，不能把全局按钮类套到所有卡片。独立截图窗口不经过主 App 同一入口，不能假定主题覆盖相同。

## 新建模态表单或二次确认

- **用途／关键词：** dialog、确认、焦点循环、Esc、忙碌锁定、固定动作栏。
- **入口：** [ModalShell.tsx](../../apps/desktop/src/components/ModalShell.tsx) 的 `ModalShell`；简单确认用 [ConfirmDialog.tsx](../../apps/desktop/src/components/ConfirmDialog.tsx) 的 `ConfirmDialog`。布局和状态样式沿用现有 `.app-modal-*`。
- **实用证据：** [SettingsDialog.tsx](../../apps/desktop/src/components/SettingsDialog.tsx) 用于设置长表单；[CollectionDialogs.tsx](../../apps/desktop/src/components/CollectionDialogs.tsx) 用 `preventClose={busy}`；[ProjectDeleteDialog.tsx](../../apps/desktop/src/components/ProjectDeleteDialog.tsx) 组合复杂删除内容；[BatchBar.tsx](../../apps/desktop/src/components/BatchBar.tsx) 调用 `ConfirmDialog`。
- **范围／状态：可跨模块复用。** 宿主控制挂载与 `onClose`，Shell 管遮罩、首焦点、Tab 和关闭后焦点恢复；字段可标 `data-modal-autofocus`。`ConfirmDialog.confirmDisabled` 只禁用确认按钮，不锁住取消／Esc；异步忙碌需要关闭锁时用 `ModalShell.preventClose`。全页项目管理和图片／会话预览不强套模态表单壳。

## 添加普通单选下拉

多选标签使用 [AssetTagPicker.tsx](../../apps/desktop/src/components/AssetTagPicker.tsx)：详情领域组件，接素材 ID、当前 `AssetTag[]` 与刷新回调；宿主按素材 ID 设置 key。复用 `localClassification.labels/save/example`、`api.listAssetTags`、`OverlayScrollArea` 与工业菜单。字母归组与比较统一来自 [materialCatalogOrder.ts](../../apps/desktop/src/lib/materialCatalogOrder.ts) 的 `catalogInitial/compareTagNames`，不要重建拼音边界。包含新建／归属写入，不作为无业务通用下拉。

- **用途／关键词：** select、listbox、选项组、方向键、输入定位、禁用。
- **入口：** [TacticalSelect.tsx](../../apps/desktop/src/components/TacticalSelect.tsx) 的 `TacticalSelect`／`TacticalSelectProps`；传 `<option>`／`<optgroup>`，接 `onValueChange`，值统一为字符串。解析、方向导航与定位由同目录 [tacticalSelectLogic.ts](../../apps/desktop/src/components/tacticalSelectLogic.ts) 提供，消费者优先用组件。
- **实用证据：** [LibraryComposer.tsx](../../apps/desktop/src/components/LibraryComposer.tsx) 的项目选择；[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 的详情选择；[CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的画板选择；[CanvasWorkflowLayer.tsx](../../apps/desktop/src/components/CanvasWorkflowLayer.tsx) 的触发器四模式菜单。
- **范围／状态：可跨模块复用。** 普通单选与键盘交互；菜单视觉由 `IndustrialMenus.css` 最终覆盖。它是按钮 + listbox，非原生 `<select>`，有 `name` 才输出隐藏表单值；不承担动作子菜单、模型计费信息或任意富内容选择。当前弹层直接挂 `document.body`，局部焦点边界见下文。

## 添加右键菜单与动作子菜单

2026-11-06：公共 `ContextMenu` 的首焦点与方向键导航同时覆盖普通菜单项、单选菜单项和多选菜单项（`menuitem`／`menuitemradio`／`menuitemcheckbox`）；文本编辑器的 `TextSegmentMenu` 使用此入口并保存块身份；正文／标题类型切换已由完整 Plate EditorKit 接管。

- **用途／关键词：** context menu、右键、操作、删除子菜单、焦点恢复。
- **入口：** [ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 的 `ContextMenu`、`ContextSubmenu`、`DeleteSubmenu`；宿主提供坐标、关闭回调、`button[role="menuitem"]` 与禁用状态。
- **实用证据：** [AssetContextMenu.tsx](../../apps/desktop/src/components/AssetContextMenu.tsx) 使用子菜单和删除分组；[ProjectContextMenu.tsx](../../apps/desktop/src/components/ProjectContextMenu.tsx) 使用同一菜单壳。
- **范围／状态：可跨模块复用。** 共用边缘定位、菜单家族互斥、键盘／外部点击关闭和滚动包装；`ContextSubmenu` 必须位于该菜单 Context 内。`AssetContextMenu`／`ProjectContextMenu` 自身绑定素材、项目和 store 行为，是领域入口，不作其他业务的通用菜单模板。

### 编辑完整富文本文档

- **入口：** [TextPlateEditor.tsx](../../apps/desktop/src/components/TextPlateEditor.tsx) 与 [EditorKit](../../apps/desktop/src/components/text-editor/plate/components/editor/editor-kit.tsx)。宿主传入文档值、素材、变更回调及拖入解析；实例公开插入素材、Markdown 和预留光标插入接口。
- **调用方：** 放大工作区 `TextWorkspace`、原文件详情 `TextDocumentEditor`。两者共用块编辑、工具栏、媒体与文档内讨论；布局和保存归属由宿主控制。
- **服务：** `TextEditorServices` 复用 `TextAgentModel`、既有 `TextAgentTask` 和媒体导入；附件走本机受控命令，导入／导出独立懒加载。评论、修订、提及仅本机，完整状态经 `documentState.ts` 保存。
- **边界：** 与桌面 store、Tauri API、应用 portal 和主题相关，不是独立跨运行时 UI 包。不要直接跨模块调用某个上游 kit 内部实现；新增文档入口优先复用 `TextPlateEditor`。来源、样式生成、格式边界及验收见 [Plate 适配说明](../../apps/desktop/src/components/text-editor/plate/README.md) 与 [文本专项](../TEXT-LIBRARY.md)。

## 给画布卡片添加统一连接加号

- **用途／关键词：** 端口、加号、输入输出、磁吸、整卡接收、自动连接、热区。
- **入口：** [CanvasConnectionHandle.tsx](../../apps/desktop/src/components/CanvasConnectionHandle.tsx) 的 `CanvasConnectionHandle`／`CanvasConnectionHandleProps` 兼容原生 button 属性，提供 `side: "input" | "output"`、`active`、可选 `zoom` 及转发 ref；宿主提供事件回调。卡片或热区悬浮／选中／键盘显隐、禁用命中关闭、76.8px 固定热区、紧凑方框与斜纹加号造型、视觉磁吸、重叠热区就近选择及减少动态效果均由组件与同名 CSS 共用，尺寸与动效见 [端口规范](../UI-DESIGN-SPEC.md#8-输入输出端口)。
- **实用证据：** [CanvasWorkflowLayer.tsx](../../apps/desktop/src/components/CanvasWorkflowLayer.tsx) 用于工作流／素材数据连接，[CanvasTextCard.tsx](../../apps/desktop/src/components/CanvasTextCard.tsx) 与 [CanvasDocumentCard.tsx](../../apps/desktop/src/components/CanvasDocumentCard.tsx) 用于原生卡片。画布容器提供 `--canvas-zoom` 和草稿期间的 `data-canvas-connecting`，发起卡片的 `data-canvas-connection-source` 保留对应一侧入口，按钮输出 `data-canvas-connect-side`；键盘激活由宿主按按钮中心打开连接菜单。
- **范围／状态：画布领域共用。** 组件只管理命中与可见反馈，不提交连接或解释媒体类型。交互状态统一归 `CanvasWorkflowLayer`（单击牵线／按住拖放、整卡命中、空白菜单、右键取消），类型交集归 [workflowAutoConnect.ts](../../apps/desktop/src/lib/workflowAutoConnect.ts) 的 `planAutomaticConnection`，持久化归 [canvasWorkflowRuntime.ts](../../apps/desktop/src/lib/canvasWorkflowRuntime.ts) 的 `connectAutomatic`／`disconnectAutomatic`；消费者不复制手势层或直接写入多条 typed 绑定。菜单复用 `ContextMenu`／`ContextSubmenu`，旧精确端口位置仍由 [useWorkflowPortGeometry.ts](../../apps/desktop/src/lib/useWorkflowPortGeometry.ts) 缓存。
- **验证：** `canvas-connection-handle-ui.test.mjs` 验证固定屏幕尺寸、磁吸／取消、编辑与键盘及重叠命中；`canvas-auto-connect-ui.test.mjs` 验证实际交互层。运行、原子保存与兼容边界见 [工作流协议](../CANVAS-WORKFLOW.md#2026-11-04统一加号与自动内容连接源码未发布)。

## 选择生成模型或图片比例

- **用途／关键词：** provider、模型、比例、ratio、默认模型、Bcoin。
- **入口：** [creation/ProviderSelect.tsx](../../apps/desktop/src/components/creation/ProviderSelect.tsx) 的 `ProviderSelect` 负责图片 provider 选择；其内部用 [ModelSelect.tsx](../../apps/desktop/src/components/creation/ModelSelect.tsx) 的 `ModelSelect`。比例图形菜单用 [RatioSelect.tsx](../../apps/desktop/src/components/creation/RatioSelect.tsx) 的 `RatioSelect`。
- **实用证据：** [CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx) 调用 `ProviderSelect` 与 `RatioSelect`；`ProviderSelect` 生成 `ModelOption[]` 后调用 `ModelSelect`。
- **范围／状态：模块内部专用（创作／生成领域）。** `ProviderSelect` 依赖账号权益、引擎健康、store 和设置 API；`ModelSelect` 也读取 Cloud 服务价格，并非纯展示组件。比例菜单表示 `string | null` 的自动／固定比例，模型面板提供来源、禁用原因及默认项；不能仅因都是下拉就直接换成 `TacticalSelect`，也不推荐非生成板块导入这些业务选择器。

## 把弹层留在嵌入工作区的焦点边界内

- **用途／关键词：** portal、嵌套弹窗、浮层宿主、stacking、focus。
- **入口：** [portalTarget.tsx](../../apps/desktop/src/lib/portalTarget.tsx) 的 `PortalTargetContext`／`usePortalTarget`；无 Provider 时回退 `document.body`。
- **实用证据：** [TextWorkspace.tsx](../../apps/desktop/src/components/TextWorkspace.tsx) 以编辑面板 DOM 提供 Context；[ModalShell.tsx](../../apps/desktop/src/components/ModalShell.tsx) 与 [ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 调用 `usePortalTarget()` 再创建 portal。
- **范围／状态：可跨模块复用。** 只选择挂载目标，不替代焦点管理和坐标系统。当前 `TacticalSelect`、`RatioSelect`、`ModelSelect` 仍直接挂 body，**不能把 Context 当成所有弹层都已接入的保证**；在局部工作区接入菜单时要核实实际消费者及键盘行为。

## 添加不占内容宽高的滚动区域

- **用途／关键词：** scrollbar、悬浮滚动条、横向滚动、虚拟列表、scrollRef。
- **入口：** [OverlayScrollbars.tsx](../../apps/desktop/src/components/OverlayScrollbars.tsx) 的 `OverlayScrollbars`／`enableOverlayScrollbars` 是 React 接入层，DOM 管理器唯一实现为 [overlayScrollbars.js](../../apps/desktop/src/lib/overlayScrollbars.js)；需要现成 viewport／content 结构时用 [CollectionScrollArea.tsx](../../apps/desktop/src/components/CollectionScrollArea.tsx) 的 `OverlayScrollArea`，集合特化包装为 `CollectionScrollArea`。
- **实用证据：** [main.tsx](../../apps/desktop/src/main.tsx) 挂载全局 `OverlayScrollbars`；[ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 和 [CanvasDocumentCard.tsx](../../apps/desktop/src/components/CanvasDocumentCard.tsx) 使用 `OverlayScrollArea`。
- **范围／状态：可跨模块复用。** 根入口与包装器引用计数共享 manager，普通滚动元素在主应用中无需每处另挂管理器；独立包装器会自行启用。`scrollRef` 指向真实 viewport，保留虚拟列表绑定；包装器不负责虚拟化。原生 Pinterest 由 [source_browser_pinterest_chrome.js](../../apps/desktop/src-tauri/src/commands/source_browser_pinterest_chrome.js) 注入同一 DOM 实现和 `OverlayScrollbars.css`，支持文档根滚动；React 接入层本身不能跨 WebView 控制网页，其他站点未启用。

## 面板边缘把手与退出按钮

- **入口／用途：** [PanelEdgeHandle.tsx](../../apps/desktop/src/components/PanelEdgeHandle.tsx) 提供窄页签、退出按钮、拖动握柄和 separator 语义。默认 tab 外观保留素材库样式；探索使用 overlay 切角外观（14.4×76px，上关闭／下拖动，不显示 ESC 小字），保留 Escape 快捷键。
- **实用证据：** `CanvasLibraryResize` 与 `ExploreWorkspace` 共用该组件和 `.canvas-library-*` 样式。前者仍拥有素材库的宽度、动画与持久化；后者拥有探索宽度、原生网页遮挡和关闭状态；探索页签由宿主 CSS 放在面板内侧，viewport 保持完整宽度；`SourceBrowserPanel.boundsFor` 量取页签精确足迹与 SVG 切角值，交给 [source_browser_overlay.rs](../../apps/desktop/src-tauri/src/commands/source_browser_overlay.rs) 的受限局部裁剪／命中穿透。Windows 原生验证通过，Mac 遮罩实现待本机验收。
- **范围／状态：可跨模块复用。** 宿主提供 `grip` 的鼠标／键盘行为、宽度 ARIA 值与 `onClose`，不共用业务状态；关闭的页签通过宿主隐藏或 `collapsed` 退出 Tab 顺序。

## 记忆探索浏览器的上次网址

- 入口：[sourceDiscovery.ts](../../apps/desktop/src/lib/sourceDiscovery.ts) 的 `readLastSourceAddress`／`rememberSourceAddress`，共用 `normalizeSourceAddress` 与既有本机存储键。`App` 在首次显式打开探索时读取，`SourceBrowserPanel` 随真实地址变化保存。
- 边界：只存最新的有效 HTTP(S) 网址，不是历史列表、页面快照或跨窗口路由状态。原生 `source-browser://location` 补齐 SPA 地址变化，加载状态继续由原 status 事件负责；存储不可用不阻断浏览。

## 给图片加统一悬浮定位动效

- **用途／关键词：** hover、方点、对角定位、contain、画布缩放。
- **入口：** [MediaHoverMark.tsx](../../apps/desktop/src/components/MediaHoverMark.tsx) 的 `MediaHoverMark`；画布命中适配用 [CanvasMediaHover.tsx](../../apps/desktop/src/components/CanvasMediaHover.tsx) 的 `CanvasMediaHover`，动画和几何仍由前者承担。
- **实用证据：** [FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 在未选中 hover 时挂载 `MediaHoverMark`；`CanvasMediaHover` 调用它并传真实图片 `target`。
- **范围／状态：可跨模块复用。** 默认依赖父层 `.folder-media-preview`；其他媒体宿主须提供正确 `target` 和定位容器，不能对任意空容器直接挂载。宿主决定是否 hover、选中或拖动；`CanvasMediaHover` 的命中选择器专属于画板，不直接移入其他布局。规范与动效时长见 [媒体 hover 与多选](../UI-DESIGN-SPEC.md#72-媒体-hover-与多选)。

## 展示素材卡片和多选状态

- **用途／关键词：** 素材缩略图、多选、selection、图片／音频／文本卡、虚拟列表重挂。
- **入口：** [FileMediaCard.tsx](../../apps/desktop/src/components/FileMediaCard.tsx) 的 `FileMediaCard`／`FileMediaCardProps` 是文件媒体卡入口，按类型选择内部卡片；仅需同构多选装饰时用 [LibrarySelectionMark.tsx](../../apps/desktop/src/components/LibrarySelectionMark.tsx) 的 `LibrarySelectionMark`。
- **实用证据：** [ConnectedCollections.tsx](../../apps/desktop/src/components/ConnectedCollections.tsx) 与 [CanvasFrequentAssets.tsx](../../apps/desktop/src/components/CanvasFrequentAssets.tsx) 均调用 `FileMediaCard`；[AudioFileMediaCard.tsx](../../apps/desktop/src/components/AudioFileMediaCard.tsx) 复用 `LibrarySelectionMark`。
- **范围／状态：可跨模块复用（文件素材展示）。** 卡片依赖 `LocalFileEntry`、预览队列及本机拖出接口；选区由回调归宿主管理，不能当作纯图片组件。装饰依赖 `.folder-media-preview` DOM 和对应 CSS，只负责几何与进入动画，不负责选择、键盘或列表布局；画布节点选中、hover 与多选不可混成同一状态。

## 在新创作入口保留统一编辑框与参数

- **共用表面与动效：** [IndustrialCanvas.css](../../apps/desktop/src/components/IndustrialCanvas.css) 的 `.creation-dock.composer-glass` 控制无框全息布局、左轨投影标签和内容自适应高度；[ComposerProjection.tsx](../../apps/desktop/src/components/creation/ComposerProjection.tsx) 仅负责鼠标穿透的局部渐隐上弧线、羽化中线贴合弧线并叠加椭圆衰减的 mask、呼吸方点及三层小叉视差（无竖直侧边，后景模糊 14.4px）；左轨内移与标签独立 6px 磨砂由共用 CSS 控制；`collapsed` 复用静态弧面，配合 54px 单行入口，观察尺寸／主题／可见性并在收起、隐藏和减少动态时停刷；投影高度排除入场平移，避免激活后底部露缝。底部间距共用 `CreationBoard.css` 的 `--composer-bottom-gap`（常规 12px／窄窗口 8px），素材库多选避让保留。[useTerminalCaret.ts](../../apps/desktop/src/components/creation/useTerminalCaret.ts) 使用 `useCreationEditor` 返回的 `viewRef` 与原生选区绘制窄块光标，不更改编辑器文档或选择。项目继续使用 `TacticalSelect` 与 `library-project-menu`；品牌与参数沿原选择器。独立 `.composer-references` 展示条已暂时移除；图片仅通过正文的引用 chip 呈现，继续复用 `BoardChipPreview`，顺序、删除与发送仍走编辑器。无添加素材按钮，Tab／双击维持原路径。宽度继续使用 `CreationBoard.css` 的 68%／1080px 上限；`LibraryComposer.css` 负责主屏贴底与多选避让。验证入口 `composer-projection-ui.test.mjs`、`composer-hud-ui.test.mjs`、`composer-header-ui.test.mjs` 与 `library-creation-parity-ui.test.mjs`，见 [记录](../../project_logs/2026-11-04-composer-projection.md)。
- **用途／关键词：** 创作输入、composer、图片／视频／对话、草稿、继续生成。
- **入口：** [CreativeComposer.tsx](../../apps/desktop/src/components/CreativeComposer.tsx) 的 `CreativeComposer` 管理三种模式各自草稿，内部嵌入 [CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx) 的 `CreationBoard`。优先按完整创作契约接入，而不是复制输入框 DOM。
- **实用证据：** [LibraryComposer.tsx](../../apps/desktop/src/components/LibraryComposer.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 都使用 `CreativeComposer`；[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 的继续编辑另用 [useCreationEditor.ts](../../apps/desktop/src/components/creation/useCreationEditor.ts) 的 `useCreationEditor`，与 `CreationBoard` 共用编辑核心。
- **范围／状态：可跨模块复用（桌面创作领域）。** 宿主必须提供草稿持久化、项目／线程解析及发送回调，组件仍依赖桌面 store、API、provider 与编辑器事件；不是通用富文本表单。`GenerationPanel` 带历史／续轮语义，不与首轮入口直接互换；普通文档编辑使用 Plate 文本工作区，不复用整个生成框。编辑核心、文档转换与引用约束见 [桌面逻辑地图](DESKTOP.md)。

## 保持主屏和画板的创作模式标记、图片手势一致

- **用途／关键词：** 创作状态、单击预览、双击引用、拖动抑制、迟到回包。
- **入口：** [CreationModeIndicator.tsx](../../apps/desktop/src/components/CreationModeIndicator.tsx) 的 `CreationModeIndicator`；行为用 [useCreationImageInteraction.ts](../../apps/desktop/src/components/useCreationImageInteraction.ts) 的 `useCreationImageInteraction`／`CreationImageTarget`，宿主只负责解析媒体归属与绑定 gesture。
- **实用证据：** [App.tsx](../../apps/desktop/src/App.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 都挂标记；后者调用手势 Hook，[useHomeCreationImage.ts](../../apps/desktop/src/components/useHomeCreationImage.ts) 适配主屏并由 [HomeWorkspace.tsx](../../apps/desktop/src/components/HomeWorkspace.tsx) 绑定事件。
- **范围／状态：可跨模块复用（普通浏览与创作模式图片）。** 标记不管理业务状态；Hook 依赖 `useStore`、素材 API、`BOARD_ASSET_PICK_EVENT` 及 `data-asset-id` 等媒体属性，并校验当前项目路由。普通模式图片立即预览，创作模式保留双击一次引用；只处理图片，保留修饰键、拖动、普通会话正文编辑和音视频原行为。主屏适配 `useHomeCreationImage` 本身不是其他板块的通用入口。
- **图片详情复用：** [CreationImagePreview.tsx](../../apps/desktop/src/components/CreationImagePreview.tsx) 左侧使用 [AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 的 `panelOnly` 与显式 `selection`，`initialAsset` 支持不在当前列表中的图片先显示元信息；详情数据和编辑仍走原接口。该模式直接展示信息，不挂载页签、再创作内容、详情页工具栏、原图或组内导航，也不重复读取生成历史；中间原图及右侧会话由预览宿主管理，独立详情默认保留原页签。「双击添加参考图」由共用 `CreationBoard` 的输入区底部留白展示，仅「双击」加粗；`CreationModeIndicator` 保留顶部创作状态。
- **预览续轮：** 私有 [ImagePreviewContinuation.tsx](../../apps/desktop/src/components/ImagePreviewContinuation.tsx) 保留独立文本草稿，复用 store 的显式 `sendGenRevise(jobId, ...)`／`cancelGeneration(jobId)`，不接管主创作编辑器。[imagePreviewContinuation.ts](../../apps/desktop/src/lib/imagePreviewContinuation.ts) 共用历史轮映射，发送时恢复真实任务与原项目／线程归属；歧义拒绝、路由／关闭作废及权益门控保持。预览订阅目标实时任务，继续用 `GenerationPanel` 的只读历史视图屏蔽依赖全局任务的操作，显式 `followLatest` 在续轮、图片加载及失败时跟随底部；其他调用默认保留原滚动行为。两侧收起均保持挂载以保留草稿与阅读位置。
- **自由图片舞台：** 同一预览支持普通导入图片，没有会话时只显示图片和详情。详情／会话均可独立收起，工具栏保留重开入口；详情保持挂载以保留未完成编辑和滚动位置。`CreationImagePreview.css` 仅在窗口边界裁切，图片与角标共同变换；预览私有 [useImagePreviewHud.ts](../../apps/desktop/src/components/useImagePreviewHud.ts) 按图片边界定位四组标题／控制，维持屏幕尺寸、窗口安全边距及侧面板避让，并将预览中心换算成每侧局部坐标作为共同旋转／透视原点，不作为跨模块布局接口。拖拽／滚轮只从图片开始，空白单击退出，按下／松手来源和移动距离防止拖图误关。外围投影线保留，面板及图片后层沿用 `ProjectManagerPanel.css`／`ProjectCreateCard.css` 的层叠与短闪语汇，不导入项目卡片内部逻辑；两侧正文与底板同属一个虚拟平面，选取／输入／键盘聚焦时共享姿态锁定，原图保持平面。缩放复用 [useImageZoom.ts](../../apps/desktop/src/lib/useImageZoom.ts) 的 `zoomBy`／`reset`；宿主显式允许 0.1–16 倍，原灯箱与普通详情仍默认 1–8 倍。已移除没有消费者的空白舞台滚轮参数。
- **渐进加载与渲染：** 图片先绘制，缩略图可先于原件显示；`AssetDetail.onReady(assetId)` 在首次分析、标签、集合读取全部 settled 后通知预览宿主，不等待 CLI 健康检查；独立详情另读生成来源。宿主按请求身份及图片入场状态显现两侧，`GenerationPanel` 的只读提示词视图延后挂载，固定投影区避免资料加载后重排。后景滤镜只保留两侧玻璃阅读面，全屏背景、点阵、四角控件和详情吸顶栏不再叠加滤镜。`useCompatibleImagePath(path, onError?)` 可选回调用于转换失败时释放图片加载门控，原调用保持兼容；旧详情页仍逐项呈现初始数据。`image-preview-rendering-ui.test.mjs` 核对滤镜范围、历史读取次数、空闲停刷及独立详情兼容；不代表高 GPU 负载下的原生帧率验收。

## 切换全部、标签和集合视图

- **用途／关键词：** 目录切换、整栏转场、catalog、素材栏、减少动态效果。
- **入口：** [LibraryCatalogTransition.tsx](../../apps/desktop/src/components/LibraryCatalogTransition.tsx) 的 `LibraryCatalogTransition`，按 `kind` 路由 `CategorizedLibrary`／`ConnectedCollections` 并管理退场层。
- **实用证据：** [LibraryHome.tsx](../../apps/desktop/src/components/LibraryHome.tsx) 和 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 共用该入口。
- **范围／状态：可跨模块复用（已有素材目录）。** 接口沿用 `CategorizedLibrary` props，DOM 与动画绑定目录侧栏及 `all/tags/collections` 语义；不能作为通用路由转场容器。内部 `floatSidebar` 等是模块内部专用，不独立导入或复制成其他板块动效。

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
