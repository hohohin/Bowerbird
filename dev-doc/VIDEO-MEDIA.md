# 视频预览、播放与采集

2026-11-01，桌面与浏览器扩展源码增量。产品约定以 [PROJECT.md](../PROJECT.md) 为准；未发布安装包、未部署云端。扩展 0.3.0 新增显式视频协议，旧图片协议保持兼容。

## 接口与归属

- 素材库、素材详情和画板复用 `VideoPlayer`。详情使用受父容器约束的布局，键盘仅在播放器内生效；Lightbox 内方向键定位时间，多素材切换保留显式按钮。空格、原分辨率截帧、尾帧、裁剪和覆盖保护沿用原契约。
- 播放提供音量、倍速、Fullscreen API、加载／缓冲反馈和重新加载；原始媒体诊断只在显式复制时导出。重新加载保留当前位置、音量和倍速，不自动调用模型或重新下载任务。
- 胶片按真实比例采样，完整结果进入 16 项有界缓存。缓存键包含来源地址、内容修订与采样范围；文件修订、裁剪覆盖使旧图失效。普通模式为全片 12 张，细调按当前位置补采局部窗口；时间步进仍为 0.1／0.01 秒，不宣称严格逐帧。
- `VideoHoverPreview` 只有一个全局悬停解码器，500 ms 后静音播放。多选、减少动态效果、模态窗口下不播放；离开、点击、拖动、滚动、隐藏、失焦及源修订变化释放源。没有悬停时仍只有静态封面；未知时长不显示假数值。
- 库预览与详情可保存当前帧到素材库，有当前项目时还可添加到画板。`import_image_bytes` 可选 `videoFrame={sourcePath,time}` 先校验已登记视频及有效时间，再沿现有精确字节去重入库；`analyses(kind=video_frame)` 保存源素材 ID、路径、名称、文件版本和秒数。同一来源时刻重试幂等，相同像素来自不同时刻时保留各来源。
- 画板写入由 `CanvasWorkspace` 的既有持久化队列拥有。截帧与采集交付都冻结项目及节点身份；写入失败保留重试，成功前不关闭采集弹窗，迟到结果不写进后来打开的项目。空 provisional 项目仅在实际获取／保存前物化，打开或取消采集面板不创建项目。

## 独立视频采集

素材库保留“采集视频”链接入口，不进入“更多”溢出层；空库和窄窗口仍可见。探索页按用户要求删除该按钮及“登录状态保存在本机”提示，使用下述直接拖拽。链接入口支持抖音分享文字及直接返回视频文件的 HTTP(S) 链接，不要求先做视频分析／改写；不支持通用网页解析、HLS／DASH 播放列表或任意平台下载。抖音复用原有隐藏浏览器、登录验证、任务恢复和下载实现。

- `video_collection(projectId?, action, data)` 支持 `list/create/retry/login/cancel/save`，任务存于应用受管 `video-collection` 目录，项目身份在创建时冻结；全局采集使用空项目归属。
- 下载最多 200 MiB、120 秒；协议、端口、凭据、公网地址、DNS 及每次重定向在边界校验，最终媒体必须实际可探测为有效视频。流式进度展示真实字节；总长未知时不制造百分比。取消／失败释放下载临时内容。
- 完成后用户明确保存到库或添加到画板。精确去重复用已有素材身份，不覆盖旧素材的名称、来源或原文件；本次来源保留在采集记录。新视频首次保存时登记原始链接和名称，并放行原生 asset protocol 对该结果文件的读取。
- 保存后画板回调失败，当前弹窗保留已保存 Asset；重试只补交付。已有本机文件仍按连接协议原位登记，此入口不复制用户本地视频。

## 网页视频直接拖拽

