# Pinterest 以图搜图自动交付修复

## 需求与行动

- 用户反馈点击「以图搜图」仅打开 Pinterest，持续显示「正在准备搜图」，仍需手动选图；本次按 ub-mode 修复自动带图到结果页的实际链路。
- 开工读取 ub-mode、PROJECT 当前进展与约定、架构复用地图、内置浏览器协议、原搜图开发记录、错误展示与 Windows 验证约束。记忆索引没有相关命中。
- 工作区存在其他任务的画板、文本与创作预览修改；仅修改本任务明确文件，不清理未知归属产物。
- 并行审查原生命令／加载通知、Pinterest 公开上传行为与前端状态；现有合成页面通过不能作为真实网站功能已验收的证据。
- 复用现有素材原件准备、Pinterest 单次请求状态、内置探索 WebView 与 Lens 文件交付；不新增图床、素材副本或独立浏览器。
- 新增原生慢资源红测：Lens 控件已可用且文档 interactive，但一个无关图片请求未结束，7 秒内仍只有 preparing 且没有 File 交付；释放该请求后同一任务立即进入搜图。根因为仅依赖 NavigationCompleted／Finished 注入，见隔离证据 `apps/desktop/.tmp/pinterest-loading-native-1793675677521/result.json`。
- 核对本机 Wry 实现：Windows Started 对应 ContentLoading，Mac 对应 did_commit_navigation，均已进入新文档。采用同时在 Started／Finished 尝试注入的最小修复，保留旧文档门槛与 requestId 去重。
- 实时 Pinterest 公开 bundle 再次确认原生 Lens button、精确文件输入与 change 自动上传协议；点击处理是开关弹层。适配器仅在弹层尚未出现时有界重试，处理 SSR 按钮早于 React handler 的窗口。
- 适配器先红后绿：旧实现派发 change 即报告 submitted；新实现交付一次后等待 `/lens-search/`，识别 `aria-invalid` 与 120 秒上传等待超时。跨文档 handoff 状态只跟踪结果，不再次发送图片。
- 用户追加要求：探索打开时保留素材库／项目切换入口，集合／标签视图切换不关闭探索；并行定位和验证该前端导航问题。
- 通过 computer-use 只读查看 Bowerbird 当前窗口，未操作真实图片、登录或网页上传；当前不是报错现场，不计作复现或真实服务验收。
- 既有前端测试初次被沙箱限制本机网络及依赖 realpath，原命令在获准的沙箱外运行通过；这是测试环境限制，不计产品失败。

## 验证与边界

- Pinterest 适配器正式 Chromium 测试 9 组通过：真实 File/change 字节、登录续办、结果路由确认、网站拒绝／超时、SSR handler 延迟、弹层 input 延迟、取消／替换、旧文档／精确来源保护。`scripts/pinterest-search-ui.test.mjs` 正式组件入口、状态、取消和原项目／选择保留通过。
- Rust 搜图与原浏览器测试 14／14 通过。新增已交付状态先红后绿，验证传图后释放像素、保留待办、迟到通知不污染新请求。
- `scripts/pinterest-search-loading-native.test.mjs` 修复后通过：资源仍 pending、`loadFired=false`、文档仍 interactive 时，收到一张 PNG 并进入 `/lens-search/`。绿证据 `apps/desktop/.tmp/pinterest-loading-native-1793676392680/result.json`。
- 增强 `scripts/pinterest-search-native.test.mjs` 通过：真实 `location.assign` 后新结果文档接收零次文件、总传图一次；原登录／取消／防重放／错误令牌／主窗口权限与站外登录返回继续通过。隔离资料 `apps/desktop/.tmp/pinterest-search-native-1793676415809`。
- 原生增量默认构建目录被其他构建占用，未停止其他任务；改用已有 `target-local-classification` 离线缓存构建例子与单测，完成后测试进程／端口均已清理。单测复制到本轮临时 EXE 后补 Common Controls manifest 执行，不替换运行中的应用。
- 原探索／来源解析逻辑 8／8 通过。完整 TypeScript 在沙箱外检查通过；沙箱内曾因已有依赖解析受限产生 ProseMirror／Plate 导出错误，没有据此修改无关编辑器。独立 Vite 生产构建通过，输出到 `apps/desktop/.tmp/pinterest-fix-build`，只有既有分包提示。
- `scripts/explore-navigation-ui.test.mjs` 四组先红后绿：主屏／画板的素材库与项目入口、集合／标签／全部切换、探索开关保留目录状态、同一网页 viewport 且无 hide／重建／导航调用、原采集目标身份、延迟保存和保存失败恢复。画板返回通过既有 `exitProject`，没有直接改项目身份。
- 900／980／1100／1440px、深浅主题的正式顶栏布局断言通过；按钮保持全窗居中、点击中心可命中且两两不重叠。发现并修正 900px 下右侧筛选覆盖“项目”的问题，仅对探索状态压缩组间距。根线程目视复核 `apps/desktop/.tmp/explore-navigation/canvas-900-dark.png` 与 `home-900-light.png`；最终 CSS 后重新构建通过。
- 旧 `home-navigation-ui.test.mjs` 在项目卡数量 `19 !== 18` 处失败；通过临时 Vite 覆盖冻结 HEAD 的 App／Toolbar／IndustrialTheme 后同样失败，确认是既有新建项目卡计数差异。本轮不改旧测试或项目卡，不将它计为通过；基线日志 `.tmp/pinterest-fix/explore-quality/home-head-baseline.log`。

