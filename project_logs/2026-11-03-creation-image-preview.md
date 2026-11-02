# 创作图片与会话预览实装

## 目标与范围

用户确认 quiet HUD 深浅色示意后要求实装，并显式启用 [ub-mode](C:/Users/Hins/.codex/skills/ub-mode/SKILL.md)。图片独立悬浮，会话使用独立裁角阅读面；保留全息投影感、背景景深与浅色右下柔影，不增加装饰或说明。创作模式单击图片／有图片的会话卡预览，双击添加引用。未请求打包发布。

## 行动记录

1. 读取 ub-mode、项目当前约定、UI 规范和画板契约，核对已批准的示意源码。原因：以确认稿作为实现边界，避免再次先实装后确认。
2. 检查 Git 分支及工作区：起点为 `dev` 的 `cdcb0306`，存在其他任务的未提交改动。只修改本任务组件、入口、专项测试与文档，提交前单独核对范围。
3. 先补真实非纯图片会话卡的标题／正文点击测试。两者均复现 `preview:false, boardOpen:false`，与预期 `preview:true, boardOpen:true` 不符；红灯日志和截图位于 `apps/desktop/.tmp/canvas-creation-image/whole-card-red.log` 及 `whole-card-*-red.png`。原因：原测试只点击图片区域，未覆盖整张会话卡。
4. 将会话卡外层纳入既有创作图片命中判断，复用当前展示产物、点击延迟及引用来源规则。原因：标题／正文此前绕过图片入口，直接打开旧详情并退出创作。
5. 将已确认的独立图片／会话 HUD 接入正式组件；示意页复用该组件。保留真实历史读取与只读快照，避免示意和正式代码再次分离。
6. 入口修复后先复跑：标题／正文均得到 `preview:true, boardOpen:true, picks:[]`；后续停在待替换旧 UI 缺少图片区的预期断言。限制只有实际图片双击能添加引用，标题／正文单击仍预览；避免扩大引用手势的范围。
7. 初查本会话工具目录和 PowerShell PATH 未发现 ub-mode 的三个工具；继续核对其他任务的实际执行记录后，找到 `.tmp/ub-tools/venv/Scripts/python.exe` 中的 `crapper`／`dryer`／`mutator`。改为在本任务独立快照执行，不修改真实源码或借用其他任务的指标。
8. 正式入口主要回归全绿；CUA 核对同源组件深浅色与批准稿一致，保存 `implemented-dark.jpg`／`implemented-light.jpg`。完整 TypeScript、独立 Vite 构建及文本聚焦 UI 通过。沙箱曾阻止 Vite realpath 和 Chromium loopback，获准在本机重跑；这些环境失败不计为业务失败。
9. 最终审查补出两项键盘红灯：嵌套 Lightbox 不进入／圈定／恢复焦点，鼠标关闭后父层 Esc 失效；预览按钮 Space 被后台抓手拦截。先在 `keyboard-red.log` 确认失败，再补 Lightbox 焦点生命周期与 Tab 圈定，阻止预览内键盘事件传入后台画布。保留顶层 Esc／方向键的既有捕获行为。
10. 键盘新增断言和完整图片专项全部转绿。焦点进入由动画帧调度，测试等待真实焦点进入（最多 1 秒），不以固定 sleep 或提前读取代替结果。最终本机完整 TypeScript、独立 Vite 构建均通过。
11. 补跑既有测试：文本聚焦 UI 全绿；框选测试在富文本选区断言处偶发失败，使用 HEAD 的 CanvasWorkspace 隔离覆写后同样复现（最后五轮中一次），故不依赖本轮画布入口增量，具体选区塌缩来源未确证。媒体 UI 两次停在第 76 行图片／视频阴影浮点值精确比较，不计为通过；未修改这些测试或放宽断言。
12. 核对运行环境：本轮读取 `127.0.0.1:1420` 时连接被拒绝，因此不声称用户原生开发窗口已热更新验收。正式组件通过隔离真实入口和同源示意验证；保留用户预览页，不重启或操作用户库。
13. 提交前按 hunk 提取本任务增量；CanvasWorkspace、GenerationPanel 同时存在其他聊天的文本工作区修改，使用单独的提交快照，避免把其未完成改动带入。其他未提交代码、截图及既有 worktree 均保留。

## 验证与交付

- 图片专项：`apps/desktop/scripts/canvas-creation-image-ui.test.mjs`，整卡单击／图片双击、画布引用来源、独立面板／收起、草稿及任务、Tab／Esc／Space、嵌套 Lightbox、多选／拖动、切项目、普通浏览／无图回退、浅色 800px 和减少动态效果通过。红绿日志在 `apps/desktop/.tmp/canvas-creation-image/`。
- `canvas-text-focus-ui.test.mjs`、完整 TypeScript 与最终独立 Vite 构建通过；构建保留现有 chunk 大小／动态与静态混合导入警告。框选基线对照在 `apps/desktop/.tmp/marquee-baseline-review/`；旧媒体／框选脚本未计为全绿。
- CUA 深浅色正式组件截图在 `apps/desktop/.tmp/creation-image-review/implemented-{dark,light}.jpg`。这些截图不等同于原生 Windows WebView2 或 Mac 验收。
- 质量工具使用冻结的 `CreationImagePreview.tsx`／`Lightbox.tsx`：dryer 0.8 无重复候选；crapper 将 JSX 与内嵌回调分支计入外层，CC 分别为 92／28，Coverage 与 CRAP 为 N/A，不声称 CRAP 小于 10 或全组件覆盖。mutator 仅执行 4 个定向站点，3 killed／1 survived：两层 Escape 与 Lightbox Tab 守卫变异均被真实行为断言杀死；会话初始打开值的变异被挂载 effect 合法重置覆盖而存活，保留原始结果。工具发现的其他站点未运行。最终快照与真实源码 SHA256 相同；报告与完整日志位于 `.tmp/creation-image-quality/`。

测试只使用合成数据与隔离 IPC，不调用真实生成、不写入用户素材库。未打包或发布安装包。
