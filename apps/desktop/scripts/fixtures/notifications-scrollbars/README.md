# 顶栏通知与悬浮滚动条候选

独立网页：`/scripts/fixtures/notifications-scrollbars/preview.html`。沿用现有 17922 预览服务，无需另开端口。

使用正式 Toolbar、SidebarAccount、LibraryHome 和 LibraryComposer；铃铛由 fixture portal 插在更新预留位之后、Bcoin 之前。演示控制位于底部独立外壳，不属于产品界面。目录中的候选组件与样式须获用户明确确认后再接入正式源码。

复用封闭本地素材 fixture，不读取用户数据库、不运行模型、不访问远程服务。

运行 `node scripts/notifications-scrollbars-preview-ui.test.mjs` 检查现有 17922 页面：顶部实际顺序、生成通知单一显示、普通 toast、12 条历史与 900/1440 深浅色菜单边界。截图位于 `.tmp/notifications-scrollbars/`。滚动条专项行为和通知自动收起时序由各候选的独立测试覆盖。

独立行为测试：`node scripts/notification-bell-preview-ui.test.mjs` 与 `node scripts/overlay-scrollbars-preview-ui.test.mjs`。后者显式开启 Chromium 原生滚动条，避免无头模式默认隐藏滚动条造成零占宽假通过。

最新滚动条候选为 50% 透明度、4px 宽滑块、1px 斜纹线与 2px 间隔；仅滚动期间出现，静止 800ms 后用 120ms 淡出。隐藏滑块不拦截点击。主屏尺寸调整栏按用户要求先隐藏，替代位置尚未确定；通知与滚动条尚待正式接入确认。
