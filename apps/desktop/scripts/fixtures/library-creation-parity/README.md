# 主屏与画板创作交互回归

此夹具启动正式 App、HomeWorkspace、CanvasWorkspace 和创作框；仅替换 IPC 与素材数据，不实现第二套点击逻辑，不访问用户库或模型。

在 `apps/desktop` 运行 `node scripts/library-creation-parity-ui.test.mjs`。

`node scripts/library-creation-media-ui.test.mjs` 单独检查只有扩展名、缺原件路径的文本／音频继续使用原入口，避免被图片手势捕获。

`canvas-indicator-baseline.json` 冻结修复前 `8fead522` 的画板深浅色计算样式，包括边框、斜纹、角点与标签。测试先核对新画板仍符合该基线，再核对主屏与画板一致，防止两处一起变错。`indicator-signature.mjs` 只采集显示结果。

交互以已确认画板为准：创作态单击图片预览、双击仅插入一次引用；素材按钮与编辑框 Tab 聚焦素材栏，保留草稿。普通浏览、多选、拖动、切换页面及异步回包边界由正式组件驱动验证。主屏预览和添加引用不创建项目或提交生成。

画板完整图片与会话回归仍由 `scripts/canvas-creation-image-ui.test.mjs` 覆盖；生成与通知回归保持在 `library-generation-*` 专项。浏览器隔离验收不等同于原生安装包或 Mac 实机验收。
