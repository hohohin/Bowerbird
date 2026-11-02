# 顶栏任务铃铛与统一悬浮滚动条

## 用户要求

- 近期任务改为 Bcoin 左侧的铃铛入口；新消息向下展开该条消息，用户无操作时 4 秒后收起。
- 应用滚动条统一悬浮，不占内容宽度；采用密集斜条组成的单色工业风。
- 沿用界面改版先独立网页确认的约定，候选代码与正式入口分开。

## 行动记录

1. 读取现行 PROJECT、视觉规范、架构入口与错误展示规则，继续按 ub-mode 与 UI/UX 技能推进。保留其他聊天的未提交代码与文档。
2. 审计发现已有 OverlayScrollArea 仅覆盖 16 处纵向区域；原生 10px／thin 样式与局部隐藏规则并存。真实 Chromium 开启系统滚动条测得普通双轴和侧栏各占 10px，现有 Overlay 为 0；透明轨道不等于不占宽。
3. 顶栏入口定位为 SidebarAccount 的更新预留位之后、Bcoin 之前；候选直接复用正式 Toolbar／SidebarAccount 外壳。保留更新入口与普通错误／保存反馈，生成完成提醒进入铃铛。
4. 先建立独立候选网页，包含最新消息、手动任务历史、普通通知、深浅色以及纵向／双向／文本滚动演示。底部演示控制不进入正式产品。
5. 滚动条候选保留原滚动元素及虚拟列表引用，通过活动滚动容器绘制悬浮轨道；初始化成功后才隐藏原生槽。验证须显式移除 Playwright 默认的 hide-scrollbars 参数。
6. 首轮组合预览通过 900／1440px 深浅色、真实顶栏位置、生成与普通通知分流和纵向／双向／文本滚动演示。用户反馈滚动条改为 50% 透明度、宽度缩窄 20%、斜纹线厚减半，且仅滚动时浮现；因此候选调整为 4px 滑块／1px 斜条，并移除悬停触发显示。
7. 用户继续要求先隐藏素材库右侧素材大小调整栏，另行考虑位置；按此明确指令在主屏 LibraryHome 范围隐藏原尺寸栏（包括多栏），保留既有尺寸状态。新位置建议顶部展示工具中的按需滑杆，目前不新增替代入口。铃铛与通用滚动条仍以独立候选待确认。
8. 审查真实复现并修复隐藏滑块子节点仍拦截点击、空闲永久逐帧测量、重复挂载双轨、调用方滚动条名称丢失，以及拖拽期间删除区域后交互锁未释放。修复均在候选中验证，不提前替换正式滚动条。
9. 准备正式小范围补丁与隔离 App 适配验证：通知明确标记 generation 渠道、普通提示保留；原滚动包装器保留 DOM／引用／名称，根组件及独立包装器共用引用计数。补丁暂存于本机 `.tmp/notifications-scrollbars/`，等待界面确认后应用。
10. 用户明确回复“同意，请实装”后应用已审查方案。`SidebarAccount` 在 Bcoin 左侧挂载正式 `NotificationBell`，移除 `HomeWorkspace` 旧任务区。完成通知以明确 generation 渠道进入铃铛，`ToastViewport` 保留其他反馈；原任务导航和通知／声音设置继续复用。
11. 将 `OverlayScrollbars` 接入正式根入口；`CollectionScrollArea` 保留调用契约、原滚动节点、名称和 ref，删除旧的独立轨道状态与测量逻辑。清除主题、侧栏、素材、菜单、标注等位置的旧 10px／thin／独立隐藏规则，样式统一由共用实现负责。
12. 独立确认稿改为复用正式组件，移除临时通知渠道桥和顶栏 portal；正式 App 回归直接加载源码。更新原通知测试的入口，保留草稿、失败、任务历史、准确轮次、设置和去重断言。
13. 默认沙箱的 pnpm／Vite 路径解析触发 EPERM，完整 TypeScript 也出现 28 项 ProseMirror／Plate 依赖类型误报；确认 Windows junction 的 `realpathSync.native` 被沙箱拦截。同一 TypeScript 命令在已有授权环境通过，独立 Vite 构建通过，没有修改依赖或降低类型检查。
14. 正式两个组件重新冻结运行 crapper／dryer，核对状态函数与既有变异快照完全一致。更新现行规范及 PROJECT 实装状态，将被挤出前三的 Windows 发布里程碑原样移入进展归档；其他聊天修改保留，提交仅包含本轮内容。
15. 独立审查发现新通知的关闭按钮卸载后丢失键盘焦点：补充真实键盘关闭的失败断言，再让关闭按钮复用恢复铃铛焦点的 dismiss；查看画板仍沿原导航处理，回归通过。重新冻结正式质量工具输入。
16. 核查独立 `screenshot.html` 入口，发现截图历史也有滚动区域，补挂同一个轻量管理器。真实独立入口验证原生 15px 槽消失、透明背景保持、关闭历史不取消截图；未引入主应用启动依赖。
17. 正式 main／App 隔离验证素材库、项目菜单、主屏及画板输入框、铃铛历史与设置；设置在窄高窗口自然溢出后测量。所有区域零槽、4px／50% 与原 DOM 身份通过，选择和关闭操作可用。重新检查 900／1440px 深浅主题确认稿。

