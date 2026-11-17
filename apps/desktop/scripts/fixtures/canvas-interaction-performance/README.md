# 画布交互性能夹具

复用真实 `CanvasWorkspace` 和 `CanvasWorkflowLayer`，封闭合成 IPC 创建 100 张素材、100 张内容卡和 100 张指令卡，并连接 100 条图片线及 100 条内容单元格文本线。不调用模型、不操作用户文件或数据库。

从 `apps/desktop` 运行：

```powershell
node scripts/canvas-interaction-performance-ui.test.mjs
```

测连续手势另用 `--motion`：每个真实动画帧派发一次输入，连续 48 帧，分别记录帧间隔中位数、P95、最慢帧以及 React 提交次数。`--large` 构造 1,002 张混合卡和 668 条连线，另在 20% 全貌下平移／缩放，核对视口内实际卡数、松手阶段最慢帧、导航未停时原生卡片命中。输出位于同一目录的 `motion*.json`。

```powershell
node scripts/canvas-interaction-performance-ui.test.mjs --motion
node scripts/canvas-interaction-performance-ui.test.mjs --motion --large --webview2
```

Windows 原生测试复用隔离的调试宿主；首次在 `apps/desktop/src-tauri` 运行 `cargo build --example audio_preview_smoke`。测试连接本机临时调试端口和独立 WebView2 资料目录，页面仍使用模拟 IPC。应单独运行计时项；并行构建、显示刷新率和系统负载都会影响数据。这些数值是浏览器动画回调间隔，不是硬件输入到屏幕出图的延迟。

输出 `.tmp/canvas-interaction-performance/after.json`。改动前复制完整 `src` 到 `.tmp/canvas-interaction-performance-before/src`，再运行 `--before` 保存对照。冻结目录不应覆盖；测试用 Vite 将源码依赖指向冻结目录。报告中的哈希来自 Vite 实际载入的 Workspace/Workflow 源文，不是运行末尾可能已被其他任务修改的文件。

Vite 仅在测试进程插入两个组件的 render 和 layout-effect commit 计数，不改业务源。夹具同时统计 document 级节点查询、端口查询、总边界读取、端口边界读取和 stage 边界读取。每项输入 48 个事件，分四组每组 12 次，事件派发包装在 `flushSync` 中，再留两次真实动画帧处理调度工作。React 仍可能合并部分 native-event commit，因此 render 与 commit 分开记录；这是可重复压力测试，不代表真实设备输入频率、原生帧率或完整应用性能。

功能断言覆盖平移累积、缩放指针锚点、素材/内容/工作流三类卡多选同步位移及持久化、未松手时内容端口与线端点误差、取消回滚、最后 move 未刷帧便 pointerup、Escape 清除未刷帧位移、同帧越过拖动阈值再返回不会误开预览、滚轮相机尚未 settle 就调用路由保存屏障、混合卡框选、吸附和引导线。拖动中让静止工作流卡通过 CSS 增高，检查未松手时吸附已更新；高度沿既有 offsetHeight 取整，允许小于 1px 的视觉边界差。after 另有同一任务内 wheel→resize 的实时缩放专项，不等待 120ms settle。首轮对照说明：React 已将部分高频输入合并成四次 commit；主要额外负担是工作流被反复求值时，每条内容线重复执行全局节点搜索和端口布局读取，不能简单把输入次数当作重绘次数。
