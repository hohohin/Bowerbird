# 探索：内置浏览器与拖图采集

截至 2026-09-17，探索已纳入当前 Windows 本地安装包。9 月 10 日拖图修复后用户确认采集成功，后续仍报告原生网页可滚动但无法点击，此问题待定位。下文自动化与隔离 WebView2 证据不代表真实站点、账号、验证码及所有图片类型均已验收；当前决策以 `PROJECT.md` 为准。

2026-09-15 维度环避让修复：`SourceBrowserPanel` 将 `.caption-ring-layer` 与模态弹窗一样视为原生网页遮挡；开环时发送隐藏 resize，收环后恢复同一网页，键盘快捷键也在环打开时让位。主网页的 CSS z-index 无法覆盖独立原生 WebView，因此不通过提高维度环 z-index 处理。

## 交互与范围

### 2026-10-17：拖动预分类与结果气泡（源码未发布）

2026-10-18 分类更新：下述历史分维度预览由统一排名取代；四角各展示一个前四候选及原始概率，≥30% 真实标签加粗，未达标项淡化。「无明显匹配项」只展示、不保存。取消纯文字归属和维度候选池，只有没有真实标签达到门槛时才在成功采集后请求 Cloud，沿用任务锁、人工保护、自动处理门控及采集事务。验证：`local_classification` 62 passed / 6 ignored，TypeScript、分类面板和 `explorer-motion` 隔离回归通过；未调用真实模型或打包。

三阶段动效（10 月 17 日历史候选展示，以上述更新为准）：网页起拖时用自绘卡片替换原半透明图片拖影，从原图位置在 340ms 内收拢到手形标记旁；进入应用主视图后接续跟随光标，Jev 返回后在持图卡片左上、右上、左下、右下分别展开主体、类型、风格、氛围 / 情绪候选，前端隐藏维度标题；每组三项以扇形向外展开，显示原始概率及百分比，第一项加粗，第二、第三项透明度分别为 76%、52%，注明「Jev 候选概率」。「无匹配」参与前三排名；不足三项按实际数量显示，未调用 Jev 的空候选池不编造概率。前三项不重新归一化，低于 0.1% 的非零值显示 `<0.1%`；长名称省略时保留完整概率，气泡随画布边缘避让。预分析通过限定 `main` WebView 的事件推送缩略图及候选，不向第三方网页注入素材库标签，不提前保存归属或启动 Cloud。松手后卡片在 560ms 内快速下坠、压缩回弹并扩散落点环；慢速采集保留「采集中…」卡片，成功后衔接实际素材/本次画板节点，失败清理临时卡片。既有冻结落点、重复采集实例、最终保存反馈及自动处理开关保持。

三维概率增量验证：Rust 分类 61 passed / 6 ignored，新增模拟 Jev 请求验证无素材 ID 的预分析仍保留三个维度原始概率、前三排序、无匹配及原分类决策，空候选池不调用 Jev、不编造数值。TypeScript、`explorer-motion`、`explorer-feedback` 及七种 `explorer-drag` 场景通过；气泡覆盖低概率、选中项、候选不足三项、空库、长标签纯文本、浅深色、上下边缘与窄窗口。截图沿用 `apps/desktop/.tmp/explorer-motion/`（新增 `05-narrow-ranks.png`），Rust 日志 `.tmp/explorer-ranks-rust.log`。本增量未调用真实模型、重跑原生 WebView2 或打包发布。

