# Pinterest 页面与探索把手调整

## 范围与行动

1. 阅读 PROJECT、架构／复用地图、内置浏览器专项和视觉规范，沿用 ub-mode，并用 ui-ux-pro-max 核对键盘与拖动替代操作。复用决定：素材库页签和滚动条只保留一份实现，宿主继续管理各自状态。
2. 检查当前 Pinterest 公开页面及其实际引用的 `_client-7485c070a3e35508.js`，结合此前公开 bundle 的 `VerticalNavContent`／72px 导航结构。正文采用 `.mainContainer` 父元素的站点原始 inline inset，展开侧栏时只减去 36px；不重写网页导航或结果数据。
3. 先补行为测试：探索把手旧版本因贯穿高度失败；原生 WebView2 在 360px 窗口只剩 345px 内容宽度，明确复现 15px 滚动槽（`.tmp/pinterest-layout-native-1793760045154/result.json`，桌面目录内）。探索夹具补齐已有快传状态，排除与此功能无关的初始化崩溃。
4. 提取 `PanelEdgeHandle`，素材库保留原控制逻辑；探索用同款 ESC／退出与握柄，移除原工具栏重复关闭按钮，拖动使用起始宽度与指针差值，避免外置握柄导致跳宽。保留左右键、Home／End、双击默认宽度，关闭后宽度保持。
5. 将原 OverlayScrollbars 的 DOM 管理器迁到无 React／IPC 的共享脚本，React 包装器保留原引用计数入口；补文档根滚动坐标和事件目标。原生 Pinterest 注入同一脚本与原 CSS，没有新增 IPC。只在精确 HTTPS Pinterest 顶层文档启用；SPA 侧栏消失时移除自有缩进标记。
6. 运行浏览器、原生、类型与打包验证，审查深浅色及 320／460／900px 截图。测试环境显式启用系统滚动条，不用无头默认隐藏效果冒充零占宽。
7. 使用 crapper、dryer、mutator 检查本次代码；复杂的侧栏更新拆为 inset 标记、集合计算和更新三个小函数。复用地图、专项与 PROJECT 同步记录现行边界。
8. 核对开发实例：PID 24256，2026-11-04 10:53:44 启动，运行默认 `target/debug/bowerbird-desktop.exe`；文件在 10:53:41 更新，完整包含最终 Pinterest chrome 和共享滚动脚本，SHA256 `41fbe44d3968c1e57b222113c35f207b8f894ffc7184fcbf1b88289747f40323`。监视器已自动重建／重启，无需再次中断用户界面。

## 验证

- `explore-handle-ui.test.mjs`：探索与素材库的实际组件，鼠标／键盘调宽、接缝、单一退出、Esc、重新打开宽度保留，均通过。
- `pinterest-chrome.test.mjs`：三档宽度的零占宽／无横向溢出、36px 导航、原生按钮与展开侧栏、4px 斜纹与淡出、根文档拖动／键盘／滚轮、嵌套滚动、SPA 清理及域名隔离，通过。
- `overlay-scrollbar-adapter-ui.test.mjs`、`overlay-scrollbars-screenshot-ui.test.mjs`：共享拥有者、包装器和独立截图入口回归通过。`overlay-scrollbars-preview-ui.test.mjs` 的双轴、轨道／滑块／键盘、textarea／编辑器、portal、缩放／裁切、虚拟列表滚轮映射、inert 与卸载清理也全部通过。
- `cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example pinterest_search_smoke` 成功。最终 `pinterest-layout-native.test.mjs` 通过，证据 `apps/desktop/.tmp/pinterest-layout-native-1793761047697/result.json`；含真实初始化／调宽、分页、路由恢复、自动上传后进入结果和零占宽断言。Rust 留有已有 unused warnings。
- `pnpm exec tsc --noEmit`、`pnpm exec vite build` 通过，构建保留已有 chunk 大小／动态导入提示。

## 质量与边界

- crapper 使用实际注入脚本的 V8 覆盖率，保留声明原字节位置的探针仅供度量、不执行；新增／调整的 native 辅助函数最高 CRAP 7.8，原管理器未修改的 wheel／key／motion／visibleBounds 仍有覆盖缺口，不声称全文件质量门禁通过。dryer 在共享 DOM／native 辅助函数中无 0.8 以上重复候选。官方 mutator 的三个定向变异（缩进减法、域名条件、文档滚动目标）均被行为断言杀死；没有运行全量变异。证据 `.tmp/pinterest-chrome/quality/`。
- 旧 `canvas-library-resize-ui.test.mjs` 使用过期「我的项目」入口；临时改入口后首先误选新探索把手，限定画板范围后失败于旧阴影断言，替换为 HEAD 原控件仍同样失败。未修改这份旧测试，新增测试直接覆盖本次共用把手。旧完整应用滚动测试也依赖原首页／项目菜单状态，临时走当前入口后菜单滚动等待失败；未声称全量旧 UI 测试通过。`explorer-sidebar-ui.test.mjs` 的旧自动隐藏条件也未通过，不作为本次通过证据。
- 浏览器／原生站点内容为拦截的合成页面，没有上传真实用户素材、读取 Cookie 或修改账号；真实 Pinterest 账号的全部页面变体与 Mac 尚未验收。当前仅源码与本机开发实例，无安装包发布。
- 临时测试副本不修改生产模块；本轮没有创建 worktree，不清理其他聊天的在用工作区。提交仅包含本次源文件、测试和文档，其他聊天的创作界面改动保持原归属。
