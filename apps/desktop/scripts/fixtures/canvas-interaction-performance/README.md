# 画布交互性能夹具

复用真实 `CanvasWorkspace` 和 `CanvasWorkflowLayer`，封闭合成 IPC 创建 100 张素材、100 张内容卡和 100 张指令卡，并连接 100 条图片线及 100 条内容单元格文本线。不调用模型、不操作用户文件或数据库。

从 `apps/desktop` 运行：

```powershell
node scripts/canvas-interaction-performance-ui.test.mjs
```

输出 `.tmp/canvas-interaction-performance/after.json`。改动前复制完整 `src` 到 `.tmp/canvas-interaction-performance-before/src`，再运行 `--before` 保存对照。冻结目录不应覆盖；测试用 Vite 将源码依赖指向冻结目录。报告中的哈希来自 Vite 实际载入的 Workspace/Workflow 源文，不是运行末尾可能已被其他任务修改的文件。

Vite 仅在测试进程插入两个组件的 render 和 layout-effect commit 计数，不改业务源。夹具同时统计 document 级节点查询、端口查询、总边界读取、端口边界读取和 stage 边界读取。每项输入 48 个事件，分四组每组 12 次，事件派发包装在 `flushSync` 中，再留两次真实动画帧处理调度工作。React 仍可能合并部分 native-event commit，因此 render 与 commit 分开记录；这是可重复压力测试，不代表真实设备输入频率、原生帧率或完整应用性能。

功能断言覆盖平移累积、缩放指针锚点、素材/内容/工作流三类卡多选同步位移及持久化、未松手时内容端口与线端点误差、取消回滚、最后 move 未刷帧便 pointerup、Escape 清除未刷帧位移、同帧越过拖动阈值再返回不会误开预览、滚轮相机尚未 settle 就调用路由保存屏障、混合卡框选、吸附和引导线。拖动中让静止工作流卡通过 CSS 增高，检查未松手时吸附已更新；高度沿既有 offsetHeight 取整，允许小于 1px 的视觉边界差。after 另有同一任务内 wheel→resize 的实时缩放专项，不等待 120ms settle。首轮对照说明：React 已将部分高频输入合并成四次 commit；主要额外负担是工作流被反复求值时，每条内容线重复执行全局节点搜索和端口布局读取，不能简单把输入次数当作重绘次数。