网页与主视图共用 `src/lib/explorerDragVisual.js`，Shadow DOM 隔离站点样式，装饰层不接收指针；原生拖放及系统小光标保留，系统拖影使用透明画布替换。标签只使用文本节点；旧拖动结果不能覆盖新图，拖动结束、Esc、关闭探索或切换项目清理，减少动态效果下关闭缩放/回弹。`scripts/explorer-motion.test.mjs` 覆盖真实 Chromium 起拖/取消、跨视图事件、已有标签预览、边缘避让、慢速采集落地、失败、连续拖动、项目隔离、Esc 和减少动态效果；截图在 `apps/desktop/.tmp/explorer-motion/`。七种网页拖图、原成功反馈和画板落点回归通过；画板测试仅更新已经移动的素材栏按钮定位。Rust 探索分类 5 项通过，新增只展示已有匹配标签的断言。隔离原生 WebView2 验证自绘起拖卡片、结束清理和主视图在松手前收到拖动事件，并保持 Cookie/跨域取图/远程 IPC 隔离；日志在 `apps/desktop/.tmp/explorer-motion-native.log`。原生自动化使用 CDP，Windows OS 物理拖放手感及 Mac 仍需实机确认；本轮未调用真实模型或打包发布。

- `dragstart` 在可信浏览器事件中生成一次性拖动 ID，带上图片及来源地址，通过每个原生 WebView 私有令牌的窗口请求通知后台；原生 `on_new_window` 接收后立即拒绝创建窗口，不改变原网页，只接受 `start/end` 两种消息及有限长度 HTTP(S) 地址，不开放远程 Tauri IPC。普通网页拖拽 payload 保持 version 1，新增可选 `dragId`，旧来源仍可采集。
- 已应用 Jev 图片分类、Key 非空且开启「自动处理新素材」时预分析。关闭开关只采集并显示「已采集」，不启动预分析或松手补分类；松手认领及分类提交再次检查开关。单次预览复用分类任务锁；锁忙时先取图并登记等待，松手仍可入库，分类在取得锁后继续。后台自动扫描完成已经启动的 Jev/Cloud 工作后让位，不再开始下一张；探索完成后由原轮询续扫剩余素材。手动扫描/下载不抢断；等待最多 180 秒，关闭自动处理或取消等待会退出。浏览器保持登录态取图，原字节只暂存在内存，使用有尺寸/内存上限的解码和 512 方形补白输入；主体/类型/风格/氛围匹配复用同一 `prepare_jev_image`，拖动期间不入库、不创建标签、不调用 Cloud；未归类标签可按名称/说明判断并缓存后台维度，随后各维仅匹配自己的候选池（规则见 LOCAL-CLASSIFICATION.md）。
- 主窗口松手后先认领对应拖动；预览缺失/过期时补启动，旧网页脚本未提供 ID 时主窗口生成 ID，仍校验地址与来源网页。再完成项目物化与采集；同次采集复用原字节，绑定实际入库的 asset ID 后才能提交分类。Cloud 仅补缺失维度，已有标签和人工修订保护沿原事务落地。`dragend` 后 2 秒清理未认领任务，180 秒回收未交付预览；认领后的正常分类完成/失败释放锁。分类失败保留图片并沿原策略暂停自动处理，避免轮询自动重提付费请求；停止分类沿用既有取消标志。取消不能保证撤销已经发出的远端请求或费用。
- 成功入库后，图片/本次画板实例上方显示气泡。Jev/Cloud 尚未完成时显示「已采集，正在识别标签…」；保存成功后显示实际标签「已添加到 #…」，2 秒后淡出（保持原淡入淡出速度，延长中间停留）；无匹配、识别失败和未启用分类分别显示对应提示。气泡不接收鼠标，支持减少动态效果和窄窗避让；切换项目、关闭探索或快速新采集不会让旧结果覆盖新图。画板回传本次新建节点 ID，不改变原冻结落点或多实例语义。
- 验证入口：`scripts/explorer-feedback.test.mjs`（气泡、延迟、失败、快速连续采集、项目隔离、深浅色、窄窗、减少动态效果）、原有探索/拖动/画板测试；Rust `source_browser` 与 `local_classification`；隐藏 WebView2 `verify-native-explorer.mjs` 新增松手前通知断言。真实 Jev/Cloud 时延与准确率、Mac 物理拖放需另验；不使用用户素材库，不调用付费模型，不打包。

