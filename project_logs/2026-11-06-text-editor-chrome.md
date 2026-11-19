# 文本编辑器菜单与工具栏修复（2026-11-06）

## 请求与范围

- 删除编辑器 Markdown／HTML／Word 文档导入；素材库插入、媒体上传和文档导出保留。
- 段落把手旁的 Agent 点击外部自动关闭；模型选择器属于该气泡，不误关闭。
- 修复编辑器菜单背景透出正文。
- 格式工具保持一行，窄屏横向滚动。

## 行动记录

1. 读取 ub-mode、PROJECT、文本专项、UI 规范与复用入口；确认复用 Plate 菜单、既有 ModelSelect 和 TextAgentTask 关闭流程，不新增 Agent 运行器。
2. 先增加真实组件浏览器回归；原实现的导入入口、透明菜单、多行格式栏及两组外部关闭场景均失败。证据：`apps/desktop/.tmp/text-editor-chrome-red.txt`。
3. 移除导入按钮和 Word 导入适配。原 IO 回归改为 Markdown 粘贴，继续验证五种导出文件。
4. 定位透明原因：tailwind-merge 将 `text-plate-ui` 作用域误当文字颜色类，与 `text-popover-foreground` 合并时删除，portal 菜单失去主题背景。改为先合并 utility，再附加独立作用域；复用现有菜单，不逐个硬编码背景。
5. 去掉固定工具栏折行及半透明背景；保留横向滚动。测量过滤掉全应用自动注入的 scrollbar 按钮，只检查真实格式控件。
6. 段落 Agent 使用捕获阶段的 pointerdown 识别外部点击，并识别 aria-controls 对应的模型菜单。关闭复用既有取消和迟到结果保护；内部输入、Provider 选择、关闭按钮和 Escape 保持可用。
7. 连续切换菜单时发现字号输入离焦抢走焦点；保留选区提交，离焦不强行回焦。字号输入统一控制浮层，Escape 关闭，避免输入焦点与弹层 trigger 同时切换状态。将字号读取、选区和输入校验拆为局部函数，降低修改函数复杂度。
8. 检查深浅主题菜单截图，完成交互回归、类型与生产构建；更新专项、复用地图和 PROJECT。仅提交本任务文件及共享文档中的本任务行。

## 验证

- `text-editor-chrome-ui.test.mjs`：5 组通过。覆盖无导入入口、两主题菜单／字号弹层、字号到段落菜单连续切换、900／1100／1440px 单行及末端按钮可达、Agent 外部关闭／内部模型选择／迟到结果。
- `text-editor-io-ui.test.mjs`：Markdown 粘贴及 Markdown／HTML／PNG／PDF／Word 导出 6 组通过。
- `text-agent-ui.test.mjs`：14 组通过；按新关闭契约更新正文编辑／删除目标的期望。
- `text-editor-blocks-ui.test.mjs`：10 组通过；`text-markdown-ui.test.mjs`：10 组通过。
- TypeScript `tsc --noEmit` 通过；Vite 生产构建通过，保留已有大 chunk 警告。
- 深浅主题截图：`apps/desktop/.tmp/text-editor-chrome/menu-light.png`、`menu-dark.png`。

## ub-mode 质量检查与边界

- Crapper、Dryer、Mutator 均在 `.tmp/text-editor-chrome-quality/` 隔离副本运行，未改第三方工具或生产源码来执行变异。
- 本轮五个目标文件行覆盖率 94.52%；新增／修改函数 CRAP 不超过 8.1，Dryer 未发现重复候选。
- 仅菜单回归采样未覆盖原有 `writeAfter`，其报告值 12；未将此结果当作完整 Agent 模块质量通过。实际回写行为另由原有 14 组 Agent 回归覆盖。
- 自动 mutator 在外部关闭逻辑选择的 3 个变体（两处可选链和恢复焦点参数）仍存活；现有浏览器场景未区分这些变体，未声称全量变异测试通过。额外在隔离副本禁用关闭调用，两个外部关闭回归均失败，确认测试确实加载变异副本并检验用户行为。
- 合成 IPC，不调用真实 Codex／Cloud 服务或扣费；未构建、发布桌面安装包。

## 提交边界

自动审批拒绝将本地提交与远程推送合并执行：本地提交风险低，但未确认向 origin dev 发送源码与文档的授权。先完成本地提交；远程推送等待用户批准。