**2026-11-03 源码增量：** 内置探索已接入普通 Blob、可明确定位清单的 MediaSource、有限未加密 HLS 与静态单 Period DASH；探索工具栏右侧提供图片／视频共用的采集记录、真实进度、取消和重试。逐片完整下载后用本机 FFmpeg 合并并校验；保存与交付分开，重试不重复下载已入库视频或创建另一个画板节点。详细范围、上限、平台差异和验收见 [内置探索](EMBEDDED-BROWSER.md#2026-11-03视频流与采集记录源码未发布) 与 [行动记录](../project_logs/2026-11-03-explorer-capture.md)。此增量尚未发布；下文 11 月 1 日的流媒体拒绝规则作为历史基线，外部插件和独立链接入口仍维持各自原范围。

内置探索的网页 VIDEO 与图片共用拖拽：拖到素材库直接保存，拖到画板沿原落点交付，无选择弹窗。沿用 version 1 拖放桥和标准文本回退，新增显式视频类型；poster 仅作拖影，不能代替视频入库。视频跳过图片预分析／补分类，原图片流程保持。

接收端仍只允许主窗口调用，核对当前来源页面，使用原生浏览器会话获取完整 HTTP(S) 视频，200 MiB／120 秒；沿用视频实际媒体校验、精确去重及来源记录。松手时冻结项目与画板坐标，后续缩放或切换项目不改投。blob／MediaSource、HLS／DASH 或部分文件明确报不支持，不静默改收封面。Windows 已做隔离 WebView2 验证，Mac 仅代码同步，未原生验收。

外部插件 0.3.1 同样支持将网页视频拖到原 Bowerbird 图标直接采集；图片与视频共用忙碌和重复投放保护。点击视频候选入口的原有方式仍可使用。详见 [内置拖拽协议](EMBEDDED-BROWSER.md) 与 [插件说明](../apps/extension/README.md)。

## 验证与动作记录

浏览器扩展 0.3.0 在图片按钮旁增加“视频”，从播放器、页面视频元数据和小红书详情公开 stream 中列出候选，逐条确认后采集。浏览器内下载完整文件，经能力协商后的 `save_blob + binary` 上传；桌面真实视频校验、来源记录、冻结项目、精确去重与原子保存。旧版桌面会得到更新提示。实际文件 blob 可读，HLS／DASH、MediaSource、保护视频与 HTTP 206 部分响应明确拒绝；视频已存但预览失败时显示已保存。详见 [扩展协议与使用](../apps/extension/README.md)。

按 ub-mode 先用真实行为断言复现缺失音量、库截帧入口、竖片布局、来源污染等问题，再最小修复。所有输入为合成视频／临时库，未调用付费服务或操作用户素材。

| 入口 | 验证范围 |
|---|---|
| `scripts/video-player-upgrade-ui.test.mjs` | 真 MP4 音量／倍速／全屏、键盘、404 重试、缓冲、原尺寸、独立保存目标、比例与缓存淘汰 |
| `scripts/video-player-ui.test.mjs`、`video-trim-ui.test.mjs` | 首尾帧像素、保存重试、跨项目归属、裁剪与覆盖恢复 |
| `scripts/video-hover-ui.test.mjs` | 被动零视频请求、延迟静音、全局唯一解码器、释放及多选／减少动态效果 |
| `scripts/video-fine-strip-ui.test.mjs` | 60 秒分色实片、局部范围像素与时间对应、拖动合并、旧窗口释放和全片缓存恢复 |
| `scripts/video-library-ui.test.mjs` | 正式详情及素材库入口、原像素与来源参数、画板失败保留弹窗、同节点重试且不重复入库 |
| `scripts/video-collection-ui.test.mjs` | 取消／恢复／验证／重试、真实字节状态、未知总长、冻结项目、回调失败不重存与窄屏 |
| Rust `commands::library::video_frame` | 非法来源先拒绝、精确去重、来源身份与时间、重复保存幂等 |
| Rust `commands::video_replication` | 采集边界、实际流消费／取消、合成 MP4 校验、来源保留、同内容入库与项目约束、既有抖音回归 |
| `scripts/video-collection-entry-ui.test.mjs` | 素材库入口空库／宽窄可见、更多控件边界；探索删除提示与独立采集按钮 |
| `scripts/explorer-video-drag.test.mjs`、`explorer-video-ui.test.mjs` | 浏览器真实视频起拖、既有素材库／画板投放、冻结项目／落点与图片分类隔离 |
| `scripts/verify-native-explorer.mjs` | 隔离 WebView2 真实 VIDEO 起拖及跨视图文本传输、带 Cookie 跨源完整视频、部分响应拒绝；原图片／登录／远程 IPC 边界回归 |
| 扩展 `video.test.js`、`video-ui.test.mjs`，既有 `candidate-utils.test.js`／`collection.test.js`／`collection-ui.test.mjs` | 视频候选／确认／blob、能力协商、大小与超时、部分文件拒绝、保存回执与图片兼容 |
| Rust `extension_video_blob` | 真实 MP4、伪媒体／长度／无效项目、去重资料保护、幂等来源、事务故障清理与项目文件路径 |
| `scripts/video-extension-native.test.mjs` | 真实扩展后台→原生 WS→临时 SQLite 与媒体文件→解码播放；去重、来源、图片兼容与伪视频拒绝 |

完整类型检查和独立 Vite 生产构建使用本机正常依赖访问权限。沙箱内曾出现依赖 realpath／localhost 权限错误和 ProseMirror 类型解析差异，不记为产品测试结果。构建不覆盖正在运行的客户端。

Windows 原生 WebView2 隔离验证已通过：真实 React 播放器读取 localhost 合成 H.264 视频，首帧暂停且红色像素为 `[254,0,0,255]`；播放时间推进，暂停后输出原尺寸 320×180 PNG；卸载后视频 `src=null`、暂停且脱离 DOM。使用专用 profile／临时环境，无生产初始化或用户库。入口为 `scripts/video-player-native-ui.test.mjs` 与 `src-tauri/examples/video_player_smoke.rs`；这覆盖原生解码与组件生命周期，不代替生产 asset protocol、真实素材库写入或原生全屏验收。

详细逐步动作、红绿命令和截图位于 `.tmp/video-upgrade/*-log.md` 与 `apps/desktop/.tmp/video-*`。环境未提供 crapper／dryer／mutator 工具，因此执行编译、行为回归、人工差异与交叉审查，不宣称得到 CRAP／变异测试分数。仅保留本轮证据，不清理原有工作树或用户资料。

视频入口与扩展补齐的动作记录位于 `.tmp/video-extension/*-log.md`，原生临时库与回执位于 `apps/desktop/.tmp/video-extension-native/`。既有 `explorer-ui.test.mjs` 在进入本次场景前仍寻找已改名的“新建创作”按钮而失败，未为本轮修改无关测试；本次探索入口由新正式组件测试覆盖。

拖拽接入及探索精简记录位于 `.tmp/video-drag/*-log.md`；WebView2 CDP 测试覆盖浏览器生成及主视图接收，不等同于 Windows OS 物理拖放循环或真实站点逐一验收。

真实站点下载、macOS WKWebView 以及重新打包后的安装体验仍须各自验收，合成 Chromium 回归不代替这些结果。