## 质量工具与证据

- 使用已安装的官方 crapper／dryer／mutator 及已有 Windows TS 语法适配。JS 的匿名 IIFE 不被工具直接枚举，因此临时提取保持原行号与字节内容的 8 个命名 helper；完整原 IIFE 执行正式浏览器测试，以真实 V8 覆盖率生成 LCOV。helper 最高 CRAP 9.0（严格阈值 9.99 通过），dryer 阈值 0.8 无重复。它不是外围 IIFE 的整体评分，也不声称穷尽所有布尔组合；全脚本实测行覆盖 97.95%，交付异常分支仍未覆盖。
- 官方 mutator 从完整脚本生成 49 个原始位点，选择「交付标记」「结果路由」「hydration 重试」3 个变异，在隔离完整副本中运行正式测试，3 个均被行为断言杀死，0 存活；不是全量变异分数。生产适配器与验证副本 SHA256 均为 `6977e6afefe893e65e818faa271b54862076ca04201f459ec58adaa7301cb056`。
- 实际尝试 Rust crapper／dryer 均因本机缺少 Rust grammar 失败，未产生 Rust 评分，不以空报告算通过。未为评分重构既有原生大函数。
- 导航部分另实际运行 crapper／dryer：既有 App／Toolbar 整体函数 CC 为 215／50，精确提取的 exitCreative helper CC 为 3，没有覆盖输入故 CRAP 为 N/A，未声称达到阈值；dryer 0.8 无重复。官方 mutator 生成首页可见条件 `||`→`&&`，仅通过临时 Vite 覆盖运行完整 App 测试，画板入口断言将其杀死（1／1），不改正式文件。仅为本轮几处条件和保存顺序修复，不扩大重构旧大组件。
- 本机详细证据：`.tmp/pinterest-fix/research-log.md`、`.tmp/pinterest-fix/quality/`、`.tmp/pinterest-fix/native-repro-log.md`、`.tmp/pinterest-search/native-log.md`、`.tmp/pinterest-fix/explore-navigation-log.md`。
- 实时一手依据：[Pinterest Lens 帮助](https://help.pinterest.com/en/article/pinterest-lens)、[Lens 组件](https://s.pinimg.com/webapp/39083-dd8e72670f0c37bb.mjs)、[FileUpload 组件](https://s.pinimg.com/webapp/39731-15b4ef8be77e2b69.mjs)、[原生按钮实现](https://s.pinimg.com/webapp/gestalt-779ab6d83520eab7.mjs)。公开资料读取未使用账号或上传图片，公开 bundle 证明协议，不替代登录态验收。

## 交付范围

- 本轮修改源码，不发布安装包、不操作用户真实素材库、不终止用户开发应用、不使用付费模型。原生改动需要配套重建并重启后端才会在当前开发实例生效；前端热更新不会更新运行中的原生代码。
- 真实 Pinterest 账号、地区／语言差异、真实网站图片上传和 Mac 原生仍未实测。原生回归使用隔离库与拦截的合成 Pinterest 页面，不能据此声称真实服务已验收。
- 核对 worktree 列表：本轮未创建 worktree；已有其他聊天／历史 worktree 与未提交改动不清理。只暂存本次明确文件，代码与文档同次提交。
