# 图片标注与截图复用入口

当前状态与行为以 [PROJECT.md](../../PROJECT.md) 为准，验证见 [操作记录](../../project_logs/2026-11-05-annotation-screenshot-reuse.md)。两个调用方为 `ImageAnnotator` 与 `ScreenshotWindow`，源码均位于 `apps/desktop/src`。

| 能力 | 公共入口 |
|---|---|
| 十种绘制工具、图标、名称与提示 | `components/AnnotationTools.tsx` |
| 拖绘、Shift 约束、折线、待提交内容与取消 | `lib/useAnnotationDrawing.ts` |
| 全分辨率合成、独立临时层、透明区域效果预览 | `lib/useAnnotationCanvas.ts` |
| 归一化形状、色板、绘制、文字排版与结算 | `lib/annotation.ts` |
| 文字输入、浮动样式栏、文本宽度调整 | `components/AnnotationTextEditor.tsx` |
| 独立撤销／重做、命中描边与滚轮合并撤销 | `lib/useAnnotationHistory.ts`、`lib/useAnnotationStrokeWheel.ts` |

宿主提供原图、尺寸和归一化落点，形状线宽／字号相对图片宽度。每个编辑器拥有自己的历史和绘制状态；图片宿主负责裁剪／旋转／镜像、来源身份和元数据转换，截图宿主负责捕获／像素选区／系统输出。不得直接将归一化 `DrawShape` 当作持久化的 0–999 `AnnotationShape`。

新增绘制工具同时更新公共类型、工具组与 renderer，验证两处真实组件。图片预览和输出使用同一绘制核心；原图含 alpha 时只合成一次，区域效果临时层替换已提交层。不得恢复图片标注的独立 SVG 绘制分支。
