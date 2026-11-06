# 图片标注与截图复用入口

[返回复用地图](../Bowerbird开发计划.md#复用地图)。2026-11-06 复核。

当前状态与行为以 [PROJECT.md](../../PROJECT.md) 为准，验证见 [操作记录](../../project_logs/2026-11-05-annotation-screenshot-reuse.md)。两个调用方为 [ImageAnnotator](../../apps/desktop/src/components/ImageAnnotator.tsx) 与 [ScreenshotWindow](../../apps/desktop/src/components/ScreenshotWindow.tsx)，源码均位于 `apps/desktop/src`。

下表入口状态均为 **可跨模块复用（桌面标注领域）**；文件名去扩展名即主要组件／Hook 符号，`annotation.ts` 使用 `DrawShape`、`drawShapes`、`applyTextEdit`。前六项均由上述两个宿主实际调用；平移 Hook 的标注调用方为 `ImageAnnotator`，截图不承担同一平移流程。用途列同时作为搜索关键词。

| 能力 | 公共入口 |
|---|---|
| 十种绘制工具、图标、名称与提示 | [AnnotationTools.tsx](../../apps/desktop/src/components/AnnotationTools.tsx) |
| 拖绘、Shift 约束、折线、待提交内容与取消 | [useAnnotationDrawing.ts](../../apps/desktop/src/lib/useAnnotationDrawing.ts) |
| 全分辨率合成、独立临时层、透明区域效果预览 | [useAnnotationCanvas.ts](../../apps/desktop/src/lib/useAnnotationCanvas.ts) |
| 归一化形状、色板、绘制、文字排版与结算 | [annotation.ts](../../apps/desktop/src/lib/annotation.ts) |
| 文字输入、浮动样式栏、文本宽度调整 | [AnnotationTextEditor.tsx](../../apps/desktop/src/components/AnnotationTextEditor.tsx) |
| 独立撤销／重做、命中描边与滚轮合并撤销 | [useAnnotationHistory.ts](../../apps/desktop/src/lib/useAnnotationHistory.ts)、[useAnnotationStrokeWheel.ts](../../apps/desktop/src/lib/useAnnotationStrokeWheel.ts) |
| 图片视图平移、指针捕获、方向键移动与复位 | [useImageZoom.ts](../../apps/desktop/src/lib/useImageZoom.ts) 的 `onPointerDown`／`panBy`／`reset`；`ImageAnnotator` 固定缩放为 1，仅使用平移 |

宿主提供原图、尺寸和归一化落点，形状线宽／字号相对图片宽度。每个编辑器拥有自己的历史和绘制状态；图片宿主负责裁剪／旋转／镜像、来源身份和元数据转换，截图宿主负责捕获／像素选区／系统输出。不得直接将归一化 `DrawShape` 当作持久化的 0–999 `AnnotationShape`。

视图平移统一作用于底图、标注、文本编辑器与裁剪框的父层，不写入图像变换或撤销快照；落点从移动后的 SVG 边界归一化。宿主先区分绘制与手形／空格／中键移动，再将指针交给共用 hook。`useImageZoom` 原有 `onMouseDown` 与缩放接口继续供灯箱、图片详情和创作预览使用，两类输入按指针身份隔离。

新增绘制工具同时更新公共类型、工具组与 renderer，验证两处真实组件。图片预览和输出使用同一绘制核心；原图含 alpha 时只合成一次，区域效果临时层替换已提交层。不得恢复图片标注的独立 SVG 绘制分支。