本轮隔离验证：探索协议、七种网页拖动、探索 UI、画板采集及反馈专项通过；Windows 隐藏 WebView2 通过松手前通知和超过 5 秒拖动的结束通知，以及原网页表单/滚动、引导遮罩、Cookie 持久化、跨域取图、远程 IPC 拒绝回归。初版主页面 `location.href` 拦截通知导致测试浏览器保留待导航状态，已改用拒绝创建窗口的通知并复跑完整原生测试通过。当前 `build.rs` 已给 examples 链接 manifest 资源，旧命令额外传入 `/MANIFESTINPUT` 会报重复资源；本轮使用 `cargo build --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example explorer_smoke`。日志在 `.tmp/explorer-preview-*.log` 与 `apps/desktop/.tmp/explorer-preview-native.log`，气泡截图在 `apps/desktop/.tmp/explorer-feedback/`。这是合成站点/CDP 原生通道验证，不等同 Windows OS 物理拖拽、真实站点模型质量或 Mac 验收。

最终 TypeScript 检查、Rust 浏览器 8 项及分类 56 项通过（6 项真实模型/下载用例忽略）；复用了原有 Jev/Cloud 模拟服务与人工修订保护回归。初次沙箱构建因依赖目录读取权限失败，改在获准的非沙箱环境运行隔离检查；未据沙箱错误修改依赖。

同日反馈修复：用户只看到「已采集」，只读核验发现 Jev 图片授权和 Key 均已配置，但自动处理开关为关闭；原实现错误地将主动拖图与后台自动处理绑定，并把未启动/IPC 异常吞成普通成功。当时解除该开关依赖，增加松手补启动，并显示未应用云端分类、Key 缺失、任务忙或旧原生接口缺失的具体原因；分类请求失败另保留错误通知。新增关闭自动处理仍可获得分类配置的 Rust 回归（分类总计 57 passed / 6 ignored），反馈测试覆盖无拖动 ID 的补启动及上述未启动原因；探索 UI 与 TypeScript 检查通过。仅只读核验用户配置，未更改用户库/设置或调用真实模型。开发程序已自动重新编译并重启，正式包未更新。

用户确认分类有效后，同日要求恢复「自动处理新素材」开关控制：当前拖动预分析、松手补启动和提交均受该开关约束；关闭时正常采集并显示 2 秒「已采集」，保留开启后的分类结果气泡及异常原因提示。配置回归已改为验证关闭→开启→关闭，前端回归覆盖关闭时不提交分类。

同日持续繁忙修复：自动处理开启时，后台原来整批持有全局分类锁，探索 `try_lock` 失败即跳过；只读诊断时库中尚有 63 张当前模型未处理图片。改为取图与等待锁分离，后台自动批次协作让位，探索取得独占执行权后才重置取消标志及任务状态；取消未取得锁的预览不影响当前后台任务。后台失败暂停自动处理由该批次在释放锁前完成，避免读取后续探索任务的状态误判；未完成标签补扫不标记完成。完整分类回归 61 passed / 6 ignored，覆盖锁忙排队、开关关闭/取消、手动任务不抢断、已启动 Cloud 保存和剩余素材保留；补验续扫仅提交剩余图片。未手动改动用户库或开关、未调用真实模型验证，正式包未发布。

2026-10-17 四角扇形预览回归：`explorer-motion.test.mjs` 覆盖隐藏维度标题、四角位置、三项角度/字重/透明度、完整候选边缘避让、长名称与不足三项、减少动态效果；`explorer-feedback.test.mjs` 验证 1 秒后仍显示、2 秒后清理以及 CSS 时长一致。来源网页拖动 7 场景与 TypeScript 检查通过；浅深色及 900px 窄窗截图位于 `apps/desktop/.tmp/explorer-motion/`。未调用真实模型，未进行原生 OS 跨 WebView 拖放实测或打包发布。

### 原有交互

