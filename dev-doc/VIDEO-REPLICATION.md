# 画板工具箱：视频复刻

协议与验收记录，产品范围和发布状态以 `PROJECT.md` 为准。参考源为 EfficientCut 的 `docs/REPLICATION_PORTING.md`（2026-10-16）。

## 入口与宿主适配

画板左侧「工具」分组位于磁吸辅助分组上方；工具箱按钮打开气泡菜单，首项「视频复刻工具」。面板使用 Bowerbird 的 ModalShell、主题变量、播放器和项目身份。三个操作独立提交，不因切换或带入文本调用模型。

- 分析：本地视频、素材库视频或抖音获取结果，最大 200 MiB / 120 秒。参考文件复制到库内独立目录，保存 SHA-256，回看校验内容；源文件更换不覆盖历史。
- 改写：文本、人设、规范、可选产品文字快照；可保存默认值、对照原文、编辑保存和新建版本。轮询和面板内切换记录保留未保存编辑；关闭面板前仍须点击保存。
- 生成：沿用 Bowerbird 的普通视频生成会话、登录/权益、Cloud 或即梦 Seedance 2.5、原任务恢复和产物入库，不创建另一条生成管线。产品仅保存必要文字资料，不移植 EfficientCut 独立产品管理系统。提示词 1–12000 字，4–12 秒，720p，六档画幅。
- 与参考工具的差异：普通生成管线自动保存结果到项目素材及画板；复刻历史中的显式按钮补写产品/场景/卖点/标签来源元数据。`#ai生成` 在该关联完成后固定保留，重复关联幂等。下载使用原生保存对话框。

## 本地契约

`video_replication` 单一命令带 `projectId/action/data`。记录位于素材库 `video-replication/<32 位 UUID>/record.json`，临时文件刷盘后原子改名。`preferences.json` 保存工具内产品文字和改写默认值，不含密钥。任务、来源和结果按项目校验；读操作允许未物化画板，首次写入前物化。

分析代理经现有 FFmpeg 发现器生成：640 像素边界、10 fps、H.264、无音轨、最多 35 MiB。当前使用 CPU 转码，超时 300 秒。Worker 在调用模型前再次用 ffprobe 核验真实时长、尺寸和帧率。没有模型 token 使用数据时界面显示「未记录」，不推算。

分析/改写创建前保存 `submissionPending`；响应包含 Cloud job ID 后持久化。重启/断线恢复仅使用原 job ID，或经 `get-by-key` 查询原幂等键；未知提交不重投。已完成结果不能通过恢复覆盖。视频生成使用固定 jobId/turnKey 绑定现有会话。

## 抖音获取

接收完整分享文案、`v.douyin.com` 短链、作品链接及 `modal_id`；要求单个 HTTPS 视频目标。使用应用自己的隐藏原生 WebView，资料目录 `app_data/replication-douyin-browser`，与探索及系统浏览器隔离。macOS 指定专用 data-store identifier；原生验收需在目标 macOS 版本补做。

先后台观察 45 秒；未取得视频时提供「打开登录 / 验证窗口」，显式打开后等待最多 600 秒。只观察目标作品正常页面数据和 detail 响应，核对作品 ID；不改签名或改写去水印地址。图文、DRM、超长视频返回明确错误。获取、登录、取消及重试均有本地记录；只允许一个获取任务使用该资料目录。关闭面板不取消后台获取，重新打开可查询并选用已有结果。

获取与分析分离：成功后点击「使用此视频」才填回参考素材，再点击分析才上传 Cloud。来源保留原分享文案、原链接、规范化作品地址和作品 ID。历史播放不重新下载。

下载只接受抖音媒体域名的 HTTPS 地址，逐次检查重定向、公网 DNS 并固定解析地址，限制 200 MiB 和单地址 120 秒；最多尝试六个原始播放地址。下载不导出 Cookie、不使用应用凭据，使用页面 User-Agent 和作品 Referer；若 CDN 还要求 Cookie，会明确失败，可改用本地视频。成功后经真实视频解析和时长校验再保存。取消只关闭本功能创建的窗口及任务，不终止用户浏览器。未声明所有作品均可免登录获取。

## Cloud 与启价边界

复用 `understand_jobs`、租约、暂存、任务所有权和积分结算，不引入 Agent Runner。新增操作 `video-analysis` / `text-rewrite`，始终走异步队列。模型由 Worker 环境变量 `ARK_REPLICATION_VIDEO_MODEL` / `ARK_REPLICATION_TEXT_MODEL` 显式配置，凭据沿用服务端 Ark 配置，不下发桌面。

独立服务项为 `replication_video_analysis` 与 `replication_text_rewrite`，不消耗免费反推次数，不借用 caption 价格。服务端和 UI 共同检查：`active=true`、`parameters.pricing_ready=true`、`unit_cost>0` 才开放。迁移 `0062_video_replication.sql` **不写入价格行**。本次不启价、不部署、不调用真实模型。

后续部署顺序：0062 迁移 → 配好明确模型的 Worker → understand-proxy → 桌面。Worker 镜像需有 ffprobe；当前视频生成镜像已有对应依赖。未启价期间功能仍保持拒绝模型提交。启价需另行完成真实模型参数、用量/账单和恢复验收。回滚 Edge/Worker 前须处理新操作的排队任务；旧 Worker 不识别它们。

## 验证入口

2026-10-16 本地验收：桌面/采集逻辑 4 项、Rust 专项 5 项、Worker 及理解回归 20 项、隔离 React UI 与隐藏 WebView2 返回通道通过；桌面/Worker TypeScript、Rust 编译及 Edge 类型检查通过。原生夹具首轮因手动重复嵌入 manifest 链接失败、随后因合成 HTML 未声明 UTF-8 发生中文断言失败，修正夹具后通过。

- 桌面 `node --test scripts/video-replication.test.mjs scripts/video-replication-capture.test.mjs`：四项输入/独立操作/目标匹配/原始地址/受保护内容测试。
- 桌面 `node scripts/video-replication-ui.test.mjs`：实际 React 组件的隔离 IPC；工具箱键盘、未启价、抖音登录回填不自动分析、历史保存/原文、轮询与切换保留编辑、带入不生成、暗色/窄窗。
- Rust `cargo test --lib --offline commands::video_replication -- --nocapture`：分享解析、域名/公网目标、非目标/图文/DRM、项目隔离、文件哈希、原文保留和固定标签。
- Worker `node --experimental-strip-types --test src/cloud-understand/replication.test.ts src/cloud-understand/runtime.test.ts`：独立启价门控、真实代理参数、请求契约、截断/分镜格式、未知结果不重投，及既有理解回归。
- Windows 原生返回通道：先 `cargo build --offline --example replication_browser_smoke`，再在桌面目录执行 `node scripts/video-replication-native.test.mjs`。夹具仅访问本机合成页面、使用独立 profile；不运行生产初始化，不读取用户库。当前 build.rs 已为 example 链接 manifest，不能再手动叠加 `/MANIFESTINPUT`。
- 编译：桌面与 Worker TypeScript、Rust lib，以及 `deno check supabase/functions/understand-proxy/index.ts`。

上述模拟与原生合成站点验证不等于真实抖音登录、真实 CDN 下载、macOS 原生或付费模型验收；这些仍需目标账号/作品和正式构建验证。截图及原生夹具输出位于桌面 `.tmp/video-replication/`。
