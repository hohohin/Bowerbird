# 独立截图入口滚动回归

运行 `node scripts/overlay-scrollbars-screenshot-ui.test.mjs`。只有 IPC 使用合成截图与历史记录；执行真实 `src/screenshot-main.tsx`，验证历史列表零原生槽、悬浮滚动条、截图独立透明主题和关闭历史时保留截图窗口。不加载主 App 或用户截图。
