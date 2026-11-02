# 2026-11-02 · 紧凑仪器顶栏实装

用户确认 `.tmp/topbar-instrument-preview/` 设计并要求按 ub-mode 实装。本记录只覆盖本轮顶栏工作；产品有效约定同步到 PROJECT.md，视觉规则同步到 UI-DESIGN-SPEC.md。

## 实施记录

1. 读取 ub-mode、PROJECT 进展与约定、UI 规范和架构入口；核对确认稿、主题加载顺序及正式 Toolbar。工作区有其他任务的未提交修改，只编辑本轮相关文件。
2. 在正式 App 合成 IPC fixture 上先增加行为回归。沙箱运行因本机网络／文件访问限制未能执行；允许沙箱外隔离运行后，测试明确失败于旧栏高 `64 !== 44`。
3. 将共用顶栏视觉放入现有 IndustrialTheme.css，画布顶部控件放入 IndustrialCanvas.css；删除工业画布旧顶栏覆盖与标题／缩放共用底框，不新增全局主题文件，不改业务事件。
4. 保留正式版更新入口的 36px 预留位；方点阵跟随左侧操作组并在窄窗隐藏，避免把确认稿中的固定装饰坐标照搬到不同页面。账号头像保留真实图片，按钮本身去底框。
5. 回归深浅色、画布／素材库／项目页、900／1280／1920px、悬浮终态、持续选中、相邻按钮、减少动态效果、账号入口；主题切换后等待现有过渡完成再比较颜色，避免把过渡中间值当作终态。
6. 运行更新入口与首页导航原有回归；执行 TypeScript 和独立目录的 Vite 生产构建。打开不含 `data-topbar-study` 的正式组件预览，核验 44px 实际栏高和深浅效果。
7. 核对 diff 与设计规范。crapper、dryer、mutator 工具未在本会话提供；本轮产品变更仅 CSS，无新增业务函数。未宣称运行这些工具或完成 mutation 覆盖。
8. 检查现有 worktree 清单，本轮未新建 worktree；其他 worktree 的占用／未提交状态不属于本轮，保留。独立构建和截图留作验收证据。

## 验证

- `node scripts/topbar-instrument-ui.test.mjs`：通过。
- `node scripts/topbar-update-ui.test.mjs`：通过；更新出现不推动积分位置，键盘进入与关闭恢复焦点正常。
- `node scripts/home-navigation-ui.test.mjs`：通过；首页切换居中、路由、浏览状态与账号交互保持。
- `npm run build -- --outDir .tmp/topbar-instrument-build`：TypeScript 与 Vite 通过；仍有已有的大 chunk 提示。
- 截图：`apps/desktop/.tmp/topbar-instrument/`；正式组件预览：`http://127.0.0.1:17864/.tmp/canvas-structure-preview/index.html?theme=dark`。

这是主应用源码接入，不是安装包发布；未替用户安装、重启桌面应用或改动真实素材库。公开安装包版本与发布流程仍以 DESKTOP-UPDATES.md 为准。