- 顶部“新建创作”左侧的“探索”打开左侧独立浏览器面板；右侧保留原来的主页面、素材库或画板。浏览器是附加面板，不再创建另一份素材瀑布流或覆盖主页面。中间分隔条支持拖动及方向键调整浏览器宽度，素材列数随主区可用宽度调整。
- **2026-09-14 引导调整：** 本次启动首次打开探索默认进入小红书，不再从上次网址决定首页；设计师路线的探索步骤明确导航到小红书。普通隐藏/重开继续保留当前网页，站点登录资料持久化不变。设计师在真实网页旁查看关闭登录框提示和拖图示意，原生网页上的关闭按钮由用户操作；详见 `ONBOARDING.md`。
- 快捷入口为 Pinterest、花瓣、小红书、即梦（`https://jimeng.jianying.com/ai-tool/home`）；支持地址输入、前进、后退、刷新、系统浏览器打开。再次点击探索或关闭按钮返回原工作区，新建创作也会退出探索。
- 主页面和浏览器组件保持挂载，展开/收起只变更可见性和尺寸。再次展开不导航、不刷新，保留网页实例、表单、滚动位置与浏览历史；只有显式点击站点、输入网址、来源链接或刷新才发起对应导航。素材沿用原主页面的详情、挑图、右键等交互。
- 拖动网页图片或覆盖图片的卡片链接/遮罩，在右侧主页面松开才采集。遮罩只匹配同一卡片中指针位置下唯一的图片，不把普通网页链接当成图片。数据包含图片地址与同站卡片链接（找不到卡片链接时记录当前页面）；沿扩展候选工具选择 `srcset` 高清版本与常见懒加载地址。一次拖入只采一张。
- 松手时冻结项目身份。临时项目先刷新草稿写入并物化；下载期间切换项目不会把结果转存新项目；目标项目已删除则拒绝导入。没有活动项目时进入中央素材库。
- **画板落点（2026-09-10 增量）：** 拖到画板舞台时，松手即按当前平移/缩放换算并冻结画板坐标；采集成功后创建以该点为中心的素材卡片并持久化。重复采集同一资产仍创建独立卡片实例。下载中调整视口不改变落点，切换项目后仍保存到原项目，返回或重开可见；素材栏、工具栏等非画板区域松手只入库。采集失败不创建卡片，卡片保存失败另行提示。
- **画板素材栏折叠（2026-10-15 更新）：** 素材栏内提供收起按钮，收起后仅留左上角 96×36px 图标＋文字横向标签，与项目名称及缩放栏同高对齐，工具栏在其下方左对齐，释放整条素材栏宽度；开关采用 420ms 轻微回弹，拖动调宽即时响应，支持减少动态效果与键盘操作。打开探索自动收起，探索期间可手动展开；关闭探索后保持当前状态。内容与分隔条隐藏但组件不卸载，来源选项、宽度、原有卡片与画板视口保留；开关不放入画板工具条。当前交互权威见 `PROJECT.md`，本轮仅源码与隔离 Chromium 验证，未打包。
- 图片复用 `ingest_from_bytes(..., "extension")`，沿用真实格式识别、缩略图、提色、dHash 去重与现有自动处理策略。此首版不做批量页面采集、CSS 背景图、blob/data URL、视频或网站专属原图接口。

## 本地登录状态与权限

`source_browser.rs` 复用已有 `source-discovery` 子 WebView。网站资料固定在应用数据目录的 `source-browser` 子目录，独立于主应用 WebView；关闭面板只隐藏视图，重启后复用同一资料目录。网站持久 Cookie/存储由 WebView2 管理；用户首次需要在内置浏览器登录，网站主动退出、Cookie 到期或风控仍可能要求重登。不会导入系统 Chrome/Edge 的账户。

第三方网页只允许 HTTP(S) 导航，不含 URL 内嵌用户名/密码；不授予 Bowerbird IPC、文件读取或 Agent 工具能力。能力文件继续仅匹配本地 `main` WebView。弹窗地址转入同一视图，原生文件下载拒绝。注入脚本只写拖拽元数据，不能自行入库。

