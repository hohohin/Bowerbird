# 共用滚动 wrapper 回归

运行 `node scripts/overlay-scrollbar-adapter-ui.test.mjs`。直接使用正式 `CollectionScrollArea` 和 `OverlayScrollbars`，在 StrictMode 下验证 caller 名称、callback/object 原生 viewport ref、旧轨道移除，以及多个 owner 的注册与退出。没有原生 API 或用户数据访问。
