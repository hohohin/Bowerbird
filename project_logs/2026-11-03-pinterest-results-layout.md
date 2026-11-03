# Pinterest 搜图结果纵向布局

## 需求与行动

- 用户要求探索窄面板内顶部小幅呈现搜图原素材，下方呈现 Pinterest 搜图结果的纵向瀑布流，不必把探索拉宽才能看到结果。
- 延续 ub-mode；读取当前项目约定、内置浏览器协议、开发计划复用入口与 UI 规范，使用 ui-ux-pro-max 的窄视口／纵向滚动建议。只采用内容适应视口和保持自然滚动，不新增装饰说明。
- 记忆索引没有相关命中。工作区有其他任务的编辑器、创作预览等修改，保留这些改动。
- 并行核对 Pinterest 当前公开 Lens 结果结构、现有注入生命周期与拖拽采集验证。优先调整原网页布局，保留站点结果、分页、点击和采集，避免新增私有搜索 API 或另一套结果数据。
- 公开当前 LensPage 固定传入原图宽 520，LensImage 加上 16 后产生 536px 占位；共同父级固定横向 Flex，无窄屏分支。原图 Image 内部还有按自然比例撑高的 wrapper，只改图片高度会遗留空白。
- 选择独立文档初始化布局适配器，与一次性上传状态分开；仅精确 Pinterest 顶层的 `/lens-search/` 作用。采用验证过的原图／占位／结果三兄弟关系，不依赖混淆类名；页面结构不匹配则保持原站。
- 上方原图按只读预览处理，保留原图节点、完整比例和最多 160px 高度；隐藏固定坐标的原生裁剪层和源图动作，避免缩小后坐标错位。重置原图祖先的固定尺寸和比例 padding，原节点与图片内容不复制、不入库。
- 结果继续由 Pinterest 自己的 DOM、流式 Masonry、窗口滚动与 fetchMore 驱动；不改卡片尺寸／transform、不克隆／移动结果节点。SPA 进入／离开、结果换挂和原图 wrapper 变化同步添加或撤销自有标记，保留原内联样式以便原样恢复。
- Chromium 正式结构夹具先红：原图固定高度与右侧占位挡住结果。初版独立脚本后四种宽度、真实 File 拖动、Pin 点击／返回、追加结果和纯历史导航初步通过；随后按公开源码补齐比例 wrapper、流式列宽与侧栏可用宽度，避免简化夹具掩盖问题。
- 只读查看当前应用窗口未获得有效搜图现场，不把该截图视作真实页面验收；后续均用隔离资料验证。

## 验证与边界

