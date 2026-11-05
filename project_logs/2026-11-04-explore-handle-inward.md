# 探索把手移到面板内侧

1. 复核项目、视觉规范、探索契约与复用地图；沿用 PanelEdgeHandle，只修改探索宿主 CSS。按 UI skill 检索后采用遮挡／焦点可见性检查，不引入新控件或标签说明。
2. 在既有 `explore-handle-ui.test.mjs` 增加实际边界断言，修改前因把手越过探索面板右边缘失败。改为右侧内收，SVG 轮廓朝内，保留中央位置、14.4px 宽度和面板同色。
3. 独立原生 WebView 不能被 DOM z-index 覆盖，因此 viewport 内侧让出 20px，包含页签弧边及描线；已有 ResizeObserver 将缩小后的边界送到原生窗口，未修改原生实现或素材库把手。
4. 把手专项通过：控件及装饰均不越过面板、viewport 和真实发出的 resize IPC 避让、鼠标／键盘调宽、退出、Esc、重开保留宽度，以及共用素材库把手回归。深浅色截图经人工检查，位于 `apps/desktop/.tmp/explore-handle/`。
5. `explore-memory-ui.test.mjs` 和 Vite production build 通过。额外尝试旧 `explorer-ui.test.mjs`，它在加载主页面和样式之前的拖图注入阶段因空协议 JSON 失败，诊断 catch 又访问未初始化 calls；仅在内存里修正诊断打印确认原因，未修改无关旧测试，不计作通过。
6. ub-mode 的 crapper／dryer／mutator 对本轮生产 CSS 分别报告无可分析／变异的源码，记录为不适用；没有业务函数改动。用实际 DOM 几何、原生边界 IPC 和交互红绿回归验证。本轮未重新运行原生 WebView2 合成站点或真实账号验收。
7. 更新 PROJECT、探索文档与把手复用说明，提交时仅取本轮文档增量。未创建 worktree，也未删除其他任务目录或修改其暂存内容。此变更为前端样式热更新，不需重新构建或重启 EXE；未发布安装包。
