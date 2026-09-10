# 探索：内置浏览器与拖图采集

2026-09-10。Windows 首版源码已实现，用户在拖拽修复后明确确认“采集成功了”，本次采集故障已闭环；自动化与隔离 WebView2 验证见下文，尚未发安装包。用户未逐站列明验收范围，不将此次成功扩大为四站账号、验证码及所有图片类型均通过。当前产品决策以 `PROJECT.md` 为权威。

## 交互与范围

- 顶部“新建创作”左侧的“探索”打开左侧独立浏览器面板；右侧保留原来的主页面、素材库或画板。浏览器是附加面板，不再创建另一份素材瀑布流或覆盖主页面。中间分隔条支持拖动及方向键调整浏览器宽度，素材列数随主区可用宽度调整。
- 快捷入口为 Pinterest、花瓣、小红书、即梦（`https://jimeng.jianying.com/ai-tool/home`）；支持地址输入、前进、后退、刷新、系统浏览器打开。再次点击探索或关闭按钮返回原工作区，新建创作也会退出探索。
- 主页面和浏览器组件保持挂载，展开/收起只变更可见性和尺寸。再次展开不导航、不刷新，保留网页实例、表单、滚动位置与浏览历史；只有显式点击站点、输入网址、来源链接或刷新才发起对应导航。素材沿用原主页面的详情、挑图、右键等交互。
- 拖动网页图片或覆盖图片的卡片链接/遮罩，在右侧主页面松开才采集。遮罩只匹配同一卡片中指针位置下唯一的图片，不把普通网页链接当成图片。数据包含图片地址与同站卡片链接（找不到卡片链接时记录当前页面）；沿扩展候选工具选择 `srcset` 高清版本与常见懒加载地址。一次拖入只采一张。
- 松手时冻结项目身份。临时项目先刷新草稿写入并物化；下载期间切换项目不会把结果转存新项目；目标项目已删除则拒绝导入。没有活动项目时进入中央素材库。
- **画板落点（2026-09-10 增量）：** 拖到画板舞台时，松手即按当前平移/缩放换算并冻结画板坐标；采集成功后创建以该点为中心的素材卡片并持久化。重复采集同一资产仍创建独立卡片实例。下载中调整视口不改变落点，切换项目后仍保存到原项目，返回或重开可见；素材栏、工具栏等非画板区域松手只入库。采集失败不创建卡片，卡片保存失败另行提示。
- **画板素材栏折叠（2026-09-10 增量）：** 素材栏内提供收起按钮与 36px 展开窄栏，支持键盘操作。打开探索自动收起，探索期间可手动展开；关闭探索后保持当前状态。内容与分隔条隐藏但组件不卸载，来源选项、宽度、原有卡片与画板视口保留；开关不放入画板工具条。
- 图片复用 `ingest_from_bytes(..., "extension")`，沿用真实格式识别、缩略图、提色、dHash 去重与现有自动处理策略。此首版不做批量页面采集、CSS 背景图、blob/data URL、视频或网站专属原图接口。

## 本地登录状态与权限

`source_browser.rs` 复用已有 `source-discovery` 子 WebView。网站资料固定在应用数据目录的 `source-browser` 子目录，独立于主应用 WebView；关闭面板只隐藏视图，重启后复用同一资料目录。网站持久 Cookie/存储由 WebView2 管理；用户首次需要在内置浏览器登录，网站主动退出、Cookie 到期或风控仍可能要求重登。不会导入系统 Chrome/Edge 的账户。

第三方网页只允许 HTTP(S) 导航，不含 URL 内嵌用户名/密码；不授予 Bowerbird IPC、文件读取或 Agent 工具能力。能力文件继续仅匹配本地 `main` WebView。弹窗地址转入同一视图，原生文件下载拒绝。注入脚本只写拖拽元数据，不能自行入库。

Windows 取图通过 WebView2 `CallDevToolsProtocolMethod` 的 `Network.loadNetworkResource`，带当前浏览器凭据和网络环境，流式读取后交给本地入库；不导出 Cookie，不让 Rust 重新使用无登录态的 HTTP 客户端下载。主窗口命令检查调用者、HTTP(S) 地址、来源站点与当前浏览器 origin 一致、目标项目存在。图片最多 50 MiB，单次协议调用超时 45 秒，拒绝非图片/损坏内容。现有上传管线支持 JPEG/PNG/WebP/GIF/BMP；此接口不接受 SVG。

macOS/Linux 此首版保留浏览器基础能力，拖图取字节明确返回尚不支持；本轮只完成 Windows 取图实现。

## 相关文件

- `apps/desktop/src/components/ExploreWorkspace.tsx`：左侧附加面板、原主页面容器、拖入状态、冻结目标与物化；不再持有素材副本。
- `SourceBrowserPanel.tsx`：浏览器控件、地址记忆、串行原生操作、视图尺寸和弹窗遮挡。
- `apps/desktop/src/lib/explorer.ts`：站点、拖入协议校验、原生操作队列。
- `apps/desktop/src/lib/explorerCanvasDrop.ts` / `CanvasWorkspace.tsx`：松手同步冻结坐标、采集后卡片写入与素材栏折叠。
- `apps/desktop/src-tauri/src/commands/source_browser.rs` / `source_browser_drag.js`：持久子视图及网页拖拽元数据。
- `source_browser_network.rs` / `source_browser_capture.rs`：WebView2 网络读取、主窗口边界与标准入库。

原生子 WebView 高于 DOM 层：拖动分隔条及可见 `dialog/alertdialog/menu` 打开时隐藏浏览器，关闭后恢复；通知摆在右侧主区，避免落在原生网页下方。非路由调用画板 flush 时不锁死画板；路由切换仍同步锁定输入。

## 验证与复跑

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
