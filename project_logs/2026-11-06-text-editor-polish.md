# 文本编辑器段落与列表体验修订 — 2026-11-06

用户指出无序列表圆点与把手重叠，要求以 Plate 官方演示为交互基准认真优化。本轮交付范围是现有正文、标题、列表、引用、选区与块操作的完整使用流程；不将本轮修订称为已覆盖官网全部插件。

## 核查与复用

- 读取 PROJECT 现行约定、文本专项、UI 规范、开发计划与复用地图；检查现有 Plate 插件、块操作、Agent 侧栏、共享菜单和 Markdown 编解码。沿用 ub-mode 与 ui-ux-pro-max。UI 技能的间距搜索主要返回移动触控建议，未直接将移动尺寸套到桌面；以本仓库 UI 规范和实际几何验收为准。
- 对照官方 [List](https://platejs.org/docs/list)、[Indent](https://platejs.org/docs/indent)、[DnD](https://platejs.org/docs/dnd) 及 [Block Draggable](https://platejs.org/docs/components/block-draggable)，核对已锁定版本源码。根因是 List 缺少配套的 Indent 配置，以及操作控件放在被列表包装的内容里。引用的每个嵌套节点还重复渲染把手。
- 复用 Plate `aboveNodes`、IndentPlugin、`getListChildren`、公开节点变换、rangeRef 和历史批次；类型菜单复用 `ContextMenu`。缩进包已在原依赖树和许可清单内，只补桌面直接依赖，无版本升级。

## 行动记录

1. 编写正式组件浏览器测试，先复现圆点与把手间距不足、Tab 无缩进、引用重复把手、缺少类型菜单和拖动落点提示。
2. 将顶层块操作移到独立侧栏，保留原有块节点身份与媒体逻辑；为 Agent、把手、标记与正文留出各自空间，修正标题／引用首行对齐，紧凑列表间距并给标记与文字留白。
3. 接入列表缩进，扩展简单嵌套列表的 Markdown 恢复；普通 Tab 保持焦点语义。快速 End→Tab 验收定位到 DOM 选区与 Slate 状态的时差，执行命令前同步真实选区。
4. 加入正文及 H1–H6 类型菜单；保留菜单打开前的选区书签，变换后恢复选区。菜单定位、焦点与键盘导航沿公共组件，不另建菜单系统。独立键盘验收复现公共菜单未识别 `menuitemradio` 的问题，扩展其项目选择器覆盖标准单选／多选菜单角色，并回归普通素材菜单。
5. 拖动显示明确落点；使用 `getListChildren` 将父项与缩进子项视为一组移动／复制／删除，复制重新分配全部元素 ID，整组操作可以撤销。
6. 完成双主题截图，检查 12 项有序列表的多位编号、长行换行、1000px 窄屏、Agent 留白及标题与把手对齐。新增套件隔离 Vite 缓存，避免并行变异测试与旧套件争用；选区滚动测试改为真实鼠标滚轮操作。
7. 按职责整理块变换与类型菜单逻辑，运行质量工具；更新 PROJECT、文本专项、许可范围及本地复用地图。仅暂存本轮改动，保留并行任务文件。

## 验证

- 新增 `text-editor-polish-ui.test.mjs` 7 组通过，覆盖几何、实际键盘、真实拖拽、复制身份、父子项顺序、保存重开、深浅主题与窄屏。
- `text-markdown-ui` 10 组、`text-block-editing-ui`、`text-agent-ui`、`text-library-ui`、`text-workspace-layout-ui`、`text-document-codec` 和 `asset-multi-menu-ui` 回归通过。全部使用合成文档／IPC，无用户库修改、模型调用或扣费。另跑 `file-context-menu-ui`，其 fixture 停在项目入口、读取画板节点的测试第 26 行失败，尚未进入菜单阶段，不计作通过；本轮公共菜单的行为由 `asset-multi-menu-ui` 与编辑器键盘测试覆盖。
- 完整 TypeScript 与独立生产构建通过；已有 chunk 大小和静态／动态混用提醒仍存在。
- Crapper：本轮块操作、菜单及变换函数均低于 CRAP 10，最高 9；相关三文件浏览器行覆盖率 100%，不是全编辑器全路径覆盖。Dryer 无 0.8 以上重复候选。Mutator 在隔离副本执行来源判断和操作索引两处变异，2 killed、0 survived；不作为全仓库变异评分。
- 截图、覆盖率：`apps/desktop/.tmp/text-editor-polish/`；质量工具副本和原始日志：`.tmp/text-editor-polish-quality/`。测试服务器与浏览器均关闭，未新增工作树；其他任务的临时目录和未提交修改保留。
- 本轮为源码交付，未更新安装包；Mac 原生手势及真实系统输入法验收不在本轮浏览器测试结论内。
