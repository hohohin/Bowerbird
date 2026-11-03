# 素材库分栏按钮确认稿

状态：用户确认修正后的分界线位置，已接入正式 LibraryHome／LibrarySplit，源码待发布。

- 单栏：右上角分栏图标替代无用途的禁用关闭按钮。
- 多栏：每条分界线上显示原 Columns2 分栏图标，按钮中心与分界线中心重合，左右各半进入相邻栏。点击在此处插入新栏，沿用左栏浏览状态的独立副本。
- 每栏右上仅保留 X；关闭至单栏恢复右上分栏图标。分界线其余位置仍支持拖动、双击均分和键盘调宽。
- 用户纠正后，已舍弃最初「X 右侧加号」候选；不使用 Plus 图标。

从 `apps/desktop` 启动 `node scripts/fixtures/library-pane-actions/serve.mjs`，访问：

`http://127.0.0.1:17934/scripts/fixtures/library-pane-actions/preview.html`

浅色追加 `?theme=light`。追加 `?live` 查看正式组件，`?live&theme=light` 查看正式浅色版。预览复用现有 Toolbar、Catalog 及封闭合成素材，默认加载确认稿外壳，`live` 只加载正式组件，不加载候选 CSS；未操作用户库。

`node scripts/library-pane-actions-ui.test.mjs` 默认验证正式组件，传 `--preview` 验证确认稿。正式组件先红后绿，覆盖单栏入口、分界居中、左右半区命中、关闭／分栏命中区不交叠、相邻插栏、恢复单栏、键盘激活、指针／键盘调宽、窄屏及三种视图导航命中。截图位于 `.tmp/library-pane-actions/`，深浅色已目检。文本浏览回归、完整 TypeScript 检查与独立 Vite 构建通过。

独立审查发现关闭按钮原右距 8px 会与跨界按钮重叠 3px；分栏时改为 16px，并为导航相应预留空间。按钮与调宽 separator 是兄弟节点，避免点击分栏时启动调宽。

验证过程及交付边界见 [行动记录](../../../../../project_logs/library-pane-actions.md)。
