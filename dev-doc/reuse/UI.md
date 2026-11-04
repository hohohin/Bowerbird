# UI、布局与交互复用

[返回复用地图](../Bowerbird开发计划.md#复用地图)。本页按 2026-11-03 当前工作区源码核对，包含未提交实现；状态表示可用边界，不表示已发版。视觉规则和样式加载顺序仍以 [UI-DESIGN-SPEC 第 11 节](../UI-DESIGN-SPEC.md#11-实现入口与使用顺序) 为入口，不在这里复制色值与动效规范。

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

- **用途／关键词：** select、listbox、选项组、方向键、输入定位、禁用。
- **入口：** [TacticalSelect.tsx](../../apps/desktop/src/components/TacticalSelect.tsx) 的 `TacticalSelect`／`TacticalSelectProps`；传 `<option>`／`<optgroup>`，接 `onValueChange`，值统一为字符串。解析、方向导航与定位由同目录 [tacticalSelectLogic.ts](../../apps/desktop/src/components/tacticalSelectLogic.ts) 提供，消费者优先用组件。
- **实用证据：** [LibraryComposer.tsx](../../apps/desktop/src/components/LibraryComposer.tsx) 的项目选择；[AssetDetail.tsx](../../apps/desktop/src/components/AssetDetail.tsx) 的详情选择；[CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 的画板选择。
- **范围／状态：可跨模块复用。** 普通单选与键盘交互；菜单视觉由 `IndustrialMenus.css` 最终覆盖。它是按钮 + listbox，非原生 `<select>`，有 `name` 才输出隐藏表单值；不承担动作子菜单、模型计费信息或任意富内容选择。当前弹层直接挂 `document.body`，局部焦点边界见下文。

## 添加右键菜单与动作子菜单

- **用途／关键词：** context menu、右键、操作、删除子菜单、焦点恢复。
- **入口：** [ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 的 `ContextMenu`、`ContextSubmenu`、`DeleteSubmenu`；宿主提供坐标、关闭回调、`button[role="menuitem"]` 与禁用状态。
- **实用证据：** [AssetContextMenu.tsx](../../apps/desktop/src/components/AssetContextMenu.tsx) 使用子菜单和删除分组；[ProjectContextMenu.tsx](../../apps/desktop/src/components/ProjectContextMenu.tsx) 使用同一菜单壳。
- **范围／状态：可跨模块复用。** 共用边缘定位、菜单家族互斥、键盘／外部点击关闭和滚动包装；`ContextSubmenu` 必须位于该菜单 Context 内。`AssetContextMenu`／`ProjectContextMenu` 自身绑定素材、项目和 store 行为，是领域入口，不作其他业务的通用菜单模板。

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
- **入口：** [OverlayScrollbars.tsx](../../apps/desktop/src/components/OverlayScrollbars.tsx) 的 `OverlayScrollbars`／`enableOverlayScrollbars` 是唯一管理器；需要现成 viewport／content 结构时用 [CollectionScrollArea.tsx](../../apps/desktop/src/components/CollectionScrollArea.tsx) 的 `OverlayScrollArea`，集合特化包装为 `CollectionScrollArea`。
- **实用证据：** [main.tsx](../../apps/desktop/src/main.tsx) 挂载全局 `OverlayScrollbars`；[ContextMenu.tsx](../../apps/desktop/src/components/ContextMenu.tsx) 和 [CanvasDocumentCard.tsx](../../apps/desktop/src/components/CanvasDocumentCard.tsx) 使用 `OverlayScrollArea`。
- **范围／状态：可跨模块复用。** 根入口与包装器引用计数共享 manager，普通滚动元素在主应用中无需每处另挂管理器；独立包装器会自行启用。`scrollRef` 指向真实 viewport，保留虚拟列表绑定；包装器不负责虚拟化。共用 CSS 由管理器文件导入；不能把它理解为控制原生 WebView／外部网页滚动条的接口。

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

- **共用表面与动效：** [IndustrialCanvas.css](../../apps/desktop/src/components/IndustrialCanvas.css) 的 `.creation-dock.composer-glass` 控制左轨光学 HUD、19px 羽化、26px 后景毛玻璃与展开动效；项目仍使用 `TacticalSelect`；模式选中与关闭共用线框 CSS，比例及上限共用 `CreationBoard.css` 的 `--composer-width`（82%）／`--composer-max-width`（1238px），实际取较小值。`CreationBoard` 的 `.composer-hud-surface`／`-optics` 是鼠标穿透的材质与两侧偏振层，不包裹正文或裁切根元素。`.composer-references` 只投影现有 `useCreationEditor.references`，缩略图复用 `MediaPreview`，悬停／点击定位复用 `BoardChipPreview`，删除仍走原编辑器；不另存引用数组。`.composer-writing` 保留无障碍标题、放大编辑／历史及底部 `.composer-reference-hint`，提示不另占行，品牌图标展开原 `VisualProfileSelect`；框内无创作状态文字。关闭仅收起保稿。[LibraryComposer.css](../../apps/desktop/src/components/LibraryComposer.css) 继续负责主屏贴底与多选避让。正式组件验证入口 `scripts/composer-hud-ui.test.mjs` 和 `scripts/composer-header-ui.test.mjs`，细节见 [记录](../../project_logs/2026-11-04-composer-optical-hud.md)。
- **用途／关键词：** 创作输入、composer、图片／视频／对话、草稿、继续生成。
- **入口：** [CreativeComposer.tsx](../../apps/desktop/src/components/CreativeComposer.tsx) 的 `CreativeComposer` 管理三种模式各自草稿，内部嵌入 [CreationBoard.tsx](../../apps/desktop/src/components/CreationBoard.tsx) 的 `CreationBoard`。优先按完整创作契约接入，而不是复制输入框 DOM。
- **实用证据：** [LibraryComposer.tsx](../../apps/desktop/src/components/LibraryComposer.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 都使用 `CreativeComposer`；[GenerationPanel.tsx](../../apps/desktop/src/components/GenerationPanel.tsx) 的继续编辑另用 [useCreationEditor.ts](../../apps/desktop/src/components/creation/useCreationEditor.ts) 的 `useCreationEditor`，与 `CreationBoard` 共用编辑核心。
- **范围／状态：可跨模块复用（桌面创作领域）。** 宿主必须提供草稿持久化、项目／线程解析及发送回调，组件仍依赖桌面 store、API、provider 与编辑器事件；不是通用富文本表单。`GenerationPanel` 带历史／续轮语义，不与首轮入口直接互换；普通文档编辑使用 Plate 文本工作区，不复用整个生成框。编辑核心、文档转换与引用约束见 [桌面逻辑地图](DESKTOP.md)。

## 保持主屏和画板的创作模式标记、图片手势一致

- **用途／关键词：** 创作状态、单击预览、双击引用、拖动抑制、迟到回包。
- **入口：** [CreationModeIndicator.tsx](../../apps/desktop/src/components/CreationModeIndicator.tsx) 的 `CreationModeIndicator`；行为用 [useCreationImageInteraction.ts](../../apps/desktop/src/components/useCreationImageInteraction.ts) 的 `useCreationImageInteraction`／`CreationImageTarget`，宿主只负责解析媒体归属与绑定 gesture。
- **实用证据：** [App.tsx](../../apps/desktop/src/App.tsx) 与 [CanvasWorkspace.tsx](../../apps/desktop/src/components/CanvasWorkspace.tsx) 都挂标记；后者调用手势 Hook，[useHomeCreationImage.ts](../../apps/desktop/src/components/useHomeCreationImage.ts) 适配主屏并由 [HomeWorkspace.tsx](../../apps/desktop/src/components/HomeWorkspace.tsx) 绑定事件。
- **范围／状态：可跨模块复用（创作模式图片）。** 标记不管理业务状态；Hook 依赖 `useStore`、素材 API、`BOARD_ASSET_PICK_EVENT` 及 `data-asset-id` 等媒体属性，并校验当前项目路由。只处理图片，保留修饰键和拖动语义；普通浏览／音视频操作不应接管到此 Hook。主屏适配 `useHomeCreationImage` 本身不是其他板块的通用入口。

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
