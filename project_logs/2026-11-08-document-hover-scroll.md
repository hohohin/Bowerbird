# 画板文本卡片滚动预览

复用 DocumentCardPreview，增加可选 scrollable，仅画板开启。正文独立上下滚动，普通滚轮不冒泡至画板，到边界也不平移；Ctrl／Meta 保留缩放。documentPreviewText 默认仍提取 1200 字，画板传 Infinity 获取完整正文。标题、格式、端口与双击编辑维持原行为。

验证：canvas-document-scroll-ui.test.mjs 使用真实画板隔离 fixture，160 段正文、正反向滚动、滚动边界画板 transform 不变及双击进入编辑器通过。保留工作区其他任务改动；未打包发布。
