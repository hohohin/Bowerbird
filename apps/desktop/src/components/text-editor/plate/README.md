# Plate EditorKit

以 [Plate 官方 EditorKit registry](https://platejs.org/r/editor-kit.json) 为来源，递归复用其公开 MIT 组件，并加入官方 Excalidraw 组件。缓存来源、原始响应 SHA-256 与文件列表见 `provenance.json`；许可证见 `LICENSE.md`。不是 Plate Plus 模板。

本目录保留上游 kit / UI / primitives 结构。主要适配：

- React 18 的 `forwardRef` 与稳定组合 ref；应用主题、中文菜单和工作区 portal。
- `use-chat.ts` 使用应用的 `TextEditorServices`，沿用 Codex CLI / Cloud DSH；不含示例服务端、假回复或新增 runner。
- 评论、修订、提及限本机文档；清除演示用户与预置讨论，通过 `documentState.ts` 保存。
- 媒体上传走应用已有导入，附件走本机受控命令；不用 UploadThing 或示例上传服务。
- 文档导入已移除；剪贴板解析和素材插入保留。导出支持 Markdown / HTML / PNG / PDF / Word。`textEditorExport*` 位于上一级。
- Mermaid / Graphviz / Flowchart 与 Excalidraw 在本机渲染。PlantUML 的在线预览由用户显式点击触发。Excalidraw 字体由 Vite 插件本地提供。
- 表格拆分修复 Plate 53.0.9 单单元格选区被过滤的问题；字号输入保留真实选区，弹层关闭不夺回焦点。

`utilities.css` 是已提交的生成文件。修改类名后在 `apps/desktop` 执行 `pnpm build:text-editor-css`。Tailwind 4 仅生成编辑器作用域的 CSS，应用原有 Tailwind 3 不变。

正式入口：`TextPlateEditor.tsx`。验收矩阵、持久化协议和限制见仓库 `dev-doc/TEXT-LIBRARY.md` 与 `project_logs/2026-11-06-text-editor-demo.md`。上游组件沿用其结构；质量工具集中检查应用适配与数据边界，未将全部上游代码改写成项目风格。
