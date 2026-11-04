# 探索浮动把手与 Pinterest 小图标

## 实现与原因

1. 用户明确把手应覆盖内侧内容，不接受单独占宽。移除上次 20px viewport 边距，保留既有 14.4px、中央位置、同色面板页签与朝内轮廓；复用 PanelEdgeHandle 和原鼠标／键盘／退出逻辑。
2. 原生子网页高于 DOM，单独删边距会盖住按钮。沿既有 SourceBrowserBounds 增加可选 overlay，由正式页签矩形加描线余量计算，只允许有限、位于 viewport 内的区域；没有另加远程 IPC 能力。Windows 在 Wry 的子 HWND 上使用 [SetWindowRgn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowrgn)，只透出该小块主窗口，整页及上下区域保持原宽度。区域成功交给系统后不重复释放，去掉 overlay 恢复完整窗口。
3. 新建小型原生模块隔离平台代码；Mac 复用同一 WKWebView，透明父视图在把手处让命中穿透，图层遮罩只扣出局部足迹，保留父坐标系和自动布局。Mac 仅源码接入，本机无 Apple 工具链，未宣称已编译或实测。
4. Pinterest 只缩原生导航内 SVG 和图标容器里的图片到 16px，保留 32px 按钮点击宽度与原生事件；36px 侧栏、内容偏移、保存控件隐藏和滚动样式保持。测试夹具将原字符替换为实际 24px SVG，不把按钮尺寸当图标尺寸。
5. 红绿：旧实现分别在“网页占满面板”及“图标 24 而非 16”断言失败，随后通过。补充首帧原生裁剪、显示／隐藏及调宽、非法足迹拒绝和移除恢复；第一次原生图标断言遇 DPI 浮点值 16.000000953，改为 0.1px 容差，未改产品尺寸。

## 验证与交付

- `explore-handle-ui.test.mjs`、`explore-memory-ui.test.mjs`、`pinterest-chrome.test.mjs` 通过；检查整宽 viewport、局部 overlay 参数、按钮与键盘、退出重开、共用素材库把手、图标、原生菜单、滚动和其他域名隔离。
- `pinterest-layout-native.test.mjs` 通过。证据：`apps/desktop/.tmp/pinterest-layout-native-1793766286871/result.json`；真实 WebView2 HWND 在把手点排除，右边缘上／下和正文点仍包含，移除区域恢复；网页仍 720px。还覆盖初次创建、16px 图标、SPA、后退、分页和自动上传搜图。使用隔离资料／合成站点，不操作真实账号或生产素材库。
- Rust `commands::source_browser::` 8 项通过，含 1×／2× 实际 Windows 区域、恢复完整窗口、无效句柄、非法／边界参数及原有来源权限。测试 EXE 的 Common Controls 清单仅补到本轮临时副本。
- TypeScript 与 Vite production build 通过；原有构建告警未改。Crapper 新增／修改辅助函数 CC 为 3–6，无原生覆盖率映射，CRAP 为 N/A；Dryer 0.8 未发现重复。官方 Mutator 在保留原函数体和测试体的独立 Rust 探针上产生 4 个边界变异，补齐原点合法区域断言后全部被杀死；探针仅去掉 serde derive 的外部依赖，不替换逻辑。报告在 `.tmp/explore-overlay/`，不代表其他平台原生覆盖率。
- 当前开发 EXE 已由 watcher 自动更新，2026-11-04 12:22:36 启动，PID 75916；12:22:32 二进制包含最终 Pinterest 脚本和 overlay 模块，SHA256 `434e220d6dc4d3ad19ca855d8fd295723923482215e83f51cfef44b83eaf35d4`。未手动再次重启，未发布安装包。
- 更新 PROJECT、探索协议及复用地图，只提交本轮增量；其他聊天的素材拖动、创作 UI 和文档修改保留。没有创建 worktree，也未删除共享任务目录。
