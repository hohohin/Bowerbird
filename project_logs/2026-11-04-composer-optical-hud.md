# 2026-11-04｜光学 HUD 创作框实装

## 授权与范围

用户在 `composer-optical-controls-hud.html` 最终示意稿上确认「实装」。本轮接入主屏／画板共用创作框；没有调用真实模型、写入用户素材库、部署服务或制作安装包。Windows 26.11.301 发布边界保持。

确认稿位于 `C:/Users/Hins/.codex/visualizations/2026/10/21/01a15d5b-9b95-77b0-a83d-30f6ffe4ac6b/`，沿用而不覆盖。旧悬浮索引实现与验证见 [前次记录](2026-11-03-composer-floating-hud.md)。

## 操作与原因

1. 读取 PROJECT、UI 规范、开发计划／复用地图及相关画板契约，应用 UI UX Pro Max 与 ub-mode。先登记工作区已有改动，避免混入其他会话的图片预览与状态标记工作。
2. 先更新正式组件测试并在旧实现得到预期红灯：模式仍横排、正文偏小、框内仍有创作状态文字。修正 header 测试未加载正式 Industrial 样式的覆盖缺口。
3. 复用 `CreationBoard`、现有项目 header／`TacticalSelect`、`VisualProfileSelect`、`MediaPreview` 与 `BoardChipPreview`。没有另造编辑器或生成链路；引用缩略图只派生自 `useCreationEditor.references`，顺序、节点来源、退格删除与独立草稿沿用原实现。
4. 将模式置于左轨，主屏项目置顶，保留条件 Agent 第四项。去除框内状态提醒、顶部标题与旧光线扫描层；品牌入口折叠为图标，点正文／外部、再次点击或 Esc 可收回，选择器 portal 继续按归属保留焦点。
5. 替换上一版共用 CSS 块：品牌蓝、26px 后景模糊、42–54% 半透明主体、19px 羽化、两侧 32px 光学范围、透明线框关闭及发送右缘折光。正文不置于滤镜层内；复杂素材背景上的左轨标签单独提高底色密度并做 12px 后景模糊，保留可读性。删除仅本组件使用的旧玻璃 hook、索引 thumb 和状态 DOM。
6. 保留大文本区与 72px 引用预览；参数行使用 nowrap，原生最小宽度 900px 下核对右边界及重叠。保留本机首尾帧浮层、环境配置及不可用时禁止发送／快捷发送。
7. 独立审查发现并修正：系统强制色选中背景应落在真实 button；禁用发送按钮灰化并移除折光；品牌面板点非聚焦画布空白时同步收起。
8. 同步 PROJECT 当前约定、UI 规范与复用地图，保留既有文档中的其他会话增量。提交仅包含本轮文件及文档片段。

## 验证与边界

- `node scripts/composer-hud-ui.test.mjs`：正式 App 合成 IPC，主屏／画板深浅色、左轨／项目置顶、19px 羽化、正文滤镜隔离、大输入区、模型菜单、收起首行／贴底、视频单行、减少动态效果。补验逆序插入两图、预览顺序与编号、图片解码、Backspace 同步、收起隐藏／重开恢复、品牌入口和放大编辑。
- `node scripts/composer-header-ui.test.mjs`：1440／900／640px × 深浅色 × 图片／视频／对话，关闭相对右上位置、竖排模式、单一历史入口及收起保稿。640px 是低于应用最小宽度的压力检查；全局 CSS 最小宽 760px、原生窗口最小宽 900px，640px 下整体横向滚动不计作正常原生窗口验收。
- `node scripts/library-creation-parity-ui.test.mjs`：现有正式 App 回归通过，覆盖素材／Tab 聚焦、标签／集合图片手势、缓存外素材查找、迟到请求取消、Space／Enter 与修饰键选择、独立草稿及画板手势。该测试文件已有其他会话增量，本轮只运行，不随本轮提交。
- 本机视频额外沿用 `composer-local-video-ui.test.mjs` 的合成环境前半段，临时脚本注入正式 Industrial 样式、先切换视频再插入视频草稿引用，并采用窄屏短环境文案：1600／1240／900px 参数同一中心线、无重叠／溢出，前两图作首尾帧、第三张提示舍弃，环境不可用时按钮与 Ctrl+Enter 均不发送。该检查不安装环境、不产生生成费用。
- 完整 `tsc --noEmit` 通过。沙箱内最初的 37 条 ProseMirror／Plate 错误来自 Windows `fs.realpathSync.native` 对 pnpm junction 的 EPERM：内存替换成 HEAD 代码后错误完全相同；沙箱外原版 TypeScript 退出 0。未修改依赖或锁文件。诊断证据：`apps/desktop/.tmp/composer-optical-types-baseline.json`。
- `git diff --check` 检查本轮文件。ub-mode 提及的 crapper／dryer／mutator 在当前工具中不可用，本轮采用定向独立审查与真实 DOM 交互验收，没有声称执行这些工具。
- 截图位于 `apps/desktop/.tmp/composer-hud/`：`references-dark.png`、`references-light.png`、`home-rest.png`、`video-dark.png`、`canvas.png`；本机未就绪压力图位于 `.tmp/composer-local-video/unavailable-900.png`。

这些验证使用正式 React/CSS 与合成 IPC，证明本轮呈现和交互，不替代 Windows WebView2／Mac 原生视觉及真实服务验收。未改全局最小窗口宽度；没有处理其他会话的未提交代码。无推送、发版或生产部署。
