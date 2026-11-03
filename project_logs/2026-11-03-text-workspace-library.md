# 文本工作区复用画布素材库

用户要求文本编辑器复用画布素材库的逻辑与样式，排除 Tab 打开行为。本轮延续已确认的 Plate 工作区，未改动原生保存／文档输出协议。

## 行动记录

1. 读取当前 PROJECT、开发计划、视觉、文本、画布和文件协议；核对工作区并发修改，在 `.tmp/text-workspace-library-reuse` 保存共享文件基线。没有撤回或覆盖其他任务代码。
2. 使用 ui-ux-pro-max 的 React 焦点管理建议检查模态边界。只读审查确认 `LibraryCatalogTransition`、分类／集合组件、常用素材和宽度控件可直接复用，浏览状态由现有 `LibraryPaneContext` 隔离。
3. 在正式 TextWorkspace UI 夹具新增共用库断言，先观察 `.library-catalog-transition` 缺失的真实失败。分派生产接入、隔离测试和只读审查，文件归属分开。
4. 删除编辑器的简化分页列表，使用实际共用组件；明确区分单击查看与双击／Enter 插入，避免发送画布的全局选图事件。素材插入仍走既有 Slate 选区书签。
5. 为共用菜单、弹窗和媒体预览增加可选 portal 宿主，默认仍为 body；文档工作区内部使用自己的层叠与焦点边界。详情使用可选受控选中身份，不改背后画布的详情选择。
6. 修复实际回归发现的共享工具栏遮挡保存菜单、缺少基础素材库样式、默认宽度挤压正文及受控菜单被背景项目身份关闭。文本工作区默认宽度 600px，保留正文空间，使用独立宽度存储。
7. 显式标注／分层／回看创作／添加到画板等跳转先保留草稿并退出编辑器，继续原动作；普通预览、详情、集合与重命名留在工作区。共用组件默认调用方式保持兼容。
8. 按审查补充焦点循环、全选、Q/E、输入保护、常用素材点选及取消的真实交互测试；降低新增函数分支。使用官方 crapper、dryer 与 mutator，突变仅操作隔离快照。
9. 真实鼠标拖动证明 `mousedown.preventDefault` 会阻止素材原生拖动，删除该拦截；完整回归证实 Slate 仍保留光标，拖动不误插入。补齐宽度手柄 Escape 只关闭库，以及本地详情菜单不继承背景多选的边界。

## 验证

- `text-workspace-live-ui.test.mjs`：先红后绿；正式共享库与 Plate、全局／项目／分类／集合、媒体／搜索／分页、常用素材、光标插入一次、背景状态隔离、菜单／详情／弹窗、Tab／Escape／Q/E、跳转保留草稿、深浅 1440／900 均通过。
- `text-composer-entry-ui.test.mjs`、`canvas-document-ui.test.mjs`、`text-library-ui.test.mjs`、`connected-collections-ui.test.mjs` 通过。
- 完整 `tsc --noEmit` 与独立 Vite 前端生产构建通过。构建保留现有大 chunk／api 同时静态与动态导入提示，无新增构建错误。
- 官方 crapper 使用真实 V8 转换覆盖评估新增工作区模块／portal helper，全部函数 CRAP < 10（最高 9.6）；dryer 在 0.8 阈值未发现重复候选。未扫描或重构共享组件原有的大函数，不将这些局部指标声明为全仓指标。
- 官方 mutator 对新增详情键盘事件的 dialog owner 条件抽测：baseline 通过，反转比较后真实 UI 无法用 Escape 关闭本地详情而失败，1 killed／0 survived；只代表该位点，不宣称全量突变覆盖。
- 旧 `canvas-frequent-assets-ui.test.mjs` 在退出点选后点击素材时失败：图片会话预览夹具缺少 `turn.images`，`CreationImagePreview.tsx` 调用 `.includes` 导致 React 根卸载。通过 Vite 临时加载修改前的 CategorizedLibrary／ConnectedCollections／CanvasFrequentAssets，复现同一错误与堆栈，确认并非本轮回退；未改动该并发任务文件，也不把该测试计为通过。诊断见 `frequent-baseline-diagnostic.log`。
- 证据保存在 `.tmp/text-workspace-library-reuse/`：V8 覆盖、深浅截图、构建及 `quality` 质量日志。开发临时产物未纳入提交；保留复核证据及仍被使用的隔离测试目录，不清理其他任务临时文件。

测试只使用合成 IPC 与本机夹具，不写用户库、不调用模型。本轮仅前端接入，不改原生存储；未打包发布安装包或进行 Mac 原生验收。