Windows 取图通过 WebView2 `CallDevToolsProtocolMethod` 的 `Network.loadNetworkResource`，带当前浏览器凭据和网络环境，流式读取后交给本地入库；不导出 Cookie，不让 Rust 重新使用无登录态的 HTTP 客户端下载。主窗口命令检查调用者、HTTP(S) 地址、来源站点与当前浏览器 origin 一致、目标项目存在。图片最多 50 MiB，单次协议调用超时 45 秒，拒绝非图片/损坏内容。现有上传管线支持 JPEG/PNG/WebP/GIF/BMP；此接口不接受 SVG。

2026-09-15 macOS 补齐取图：在当前 WKWebView 上调用 `startDownloadUsingRequest`（macOS 11.3+），由浏览器处理登录 Cookie 和网络请求，WKDownloadDelegate 将字节交给同一入库管线。不导出 Cookie、不导航原页面、不新增远程页 IPC。下载使用私有临时目录，限制 50 MiB / 45 秒，拒绝 HTTP 错误、HTML 和非图片，完成或取消后清理临时文件。Linux 仍未实现此原生取图通道。

Mac 原生回归：在 `apps/desktop` 运行 `node scripts/mac-browser-capture.test.mjs`，编译生产 Objective-C 桥接与隐藏 WKWebView fixture，使用非持久资料和本机合成站点。覆盖跨端口无 CORS 的 HttpOnly Cookie 图片、重定向、未知长度分块响应、401、HTML、已知/未知长度超限、断网、45 秒超时、临时文件清理与原网页表单/JS 状态保持。此验证覆盖原生下载通道，不代表真实站点账号或 macOS 物理拖放已逐站验收。

## 相关文件

- `apps/desktop/src/components/ExploreWorkspace.tsx`：左侧附加面板、原主页面容器、拖入状态、冻结目标与物化；不再持有素材副本。
- `SourceBrowserPanel.tsx`：浏览器控件、地址记忆、串行原生操作、视图尺寸和弹窗遮挡。
- `apps/desktop/src/lib/explorer.ts`：站点、拖入协议校验、原生操作队列。
- `apps/desktop/src/lib/explorerCanvasDrop.ts` / `CanvasWorkspace.tsx`：松手同步冻结坐标、采集后卡片写入与素材栏折叠。
- `apps/desktop/src-tauri/src/commands/source_browser.rs` / `source_browser_drag.js`：持久子视图及网页拖拽元数据。
- `source_browser_network.rs` / `source_browser_capture.rs`：WebView2 网络读取、主窗口边界与标准入库。

原生子 WebView 高于 DOM 层：拖动分隔条及可见 `dialog/alertdialog`、维度环 `.caption-ring-layer` 打开时隐藏浏览器；`menu` 仅在实际矩形与浏览器 viewport 相交时隐藏，画板侧的右键菜单不影响网页。遮挡移除后恢复，不导航或刷新；临时隐藏显示说明而非加载动画，尺寸/可见性相同不重复调用原生接口。通知摆在右侧主区，避免落在原生网页下方。非路由调用画板 flush 时不锁死画板；路由切换仍同步锁定输入。

2026-09-15 入门聚光补充：`resize_source_browser` 增加可选 `dimmed`，从主界面实际 spotlight DOM 同步遮罩状态。Rust 向网页注入仅用于视觉的 `.56` 黑色顶层遮罩（支持网页原生登录 dialog），不读取页面数据、不授予 IPC；移除遮罩保留同一文档、表单和滚动位置。页面加载完成后恢复当前状态。隐藏原生 WebView2 合成站点验证、浏览器脚本和 Rust 浏览器相关 7/7 均通过；`verify-native-explorer.mjs` 新增遮罩切换不刷新及刷新后恢复断言。已纳入 26.9.15 本次本地重包；本次存档未重跑原生验证，网页无法点击的独立问题仍待定位。

2026-09-16 侧栏补充：项目侧栏自动浮出时，按其最终展开矩形判断与原生网页是否相交，相交则暂时隐藏网页，收回后恢复；维度环继续按全窗口浮层避让。侧栏及探索合成 IPC 回归通过，未重跑真实站点原生输入验收。

