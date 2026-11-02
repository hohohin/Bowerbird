# 首页素材库与项目平级导航

## 决策与范围

用户确认顶部「素材库／项目」平级切换，项目管理使用完整页面；撤回 Tab 快速切页，保留素材库当前 Tab 切换素材视图的行为。按 PROJECT.md「界面改版先网页确认」约定，本轮先交付独立交互预览，待确认后接正式入口。

## 行动与证据

- 应用 ub-mode，读取 PROJECT 当前约定、UI 规范、开发计划和项目画板协议。ui-ux-pro-max 检索命中导航活动状态，采用已有工业主题；未增加新视觉体系。Crapper／Dryer／Mutator 工具未提供，不声称相应评分。
- 基线 7987de1e。已有 Cloud／赠币文档、账号组件、CanvasWorkspace 等并行修改保留；正式组件不改，候选只放 scripts/fixtures/home-navigation。
- 并行只读架构审查确认：store 已有 libraryHomeView；但 setter 清筛选、LibraryHome 挂载强制 library、Toolbar projectsOpen 模态入口以及 localFilesOpen 的探索耦合需要在正式接入时处理。无需新建顶层项目路由，也不用修改多人正在编辑的 CanvasWorkspace。
- 预览复用正式素材库、卡片、菜单、排序选择器及滚动组件；项目页去掉 ModalShell，移除重复英文目录说明，保留搜索／排序／网格列表／新建／卡片操作和尺寸控件。项目打开与新建在预览中仅演示去向，不执行真实项目持久化。
- 先写浏览器行为验证，在旧 library-tactical 入口取得真实 RED：缺少平级首页导航，0 !== 1。首次沙箱拒绝本机浏览器访问仅是环境失败，未计作行为 RED；允许对应本机回归后取得上述断言失败。
- 初版候选取得第二项行为 RED：切页后虚拟列表 scrollTop 从 400 变为 139。取消 display:none，使用保持几何的页面层及已有 PreservedWorkspace；页面保留滚动和状态，隐藏页 inert 并暂停视频。随后 GREEN。
- 独立复核指出背景使用 WAAPI，CSS animation-play-state 无法暂停；已改为仅活动项目页挂载 ProjectManagerBackdrop，隐藏时卸载该装饰，同时保留搜索等页面状态。最终回归再次 GREEN。
- 回归覆盖：同级导航、项目页非 dialog／无遮罩、素材库既有 Tab、项目页 Tab 不切页、素材滚动／项目搜索／列表模式往返保留、项目打开／创建去向，以及深浅主题 800／900／1440px。新专项 pageerror 与远程请求均为空。
- 实际查看深色 1440、浅色 800 的项目截图和浅色素材库截图，卡片／搜索／排序／新建与底部滑杆完整。内置浏览器已打开本机候选并切到项目页供确认。预览服务器保留供本轮查看，未清理其他任务临时文件。

## 后续接入边界

正式接入需复用 enterProject 的保存、scope 和串行路由链路，以及现有 provisional 项目创建；修正首页状态 setter 的清筛选行为，保留两页实例且停用隐藏页交互；探索、账号、菜单、原生返回和创建失败需正式组件回归。预览通过不等于这些入口已接入或安装包已发布。本轮没有运行 Rust、全量构建或用户库迁移。

候选及启动说明：[README](../apps/desktop/scripts/fixtures/home-navigation/README.md)。界面确认结果和后续提交状态以本次对话与 Git 为准。
