# 首页平级导航候选

2026-11-02 独立确认稿，用户已确认顶部居中布局并授权实装。正式 App／Toolbar／ProjectManagerPanel 已接入，源码待发布；本目录保留独立示意与假路由，不作为生产实现。

- 顶部栏中央的「素材库」「项目」同级切换，位置相对整窗居中；项目管理占满主内容区，没有遮罩或关闭按钮。
- 不新增 Tab 切页：素材库内部继续使用现有 Tab 切换素材视图，项目页正常移动焦点。
- 复用正式 LibraryHome、ProjectFolder、菜单、选择器与滚动区；ProjectsPreview 只替换原项目弹窗的容器及重复说明。正式接入应修改原组件，勿长期维护第二套项目查询。
- 两页使用 PreservedWorkspace 保留浏览状态，隐藏页 inert，暂停视频与 CSS 动画；项目背景 WAAPI 装饰仅在活动页挂载。
- 合成 IPC 和本地示例图片，不访问用户数据库或文件。新建／打开项目仅展示画布占位以演示去向；建立连接与探索不执行外部操作。

在 apps/desktop 执行 `pnpm exec vite --host 127.0.0.1 --port 17912 --strictPort`，打开 `/scripts/fixtures/home-navigation/preview.html`。深浅主题可通过现有账号面板的外观设置切换，仅作用于浏览器预览。

验证：`node scripts/home-navigation-preview-ui.test.mjs`。旧界面 RED 用 `HOME_NAVIGATION_BASELINE=1`；截图保存在 `.tmp/home-navigation/`。

正式接入已修正 `libraryHomeView` 清筛选和 LibraryHome 挂载重置，移除 Toolbar 项目弹层，使用 HomeWorkspace 保留两页状态；项目打开与创建复用真实 enterProject / provisional 链路。正式 App 隔离回归为 `node scripts/home-navigation-ui.test.mjs`，示例数据入口为 `/scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library`，点击「返回主页」查看首页。验证边界及行动见 [日志](../../../../../project_logs/2026-11-02-home-navigation.md)。