## 验证与复跑

2026-09-15 第三次重包后修正（已纳入 26.9.16 本地安装包）：维度环没有 dialog/menu 角色，之前漏出原生网页避让检测，环的扇区即使调高 DOM z-index 仍可能被网页盖住。SourceBrowserPanel 现将 `.caption-ring-layer` 视作全窗口浮层，开环即同步 visible:false，退出动画结束/卸载后恢复。十一步引导真实组件回归验证第 8 步开环自动进入第 9 步期间隐藏、选择反推维度后恢复及零导航/刷新；既有探索回归通过。本轮未运行真实小红书/原生 WebView2 端到端验收。

2026-09-15 接收端回归修复：`FileDropImport` 的窗口捕获监听曾把同时携带 `Files` 和探索协议的网页图片当成本地文件，截断探索采集。现在探索 MIME 或标准文本协议优先交回 `ExploreWorkspace` 校验；拖动途中只能读取类型时，探索区域的 text/files 混合拖入延后到松手判定。新增两组件同时挂载的回归，在修复前复现截流，覆盖自定义 MIME、仅标准文本、无效元数据及普通文件附带文本。探索界面、文件导入、画板落点、网页拖拽五类及 TypeScript/Vite 构建通过。用户另报网页能滚动但不能点击、光标固定，退出引导仍然发生；该原生输入故障仍在定位，不能将此接收端修复记作全部故障闭环。

2026-09-11 画板右键“刷新状态”修复：真实 CanvasWorkspace 合成 IPC 测试在修复前复现右键菜单导致 `visible:false`，其根因是全局菜单判定把未遮挡网页的菜单也当遮挡，随后露出恒定转圈的占位。改为菜单矩形相交判断、遮挡独立占位及原生布局去重；新增连续三次真实组件右键菜单、重叠菜单移动/隐藏、对话框保护与无重复原生调用断言。测试验证未发导航或刷新命令，不声称已复测用户窗口或真实站点。

2026-09-10 本次增量存档复跑：`test:explorer:canvas`、`test:explorer:ui`、`test:canvas`（111/111）和 `build`（含 TypeScript）通过。新增素材栏断言覆盖打开探索自动收起、手动/键盘切换、来源选项和宽度保留、DOM/旧卡片/视口保持、分隔条隐藏及窄窗入口；同一脚本继续覆盖下述画板落点场景。构建保留现有大 chunk 提示；本次未重跑原生/Rust 或真实站点验收，未发布安装包。日志位于本地 `.tmp/archive-explorer-*.log`。

2026-09-10 画板落点增量验证：`test:explorer:canvas` 使用真实 ExploreWorkspace + CanvasWorkspace、隔离合成 IPC，验证缩放/平移坐标转换、下载中缩放、同资产多卡片、采集失败、切换项目后原项目保存、重开坐标保留、临时项目先物化以及非画板仅入库。既有探索界面、画板/路由 111 项及 TypeScript/production build 同时通过；此增量未做用户窗口实测。

原有普通生成/Agent 引用布局断言也通过：原 `canvas-reference-ui.test.mjs` 的独立 Vite 配置首次启动在导航阶段超时，本轮临时 runner 仅改用桌面标准 Vite 配置启动，保持其布局、旧节点/视口、重复事件与重开断言原样。runner 位于本地 `.tmp/explorer-reference-regression.mjs`，不提交；不将原启动方式记为通过。

2026-09-10 用户验收：修复后反馈“采集成功了。不错，存档。”；采集故障标记为已解决，代码、测试与文档同次提交。本次存档沿用下列已通过的相关检查和用户实测结果，没有重新操作用户窗口或发布安装包。

2026-09-10 拖拽失败修复：用户反馈所有站点松手无反应。隔离页面复现两类确定缺陷：透明链接拖动的事件目标是 `A`，旧脚本只找事件路径上的 `IMG`，因此未写采集数据；网站的 window capture 监听还可先于旧 document 监听取消拖拽。改为按下时识别遮罩下图片、临时覆盖 `-webkit-user-drag:none` 并在结束时恢复、初始化阶段在 window capture 写入元数据。无效采集协议现在有错误通知。上述复现不等同于已确认每个真实网站当时的具体 DOM/失败原因。

