# 2026-11-03 素材库入口与集合行宽度修正

本记录对应本轮素材库反馈第 4、5 项；未涉及其他任务的拖出、单文件接收和断联数据处理。未提交或推送，未操作用户真实素材库。

## 复用与范围

- 入口位于 `apps/desktop/src/components/Toolbar.tsx`。复用 `canvasLibraryOpen` / `setCanvasLibraryOpen`、现有 `useLocalFileMode.openSource("global")` / `setOpen(false)`、引导操作 `expand-source` 与原有 `connectFolder`；没有新建素材数据源。
- 画板顶部左侧首先显示「素材库」，点击展开已有素材栏，展开后在旁边显示「建立连接」。再次点击可以收起。首页与探索页的连接入口保留原行为。
- `ConnectedCollections.css` 原先无条件为名称预留 48px，覆盖了 `CategorizedLibrary.css` 已有的悬浮／键盘焦点／菜单展开样式。删除该覆盖，空闲行让名称使用完整可用宽度。
- `ConnectedCollections.tsx` 为正在显示菜单的目录行补上已有的 `is-menu-open` 状态，鼠标离开后仍保留操作按钮和名称避让。没有调整其他视觉样式或菜单操作。

## RED → GREEN

新增 `apps/desktop/scripts/library-controls-ui.test.mjs`，挂载既有隔离预览中的真实 Toolbar、画板素材栏与 ConnectedCollections。测试先复现两个产品问题：

1. 素材栏关闭时，「建立连接」数量实际为 1、预期 0。
2. 120px 窄侧栏中的空闲集合名称右内边距实际为 48px、预期 0。

测试搭建阶段曾尝试直接触发预览 mock 的通用变更通知，导致无关监听器接收到不匹配 payload；改为通过真实重命名菜单设置长名称。最终 RED 来自上述两个产品断言，实施修正后两个场景均通过，浏览器错误为空。

验证命令（目录 `apps/desktop`）：

- `node scripts/library-controls-ui.test.mjs`：通过。覆盖开关素材栏、连接按钮相邻位置、Enter 键开启、首页入口保留；窄侧栏空闲、hover、键盘 focus、菜单开启及关闭后的名称宽度。
- `node scripts/connected-collections-ui.test.mjs`：通过。既有目录顺序、连续浏览、分身操作、重命名／回收站、新建集合、折叠与滚动、断开、选择器和视图切换回归保持通过。
- 三个生产文件的 `git diff --check`：通过。

## 视觉证据与边界

真实组件的深浅主题截图保存在 `apps/desktop/.tmp/library-controls/`：`canvas-open-dark.png`、`canvas-open-light.png`、`collection-idle-dark.png`、`collection-hover-dark.png`、`collection-idle-light.png`。结果文件为同目录 `result.json`。

这些验证使用独立浏览器、内存 mock 与本机 Vite，未调用真实文件夹连接或更改磁盘素材。没有重启用户程序。完整 TypeScript／构建和本轮质量工具扫描由主任务统一执行。
