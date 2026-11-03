# 集合视图右键菜单修复记录

1. 读取现行 PROJECT、视觉规范与连接式素材库文档，追踪 ConnectedCollections → ContextMenu。上一轮恢复的基础 CSS 仍存在，本次缺失在菜单项的样式类。
2. 添加隔离回归 `scripts/connected-context-style-ui.test.mjs`，使用正式集合组件、模拟 IPC 与真实主题样式。修正最初测试中错误的 DOM 选择器后，修改产品代码前复现：菜单项高度为 18px，未达到共用菜单的 32px 整行点击区域。
3. 仅为共用 menuButton 补上 `app-context-item`，集合、单素材及多选菜单沿用同一入口。无新的 CSS、布局分支或操作逻辑。
4. 新回归通过深浅色、逐行宽高／无重叠、直角、End／Esc 键盘操作及右键不选中；查看 light-asset 截图确认外观。截图位于 `apps/desktop/.tmp/connected-context-style/`。
5. 既有 `connected-collections-ui.test.mjs` 通过，覆盖多选、分身、改名／删除、新建集合、折叠与定位、断开连接和来源切换。以上均为模拟 IPC 测试，没有操作真实素材。
6. 按 ub-mode 保留其他任务的工作区改动，仅提交本次补丁。crapper／dryer／mutator 当前不可用，不虚报检查；没有新增业务函数。此前远程推送未获自动审批，本次不重试同一受阻操作。