新增 `test:explorer:drag` 的 5 种后台 Chromium 回归（普通图、链接遮罩、div 遮罩、CSS 禁拖、站点 window 取消）全部通过。用 CDP 产生浏览器原生 dragstart 和读取其数据，再送到目标 DOM；不手写采集 payload。隐藏 WebView2 进一步验证源视图生成的数据只保留标准 text/plain 后进入独立主视图，经过生产解析器并成功取回带 Cookie 的图片字节。CDP 传输验证两端浏览器处理，仍不宣称覆盖 Windows OS 物理拖放循环。未操作用户窗口、真实账号或生产库。

2026-09-10 面板调整复验：合成 IPC 界面验证浏览器在左、原主页面 DOM 与草稿在展开/收起后保留、再次展开不发送 open/navigate/reload，地址仍为用户浏览的网站。隐藏原生 WebView2 另验证 hide → open 后页面实例标记、未提交表单及 500px 滚动位置全部保留；原跨域 Cookie 取图、登录重启恢复、权限和失败分支同时通过。

桌面目录 `apps/desktop`：

```powershell
pnpm test:explorer
pnpm test:explorer:ui
pnpm test:explorer:drag
pnpm test:explorer:canvas
pnpm test:canvas
pnpm build
```

已通过：浏览器/协议纯函数 7 项、真实 React 组件合成 IPC 界面脚本、画板/路由回归 111 项、TypeScript 与 Vite production build。界面覆盖入口位置、网站导航、弹窗遮挡、非法拖入、忙碌去重、下载中切项目、临时项目物化、图片预览及 Escape、失败通知位置、窄窗和关闭生命周期。界面脚本使用本机 Chrome 与 `apps/html-renderer` 已安装的 Playwright；不启动生产 Tauri。

仓库根目录：

```powershell
cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --lib source_browser
$explorerManifest = (Resolve-Path apps/desktop/src-tauri/tests/fixtures/explorer/app.manifest).Path
cargo rustc --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example explorer_smoke -- -C link-arg=/MANIFEST:EMBED -C "link-arg=/MANIFESTINPUT:$explorerManifest"
```

Rust 专项 7 项通过，包括权限配置、地址/尺寸、二进制读取和真实图片入库、来源记录、项目归属、去重、缺失项目拒绝。其他 335 项由专项过滤器未执行，不宣称全量 Rust 回归。

编译示例后，从桌面目录运行 `node scripts/verify-native-explorer.mjs`。隐藏的原生测试仅使用合成本机站点 1557–1559 和本轮独立 `.tmp/explorer-native-*` 资料目录；不调用生产应用初始化，不打开真实用户库，不访问真实账号。9557/9558 是测试 CDP 端口，仅 debug fixture/显式测试环境变量启用，release 不读测试覆盖变量。两次启动验证：跨域无 CORS 的 Cookie 图片读取、HttpOnly 持久 Cookie 恢复、远程页 IPC 拒绝、拖图元数据；补充 401/HTML 拒绝与高清候选/来源链接检查。

测试构建须嵌入 Common Controls v6 manifest；否则 Windows 示例可能以 `0xC0000139` 在入口前退出。两个隔离 WebView2 profile 属于不同浏览器进程，各用单独调试端口。受限沙箱可能禁止 WebView2 初始化，测试需在许可的本机执行环境中运行。

本轮日志保存在本地 `.tmp/explorer-*.log`，界面截图在 `apps/desktop/.tmp/explorer-*.png`，均不随源码提交。用户已确认采集成功；四站逐站登录、验证码/站点弹窗、网络代理及全部图片类型尚无完整验收记录。自动化 CDP 传输与用户实际操作反馈分别记录，首版不承诺绕过网站访问限制。