- 正式 Chromium 行为测试 `node scripts/pinterest-layout.test.mjs`：基线 6 红 1 绿，最终扩展 10/10 通过。覆盖 300／360／480／720px、侧栏占 72px 后剩余 228px、长图换横图、React 重建比例祖先但保留原图、纯 History 切换、Pin 点击／返回、分页与原节点身份。四种宽度及侧栏用真实浏览器 dragstart/drop 验证高分辨率图片 URL 和 Pin 来源，未声称 OS 跨应用拖放。
- 主线程与测试代理目视 `apps/desktop/.tmp/pinterest-layout/lens-300.png`、`lens-480.png`、`lens-300-sidebar.png`：原图完整缩至 160px，结果随可用宽度排布，没有横向溢出。测试记录 `apps/desktop/.tmp/pinterest-layout/result.json`、`.tmp/pinterest-layout/test-log.md`。
- 旧原生二进制先红：原图 496px，高于 160px，证据 `apps/desktop/.tmp/pinterest-layout-native-1793678001633/result.json`。通过 `cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example pinterest_search_smoke` 编译隔离 smoke，随后运行 `scripts/pinterest-layout-native.test.mjs`。
- 拆分路径查找与结构解析后重新编译并验证最终嵌入字节，最终原生布局 10 个检查点通过；覆盖真实文档初始化、同文档进入搜图、Pin／原生返回、真实 resize 隐藏恢复、窗口滚动分页及真实 start_pinterest_image_search 命令交图后进入上下布局。证据 `apps/desktop/.tmp/pinterest-layout-native-1793678389374/result.json`；记录布局脚本 SHA256 `d5276644bb46f74e4a23ed6e37b96111827a4fcd766066c12a4d3d4455556808`，二进制还断言包含当前上传与布局脚本原字节。
- 回归原有 `scripts/pinterest-adapter.test.mjs` 的 9 组行为通过。最终 `scripts/pinterest-search-native.test.mjs` 全组通过，包含登录续办、单次交图、跨文档不重复、取消／替换、主窗口边界与会话持久化；隔离资料位于 `apps/desktop/.tmp/pinterest-search-native-1793678409628`。两个原生测试进程均退出并清理，未触碰用户应用进程。
- 按 ub-mode 实际运行 crapper／dryer／mutator。工具不能分析匿名 IIFE，使用原函数字节与原行号提取的具名 helper 投影；执行仍用完整产品 IIFE 和正式浏览器测试，V8 覆盖通过 v8-to-istanbul 转 LCOV。校正 Playwright addInitScript 的 15 字符 wrapper 偏移后，行覆盖 100%、V8 分支 89.47%，helper CRAP 最高 7.2，阈值 9.99 通过；不把 helper 指标说成整个 IIFE 评分。dryer 0.8 阈值无重复。mutator 生成 33 位点，定向执行路径条件、结果兄弟筛选、祖先遍历 3 个变异，3/3 杀死；不是全量变异通过。
- 独立只读复核未发现阻断项：布局撤销、历史导航原语义、图片比例链、外站／子 frame 隔离及结果 DOM 所有权保持。产品改动仅独立布局脚本与既有 WebView 初始化一行，无前端应用逻辑或数据库修改。

## 结构来源与复跑范围

- 2026-11-03 当前官方公开 [Lens 组件 bundle](https://s.pinimg.com/webapp/22146-e26142f5b001fd15.mjs)、[Lens Feed bundle](https://s.pinimg.com/webapp/69208-d87dc341fc41fc29.mjs)、[Gestalt bundle](https://s.pinimg.com/webapp/gestalt-779ab6d83520eab7.mjs) 提供原图三兄弟、520／536px 宽度、流式列宽与原生窗口滚动依据。完整研究及公开响应清单在 `.tmp/pinterest-layout/research.md`，测试夹具的最小契约及环境变量写入 `apps/desktop/scripts/fixtures/pinterest-layout/README.md`。
- 从当前官方 bundle 提取纯列数／定位模块在隔离 VM 直接执行，228px 宽产生 212px 卡片、212px 宽产生 196px 卡片，位置保持在可用宽度内；旧固定列宽算法作为反例会溢出。结果在 `.tmp/pinterest-layout/native-grid-results.json`。这只核验当前默认流式分支，不代表所有账号实验配置。
- 普通布局测试用 Chromium 合成页面；原生测试用真实 WebView2、临时库／合成图片／隔离资料和拦截站点响应。均不访问用户库或真实账号。站点完整 React 虚拟化、真实分页请求、登录账号／地区差异、Mac 原生及发布安装包尚未验收。
- 此变更由 Rust 嵌入 JavaScript，正在运行的旧后端不会因前端热更新获得它；需重新构建并启动桌面开发实例。未关闭或重启用户正在使用的应用，未发布安装包。

## 交付

- 更新 `PROJECT.md` 约定与 `dev-doc/EMBEDDED-BROWSER.md` 专项说明，同代码／测试一起提交。仅提交本次九个文件，保留并行任务的编辑器、画布与原生拖动修改。
- JavaScript 语法检查、最终差异空白检查通过。按 ub-mode 提交到当前 dev 并推送 origin/dev；无新建工作树，无可回收的本次独立工作树。保留本次红绿和截图证据供后续真实站点核验。