## 状态与证据

已获用户明确确认，铃铛和统一滚动条已接入正式源码；主屏尺寸栏保持隐藏，替代入口未定。没有操作用户库、调用模型或打包发布。

- `scripts/notification-bell-preview-ui.test.mjs`：4 秒无操作收起、连续通知重计时、阅读／焦点保持、手动历史、未读点、设置开关、普通提示分流及准确导航通过。
- `scripts/overlay-scrollbars-preview-ui.test.mjs`：真实系统滚动条开启时双轴零占宽；滚动专属显现、50%／4px／1px、退场与点击穿透；拖拽、键盘、缩放、裁剪、虚拟列表滚轮映射、编辑器 DOM、原生 dialog、动态内容、引用计数及移除中清理通过。空闲窗口内测量次数无持续增长。
- `scripts/notifications-scrollbars-preview-ui.test.mjs`：900／1440px 深浅主题、顶栏位置、通知与菜单、滚动展示通过；尺寸栏隐藏后生成框宽度、居中和底部位置保持。
- 候选 TypeScript、待接入真实 App 的 Vite overlay 回归及滚动包装器 StrictMode／ref 兼容通过。未把合成 Chromium 验证计为 Windows WebView2、Mac 或完整正式接入验收。
- ub-mode：最终两个候选 TSX 的 crapper 静态复杂度最大 9，dryer 阈值 0.8 无重复候选；覆盖率与 CRAP 为 N/A。铃铛纯状态函数定向 12 处变异全部被行为序列杀死，其他 46 个发现站点未执行；不将该范围报告为整组件覆盖率。

正式接入后新增证据：

- `notification-bell-app-ui`：真实 App 顶栏只有一个铃铛、Bcoin／更新入口位置、后台生成、通知分流、原画板／轮次定位、草稿及普通保存／错误提示通过。
- `notification-bell-preview-ui`、`library-generation-notices-ui`、`library-generation-navigation-ui`、`library-generation-live-ui`、`generation-notifications-ui` 使用正式通知组件／渠道后通过。
- `overlay-scrollbars-preview-ui` 改为直接加载正式模块后通过；`overlay-scrollbar-adapter-ui` 覆盖 StrictMode、callback／object ref、原标签和最后一个实例卸载清理，通过。
- `overlay-scrollbars-app-ui` 覆盖真实主入口六类滚动区域；`overlay-scrollbars-screenshot-ui` 覆盖独立截图入口历史，通过。截图见 `apps/desktop/.tmp/overlay-scrollbars-production/`。最新通知键盘关闭恢复铃铛焦点的新增断言先失败、修复后通过。
- 本轮隔离快照（HEAD `cdcb0306` 完整源码＋本轮正式改动，原 tsconfig）完整 TypeScript 与工作区独立 Vite 生产构建通过。正式静态扫描为 49 个函数、最大 CC 9，dryer 阈值 0.8 无重复候选，CRAP／覆盖率仍为 N/A；仅 bellState 继承经等价核验的 12／12 定向变异证据，不能推导全组件覆盖率。报告见 `.tmp/notifications-scrollbars/quality-production/`。
- 既有 `collection-panel-ui`、`library-selection-layout-ui`、`library-tag-hover`、`material-catalog-ui` 均在旧素材／按钮入口处失败，尚未执行滚动条断言；对 HEAD `cdcb0306` 的只读 fixture 对照复现相同缺失。没有修改这些脚本或放宽断言，四项不计为通过；本轮滚动行为由上述正式入口及专项覆盖。证据见 `.tmp/notifications-scrollbars/old-scroll-tests-review.txt` 和 `old-scroll-tests-baseline.json`。
- 收尾时其他聊天正并发修改文档编辑器，工作区完整 TypeScript 新增 4 项诊断（CanvasWorkflowLayer 的 document 键、TextPlateEditor 的可空选区、TextWorkspace 两处 ES2021 `.at`）；与上文已定位的沙箱解析误报分别记录。本轮通过独立源码快照完整类型检查确认，未修改这些并行文件或放宽 tsconfig。证据见 `.tmp/notifications-scrollbars/owned-typecheck/`。
- Chromium 使用隔离合成数据与真实生产组件；不等于 Windows WebView2／Mac 或安装包验收。

审计证据：`.tmp/scrollbar-audit/`；候选与待接入证据：`.tmp/notifications-scrollbars/`、`apps/desktop/.tmp/{notifications-scrollbars,scrollbar-candidate}/`。独立预览入口为 `apps/desktop/scripts/fixtures/notifications-scrollbars/preview.html`。
