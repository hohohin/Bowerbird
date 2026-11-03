# 标注文字输入调整操作日志

1. 读取 ub-mode、项目现状、架构与工业界面规范；检查工作区，发现大量其他任务修改，限定本次文件范围。
2. 查询 Fabric.js Textbox 官方文档，确认其原位编辑与自动换行能力；为保留当前镜像、裁剪和导出数据链路，本次不替换渲染引擎。
3. 修改行为测试，先验证旧实现失败于“点击图片前不应出现文本框”（实际 1，期望 0）。
4. 删除顶部文字输入和预填放置逻辑；独立原位编辑组件，输入/排版/样式局部管理，提交时产生一个撤销快照。
5. 加入文本框宽度拖动、自动换行、已有文字点击重编辑、IME Escape 保护、Esc 取消和 Ctrl/Command+Enter 完成；外部点击及保存提交编辑。
6. 首轮回归发现 SVG 字形间空白区域无法点选；改为文字包围框命中，完整回归通过。
7. 补测文本框拖动、软换行导出、编辑中保存、一次撤销恢复；草稿与素材两种入口均通过，既有镜像/旋转/裁剪像素回归继续通过。
8. 完整 TypeScript 与独立 Vite 构建通过；构建仍有原有大 chunk 提示。检查编辑中截图，确认样式栏与输入框位于图片内。
9. 检查工作树清单，现有工作树均非本任务创建且可能在用，不删除。crapper、dryer、mutator 在当前工具和项目中未发现，未宣称完成这些工具的评分或变异测试。
10. 仅提交本次组件、交互测试、PROJECT 增量与本日志，保留其他工作区修改；按用户调用的 ub-mode 提交推送流程执行。不打包发布，不操作用户素材库。

验证命令：
- `node scripts/annotation-tools-ui.test.mjs`
- `node node_modules/typescript/bin/tsc --noEmit`
- `node node_modules/vite/bin/vite.js build --outDir .tmp/annotation-inline-build`

截图：`apps/desktop/.tmp/annotation-inline-draft.png`、`apps/desktop/.tmp/annotation-inline-asset.png`（本机测试产物，不纳入提交）。

成熟方案参考：https://www.fabricjs.com/api/classes/textbox/
