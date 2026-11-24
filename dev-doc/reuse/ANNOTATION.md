# 图片标注与截图复用入口

[返回复用地图](../Bowerbird开发计划.md#复用地图)。2026-11-23 更新。

`api.saveAnnotatedImage` 的覆盖与标注修订复用 `folder_connections::mutation` 的目录修改锁及素材／文件变更事件。[library_annotation.rs](../../apps/desktop/src-tauri/src/commands/library_annotation.rs) 按已登记素材身份替换，核对编辑时读取的 SHA-256，并负责原格式编码、同目录原子替换、失败还原和分析记录事务。主动「覆盖原文件」保存烧录后的定稿。原路径、ID 和归属保留，旋转、镜像或裁剪即使没有绘制形状也记录。[覆盖操作记录](../../project_logs/2026-11-10-annotation-overwrite.md)

画板沿 `CanvasWorkspace` 现有变更通知、读取屏障和 `hydrateProjectCanvas` 更新图片比例，素材库沿 `useCatalogRevision` 失效缓存。`CanvasImage` 使用唯一 `thumbPath` 作为原图／分级预览内容版本，`requestCanvasImagePreview(path, maxSize, version?)` 按版本隔离未完成请求；固定原路径的同尺寸镜像也会重新加载。不能仅改数据库宽高而复用旧图片 URL。验证与格式边界见 [覆盖操作记录](../../project_logs/2026-11-10-annotation-overwrite.md)。

当前状态与行为以 [PROJECT.md](../../PROJECT.md) 为准，验证见 [操作记录](../../project_logs/2026-11-05-annotation-screenshot-reuse.md)。两个调用方为 [ImageAnnotator](../../apps/desktop/src/components/ImageAnnotator.tsx) 与 [ScreenshotWindow](../../apps/desktop/src/components/ScreenshotWindow.tsx)，源码均位于 `apps/desktop/src`。

下表公共入口可在桌面标注领域复用。平移、底图变换和编辑文档由 `ImageAnnotator` 使用，其他入口由两个宿主调用。

| 能力 | 公共入口 |
|---|---|
| 十种绘制工具、图标、名称与提示 | [AnnotationTools.tsx](../../apps/desktop/src/components/AnnotationTools.tsx) |
| 拖绘、Shift 约束、折线、待提交内容与取消 | [useAnnotationDrawing.ts](../../apps/desktop/src/lib/useAnnotationDrawing.ts) |
| 全分辨率合成、增量位图缓存、独立临时层、透明区域效果预览 | [useAnnotationCanvas.ts](../../apps/desktop/src/lib/useAnnotationCanvas.ts) |
| 归一化形状、色板、绘制、文字草稿、排版与结算 | [annotation.ts](../../apps/desktop/src/lib/annotation.ts) 的 `DrawShape`、`drawShapes`、`createTextDraft`、`applyTextEdit` |
| 文字输入、浮动样式栏、文本宽度调整 | [AnnotationTextEditor.tsx](../../apps/desktop/src/components/AnnotationTextEditor.tsx) |
| 独立撤销／重做、命中描边与滚轮合并撤销 | [useAnnotationHistory.ts](../../apps/desktop/src/lib/useAnnotationHistory.ts)、[useAnnotationStrokeWheel.ts](../../apps/desktop/src/lib/useAnnotationStrokeWheel.ts) |
| 输入框、表单控件、输入法组合态的快捷键过滤 | [isEditableKeyTarget.ts](../../apps/desktop/src/lib/isEditableKeyTarget.ts) |
| 选区和裁剪框的浮条停靠与尺寸监听 | [floatingToolbar.ts](../../apps/desktop/src/lib/floatingToolbar.ts)、[useFloatingToolbarSize.ts](../../apps/desktop/src/lib/useFloatingToolbarSize.ts) |
| 将最终图像形状转为 0–999 坐标和创作引用 token | [annotationMetadata.ts](../../apps/desktop/src/lib/annotationMetadata.ts) 的 `toAnnotationShapes`。截图先用 `cropAnnotationShapes` 转为选区坐标 |
| 图片视图平移、指针捕获、方向键移动与复位 | [useImageZoom.ts](../../apps/desktop/src/lib/useImageZoom.ts) 的 `onPointerDown`／`panBy`／`reset`；`ImageAnnotator` 固定缩放为 1，仅使用平移 |
| 图片旋转、镜像及裁剪的像素和坐标变换 | [annotationTransforms.ts](../../apps/desktop/src/lib/annotationTransforms.ts) 的 `opPoint`、`opDims`、`mapShape`、`buildBaseCanvas` |
| 读取标注编辑文档、核验底图版本、重建草稿底图 | [annotationDocument.ts](../../apps/desktop/src/lib/annotationDocument.ts) 的 `loadAnnotationImage` 和 `blankAnnotationImage` |

宿主提供原图、尺寸和归一化落点，形状线宽／字号相对图片宽度。每个编辑器拥有自己的历史和绘制状态；图片宿主负责裁剪／旋转／镜像、来源身份和元数据转换，截图宿主负责捕获／像素选区／系统输出。不得直接将归一化 `DrawShape` 当作持久化的 0–999 `AnnotationShape`。

视图平移统一作用于底图、标注、文本编辑器与裁剪框的父层，不写入图像变换或撤销快照；落点从移动后的 SVG 边界归一化。宿主先区分绘制与手形／空格／中键移动，再将指针交给共用 hook。`useImageZoom` 原有 `onMouseDown` 与缩放接口继续供灯箱、图片详情和创作预览使用，两类输入按指针身份隔离。

新增绘制工具同时更新公共类型、工具组与 renderer，验证两处真实组件。图片预览和输出使用同一绘制核心；原图含 alpha 时只合成一次，区域效果临时层替换已提交层。不得恢复图片标注的独立 SVG 绘制分支。

已提交画布缓存底图和不可变形状序列。新增笔画沿现有位图继续绘制；底图或尺寸变化、撤销、删除、修改已有形状和提交橡皮擦时重放。宿主应保留未修改形状的对象身份，并为修改后的形状创建新对象。

可编辑标注保存烧录图和 `AnnotationMeta.editable`。`editable.shapes` 保留浮点坐标和文字样式，`transform` 记录底图操作。草稿保存底图尺寸与背景，普通标注保存干净原图的素材身份、路径和 SHA-256。编辑时读取最新标注记录，核验版本后恢复底图和形状。原图变更或失联时提示后从当前烧录图继续。保存修订沿原素材身份更新；旧记录可从烧录图继续标注。

截图工具栏、历史和钉图均使用 `action: "canvas"`。截图窗口只提交图片及标注，原生通过 `screenshot://canvas` 向主窗口转发并等待回执。主窗口按 `prepareCanvasAnnotation` 冻结项目与视口中心，复用已有的建卡、写入队列和画板撤销。没有可用画板时保存到素材库并提示。截图历史保留可供创作引用的坐标元数据。
