# 顶栏通知与悬浮滚动条确认稿

独立网页：`/scripts/fixtures/notifications-scrollbars/preview.html`。沿用现有 17922 预览服务，无需另开端口。

用户已于 2026-11-03 明确确认并要求实装。本页直接使用正式 Toolbar、SidebarAccount、LibraryHome、LibraryComposer，以及正式 NotificationBell／OverlayScrollbars；不再通过 fixture portal 插入重复铃铛，也没有通知事件改写桥。演示控制位于底部独立外壳，不属于产品界面。

复用封闭本地素材 fixture，不读取用户数据库、不运行模型、不访问远程服务。

本页验收范围为铃铛、滚动条及相关布局；独立外壳没有装入 HomeWorkspace 的图片手势。当前创作模式、预览与添加引用的完整行为见 [正式 App 回归](../library-creation-parity/README.md)，不以本页组件拼装替代。

运行 `node scripts/notifications-scrollbars-preview-ui.test.mjs` 检查现有 17922 页面：顶部实际顺序、生成通知单一显示、普通 toast、12 条历史与 900/1440 深浅色菜单边界。截图位于 `.tmp/notifications-scrollbars/`。滚动条专项行为和通知自动收起时序由正式组件的独立测试覆盖。

独立行为测试：`node scripts/notification-bell-preview-ui.test.mjs` 与 `node scripts/overlay-scrollbars-preview-ui.test.mjs`。后者显式开启 Chromium 原生滚动条，避免无头模式默认隐藏滚动条造成零占宽假通过。

正式滚动条为 50% 透明度、4px 宽滑块、1px 斜纹线与 2px 间隔；仅滚动期间出现，静止 800ms 后用 120ms 淡出。隐藏滑块不拦截点击。主屏尺寸调整栏按用户要求先隐藏，替代位置尚未确定；通知与滚动条已接入正式源码，尚未打包发布。

正式 App 回归：`node scripts/notification-bell-app-ui.test.mjs`。包装器兼容回归：`node scripts/overlay-scrollbar-adapter-ui.test.mjs`。它们直接加载正式模块，保留原滚动节点与 callback／object ref，不使用待接入代码覆盖。
