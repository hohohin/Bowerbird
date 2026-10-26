# 素材库结构与配色确认版

2026-10-26 用户确认实装的后续版本。此目录单独冻结接入前后的源码，不覆盖上一级最初的 `before/`、`approved-source/`、`site/` 或旧补丁。产品约定与发布状态仍以 [PROJECT.md](../../../../PROJECT.md) 为准。

## 本次范围

- 四份生产文件：`LibraryTactical.css`、`Toolbar.tsx`、`CategorizedLibrary.tsx`、`VirtualCatalog.tsx`。
- 两份配套回归：`library-tactical-ui.test.mjs`、`toolbar-layout-ui.test.mjs`。
- 顶部与侧栏保持现有布局，配色与项目管理面板对齐；「我的项目」使用低对比背景，移除尾箭头和独立深色图标块；标签管理常态只显示图标。
- 侧栏右侧刻度和底部短方点均为不拦截操作的装饰；分类数量直接使用 `section.count`，随实际筛选结果更新。
- 保留控件短闪、标签互不串闪、四角方点顺时针移动 400ms 后短闪并停在顶点；不引入示意页菜单、快捷键、模拟数据或 DOM 观察器。

## 文件与来源

`before/` 与 `after/` 均保留完整仓库相对路径。前者主要来自本次开始时的 `.tmp/library-approved-integration-before/`；`VirtualCatalog.tsx` 来自同一快照目录根部的单独副本。`toolbar-layout-ui.test.mjs` 的前态只将本次修改的控件高度断言恢复为 `height === 36`，其余内容保持。各项来源、原始字节 SHA-256、补丁哈希及验证结果记录在 `manifest.json`。

`screenshots/production-integrated-light.png` 保存实际生产组件夹具的浅色效果，供恢复后的视觉核对；当前浏览器还确认「我的项目」可打开完整项目管理面板。

上一级 [`structure-approved.patch`](../structure-approved.patch) 是这六份文件从 `before/` 到 `after/` 的增量，可反向回到本次实装前状态。上一级 [`switch-isolation.patch`](../switch-isolation.patch) 单独记录上一轮的切换条串闪修复和对应测试，以衔接更早的累计恢复补丁。

完整恢复顺序：`structure-approved.patch` → `switch-isolation.patch` → `zones.patch` → `light-gray.patch` → `integration-clockwise.patch`，逐项反向检查并应用；重新接回时按相反顺序正向应用。仅想撤回本次结构与配色时，反向应用第一份补丁即可，保留切换条修复。具体命令见[上一级恢复说明](../README.md#恢复实装前样式)。不要整文件覆盖后续功能修改。

## 验证

本轮 Tactical、分栏、toolbar-layout Chromium 回归及 Vite 构建通过。完整 TypeScript 检查仍有既有的 16 项 ProseMirror 相关错误，位于创建编辑器与 WorkflowPromptEditor；本次生产文件没有类型报错。

五份补丁在隔离临时副本逐项完成反向 `--check`／应用，再逐项正向接回；完整往返与快照内容相同。反向终态的既有文件与原始 `before/` 副本一致，比较时仅统一 LF／CRLF；原冻结资料的字节哈希保持。验证没有在当前工作区执行撤回，也没有改动素材、数据库、账号或发布安装包。
