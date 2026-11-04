# 探索把手与关闭按钮重设计

## 设计与根因

用户要求通过 ui-ux-pro-max 重设计。读取该 skill、项目视觉规范和复用地图；第一次检索混入移动端后退条目，收窄为 keyboard focus visible，采用可见焦点和不遮挡焦点规则。沿用 PanelEdgeHandle 的交互与语义，只增加探索专用 overlay 外观；素材库默认 tab 保留。

原残留来自曲线页签之外的矩形原生裁剪，且旧 boundsFor 还扩出 1px 余量。新方案为 14.4×76px 窄切角轨，上方 28px 关闭区，下方拖动，短线分组，移除 ESC 小字及旧尾部；面板同色、悬停／聚焦工程蓝，保留键盘焦点与 Escape。实际 SVG 提供 4px 切角，前端传精确边界和 cut，Windows 多边形裁剪与 Mac 遮罩／命中使用同轮廓。网页保持整宽，cut 缺省零兼容旧协议，并限制为短边一半以内。

## 行动与验证

1. 先扩展正式控件回归，旧版在 86 而非 76px 失败。原生 WebView2 旧实现同时复现：切角外三个采样点均被矩形挖掉，预期应有两个仍显示网页。
2. 更新共享外观、探索样式、足迹计算及两个平台裁剪；保留来源权限、缩放、退出、项目和浏览器状态处理。Windows 成功交给系统的区域不重复释放。
3. `explore-handle-ui.test.mjs` 通过：尺寸、内侧整宽、无 ESC 小字、cut 协议、鼠标／键盘调宽、关闭、Escape、记忆宽度和素材库默认样式。深浅近景在 `apps/desktop/.tmp/explore-handle/{light,dark}-contour.png`，使用正式控件与模拟网页图层检查外轮廓，非真实站点截图；已人工查看。`explore-memory-ui.test.mjs`、TypeScript 和 Vite build 通过。
4. 完整原生构建首次被另一处进行中的 ComfyUI 接口缺失挡住。未修改该模块；工作区补齐接口后重建成功。`pinterest-layout-native.test.mjs` 通过，证据为 `apps/desktop/.tmp/pinterest-layout-native-1793785322631/result.json`，确认首帧切角外仍是网页、面内仍排除，且保留原导航、搜图、分页和图标行为。
5. Rust `commands::source_browser::` 8 项通过，包含 1×／2× 区域、上下切角、面内、恢复完整窗口以及非法 cut 和权限。测试 EXE 清单只补入本轮临时副本。Mac 已同步代码，但没有原生编译／实机验收。
6. 使用 crapper／dryer／官方 mutator：边界和原生辅助函数 CC 3–8，Dryer 0.8 无重复；无覆盖率映射，因此 CRAP 为 N/A，forwardRef 组件未被工具识别，不冒充通过。保留原验证函数体的隔离 Rust 探针仅剥离 serde 依赖注解，4 个边界变异全部被测试杀死；原生轮廓另由真实 HWND 回归验证。报告在 `.tmp/explore-handle-design/`。
7. 当前开发 EXE 自动重建，2026-11-04 17:43:20 启动，PID 29504；SHA256 `98ed4a1d5c1ae0b7b63a926afac9995940b4a0573cabcacab729da9773f04677`。未再次手动重启或发布安装包。
8. 更新 PROJECT、视觉规范、探索文档及复用地图。api.ts 有其他任务的结账接口增量，暂存时仅取 cut 字段；共享文档同样仅取本轮增量。未新建 worktree、删除共享目录或提交其他任务内容。
