# 画板工具箱：视频复刻

**2026-10-23 发布补记：** 本页当日桌面源码已随 Windows **26.10.2301** 发布（源码 4156e8e0），下方“待发布／未打包”是专项验证时的历史状态。正式包、签名、CDN 及回滚证据见 [桌面自动更新](DESKTOP-UPDATES.md)。原有真实安装／GPU、原生 UI 和 Mac 实机验收边界继续保留。

协议与验收记录，产品范围和发布状态以 `PROJECT.md` 为准。参考源为 EfficientCut 的 `docs/REPLICATION_PORTING.md`（2026-10-16）。

## 入口与宿主适配

### 当前：以参考视频为基点的任务管理（2026-10-23）

本节替代下方 10 月 21 日两栏工作台交互；旧记录保留历史说明。

- 工具先展示当前项目的任务缩略图网格及「新建任务」。新增 `kind=case` 本地任务，独立于 `analyze/rewrite` 执行记录；尚未获取视频时显示占位图。链接在输入时自动保存，关闭／返回前刷新待保存内容，失败不退出；获取成功后的卡片通过 `reference-poster` 读取任务视频的真实首帧：校验项目归属与视频哈希，在任务目录缓存 JPEG，兼容旧任务并修复损坏封面。使用串行后台解码，不在列表后台播放。素材库 `video_poster` 仅支持已入库 assets，不能用于任务视频副本。
- 左栏固定四步：获取视频、分析视频、提供改写方向、改写完成。中间播放器在整个任务生命周期内保持挂载，右栏独立滚动／切换步骤；没有视频不能进入后续步骤，没有分析结果不能推进改写。抖音／本地／素材库三种途径使用本机偏好记忆最近选择；一个任务绑定一个参考视频，换视频须新建任务。
- 第 2 步分析结果自动填入可编辑文本框，完成后的主要动作变为「进行改写」；第 3 步只填写改写方向、人设、改写规范；分析文本沿第 2 步结果内部带入 Cloud；第 4 步编辑改写结果及明确提取的首帧提示词。重新读取 Cloud 状态不丢输入，不自动提交；抖音验证仍只高亮打开窗口动作。
- 复用播放器的暂停、时间轴、细调、当前帧／尾帧插入画板；新增独立「添加该帧为参考图」。原始尺寸 PNG 保存为 `video-frame`，任务持久保存参考帧身份，可移除重选。播放器宽度随视频实际宽高比调整，画面区域无额外左右黑边；任务内切步骤不重置播放位置；关闭重开重新加载视频。
- 第 4 步按钮显示「生成工作流」，实际行为是创建画板工作流，不再单独提交首帧生图或只插入视频对话框：图片生成卡片（编辑后的首帧提示词＋截帧）→单列内容卡片→视频生成卡片（改写结果＋首帧输入＋start/end 跨度向上取整时长）→单列内容卡片。图片采用当前图片渠道，视频采用既有即梦单图生视频默认参数，可在画板调整；生成及内容写入沿原工作流运行时，创建时不调用模型。内容列 writer 的下游绑定使用本轮输出，连线映射到内容卡片图片输出口。
- 交付身份 `workflowId` 先保存到任务；四卡片及两个隐藏 writer／生成节点组合使用固定 ID。发生部分写入失败后，仅补齐缺失内容／工作流节点，重复点击不覆盖用户已编辑卡片，不重复创建或自动执行。内容卡片与工作流分别保存，非跨文件／数据库原子事务；失败仍可从任务重试。

本地协议：`case-list` 按项目返回任务、参考信息、最新分析／改写执行及获取状态；`case-save` 白名单保存草稿，校验字段长度、步骤、来源与参考归属，不能用空引用解绑已选视频。既有 `create` 和 `douyin-create` 接受 `caseId`，调用前检查任务归属；新任务的分析／改写必须携带已绑定参考。后台获取即使在关闭后完成，重开也按 `caseId` 恢复；旧记录以项目＋参考身份生成稳定任务编号，兼容仅保存 `sourceAnalysisId/sourceRewriteId` 的旧关联，读取归组不重写旧任务或账本。无 SQLite 迁移、Cloud 部署或价格变化。

交付后若修改改写结果、首帧提示词或参考帧，下次建立新版本工作流；未改结果时重复点击定位原工作流，不静默覆盖已编辑卡片。

10 月 23 日四项修正验收：复刻 Rust 专项 9 项、前端逻辑 9 项及四步任务界面回归通过；新增真实 JPEG 首帧像素、横／竖屏与窄窗画面比例、流程三无参考文本编辑框但 Cloud 提交保留已编辑分析文本、最终「生成工作流」按钮检查。原生解码 smoke 使用 270×480 红色视频，验证首帧 JPEG 与坏视频失败行为；界面 IPC 使用模拟，不产生云端扣费。Vite 构建通过，全量 TypeScript 仍为既有 ProseMirror 16 项错误。封面接口随新版原生后端加载生效，前端热更新不足以更新后端接口。

验证入口：`node scripts/video-replication-ui.test.mjs`（保留工具箱权限／键盘检查，并运行新工作台专项）、`node scripts/video-replication-workbench-ui.test.mjs`、`node scripts/video-player-ui.test.mjs`；截图位于 `apps/desktop/.tmp/video-replication/tasks/`。新专项使用合成红／绿视频及模拟 IPC，覆盖粘贴后立即关闭与完整刷新恢复、单任务归组、途径记忆、验证受阻、Cloud 读取失败重试、步骤门控、播放器同一 DOM／时间保持、320×180 绿色截帧、参考及画板双用途、保存失败不退出、暗色／窄窗、四节点执行顺序／三条可见连线与重复交付零新增。未进行真实模型生成、账号计费或安装包发布。

本轮结果：Rust 专项 8 项、前端逻辑／获取 9 项、工具箱权限及四步任务 UI、共享播放器回归通过；另通过实际内容列 writer 写入及下游视频提示词编译检查。Vite 构建通过；全量 TypeScript 仍报既有 ProseMirror 16 项类型错误，本次新增文件没有类型错误。默认 debug EXE 覆盖失败（拒绝访问），独立开发后端已编译到 `apps/desktop/.tmp/video-replication/tasks/backend/bowerbird-desktop.exe`；未重启应用或替换已安装版本，新增任务接口需加载新版后端，不能仅靠前端热更新。

### 早期入口和两栏交互（历史）

画板左侧「工具」分组位于磁吸辅助分组上方；工具箱按钮打开气泡菜单，首项「视频复刻工具」。面板使用 Bowerbird 的 ModalShell、主题变量、播放器和项目身份。工具只保留「分析视频」「改写内容」两栏，各自独立提交；视频生成统一在项目画板对话框完成，不因切换或带入文本调用模型。

2026-10-16 界面精简：移除空视频引导区、冗余分析/抖音提示与抖音输入区标题；分享输入保留无障碍名称。复刻弹窗使用 `replication-${projectId}` 独立 key：此前与同层 CreativeComposer 的项目 key 冲突，会在更新/关闭后重复创作框，导致闪动与卡顿。无变化的历史轮询不再更新组件状态。

Cloud 状态必须区分加载、读取失败和服务关闭，不能把异常吞掉再显示「尚未启价」。价格旁明确标注「视频分析」或「文本改写」：分析开启时显示 3 积分/次，改写关闭时显示「改写尚未启用」。查询 15 秒超时，失败 5 秒后自动重试，正常状态每 30 秒更新；窗口重新聚焦、页面重新可见、登录身份变化也刷新，可手动「重新读取 Cloud 状态」。刷新不重置参考视频、抖音文案或改写草稿，不调用模型；失败或无效响应不绕过服务端价格门控。

- 分析：本地视频、素材库视频或抖音获取结果，最大 200 MiB / 120 秒。参考文件复制到库内独立目录，保存 SHA-256，回看校验内容；源文件更换不覆盖历史。
- 改写：参考文本、改写方向、人设、规范；已移除产品资料界面。可保存默认值、对照原文、编辑保存和新建版本。轮询和面板内切换记录保留未保存编辑；关闭面板前仍须点击保存。
- 改写结果的「插入到对话框」先保存当前编辑，再通过现有提示词复用请求填入当前项目画板创作框，关闭工具窗口、切换视频/文生视频并聚焦输入；不创建或发送生成任务。时长取所有分镜最早 start 至最晚 end 的跨度，小数向上取整；兼容 JSON、时间码和文本「时长：0–2秒」。无有效时间时默认 5 秒并提示调整，超过模型范围不截断，由现有发送校验要求调整。此入口替代原「带入视频复刻」跳转工具内生成表单的行为。
- 生成：已删除工具内「复刻视频」栏目、生成参数表单及提交入口。改写结果插入画板后，沿用普通视频生成会话的模型、参数、登录/权益、恢复和产物入库；工具不再另建视频生成任务。首帧图片通过普通画板生成卡片执行，见下文工作台契约。
- 兼容旧记录：不删除此前生成记录或产物；工具内仅显示历史提示词和「查看画板生成会话」链接，不再提供新建生成版本、下载或标签补写操作。旧记录下点击新建进入改写栏；后端旧记录协议保留兼容，不做数据迁移。

## 本地契约

### 2026-10-21 对照工作台

- 输入与结果左右对照，窄窗上下排列；底部固定主要动作及 Cloud 价格，初始明确显示「开始分析」或「开始改写」。分析完成后的「开始改写」带入参考文本及视频，进入改写页，由用户编辑方向后提交。历史收起到「记录」按钮；切换两栏保留本次面板会话内的输入草稿。
- 抖音获取受阻时仅保留高亮「打开抖音窗口」恢复动作；普通失败显示错误和「重新获取」。成功仍自动填入参考，不自动分析。
- 改写左上显示紧凑参考视频，展开应用内播放器后可播放、定位和截帧。截帧沿 `importImageBytes(source=video-frame)` 保存原始尺寸图片，不调用模型；只附加到首帧图片参考，可更换或移除。嵌入播放器仅在自身获得焦点时响应空格，编辑文本不会触发播放；保留独立播放器原有快捷键。
- 本地任务独立保存 `inputText` 与 `rewriteDirection`。提交 Cloud 前合并成「【参考文本】…【改写方向】…」，合并后最多 50000 字；无方向时兼容旧输入。人设、规范沿用原接口，不改变线上模型、服务项或价格。
- 从改写原文中明确标注的首帧提示词字段/段落提取到可编辑区；未识别时留空并提示补写，不猜测正文。`save-result` 额外保存 `firstFramePrompt` 和 `frameReference { assetId, time, name }`，保留模型原文；手动保存、插入对话框或生成首帧前保存当前编辑。
- 「生成首帧图片」在当前项目新建普通图片生成卡片，使用当前图片渠道和已有生成运行时；截帧以图片槽位 1 及行内引用绑定，实际生成请求包含编辑后的提示词和参考图。卡片持久化后启动，验证、计费、失败与恢复由画板工作流负责；不新增独立生成服务。「插入到对话框」仍只填入视频提示词与时长、不发送。

本轮验证：前端逻辑 6 项、Rust 复刻专项 6 项、原复刻 UI、工作台真实媒体回归及共享播放器回归通过。工作台使用合成红/绿视频，验证定位后捕获绿色帧、原始 320×180 尺寸、保存重开、暗色/窄窗，以及真实画板运行时生成请求包含该 PNG 和编辑提示词；模型调用采用隔离模拟，未扣用户积分。Vite 构建通过；全量 TypeScript 仍有已有 ProseMirror 相关 16 项错误，本次文件无新增类型错误。截图见 `apps/desktop/.tmp/video-replication/workbench/`。

原生开发版已编译到 `apps/desktop/.tmp/video-replication/backend/bowerbird-desktop.exe`。默认 EXE 正被运行中的应用占用，未中断用户应用、未打包或部署 Cloud；原生改写方向合并与新增结果字段需重启新版后端生效，前端热更新不代表原生已更新。

`video_replication` 单一命令带 `projectId/action/data`。记录位于素材库 `video-replication/<32 位 UUID>/record.json`，临时文件刷盘后原子改名。`preferences.json` 保存工具内产品文字和改写默认值，不含密钥。任务、来源和结果按项目校验；读操作允许未物化画板，首次写入前物化。

分析代理经现有 FFmpeg 发现器生成：640 像素边界、10 fps、H.264、无音轨、最多 35 MiB。当前使用 CPU 转码，超时 300 秒。Worker 在调用模型前再次用 ffprobe 核验真实时长、尺寸和帧率。没有模型 token 使用数据时界面显示「未记录」，不推算。

分析/改写创建前保存 `submissionPending`；响应包含 Cloud job ID 后持久化。重启/断线恢复仅使用原 job ID，或经 `get-by-key` 查询原幂等键；未知提交不重投。已完成结果不能通过恢复覆盖。视频生成使用固定 jobId/turnKey 绑定现有会话。

## 抖音获取

接收完整分享文案、`v.douyin.com` 短链、作品链接及 `modal_id`；要求单个 HTTPS 视频目标。使用应用自己的隐藏原生 WebView，资料目录 `app_data/replication-douyin-browser`，与探索及系统浏览器隔离。macOS 指定专用 data-store identifier；原生验收需在目标 macOS 版本补做。

先后台观察 45 秒；未取得视频时提供「打开抖音窗口」，显式打开后等待最多 600 秒。打开窗口后仍立即尝试获取，不等待登录事件；仅当抖音页面实际要求时，由用户完成登录或验证，后台超时本身不证明必须登录。只观察目标作品正常页面数据和 detail 响应，核对作品 ID；不改签名或改写去水印地址。图文、DRM、超长视频返回明确错误。获取、登录、取消及重试均有本地记录；只允许一个获取任务使用该资料目录。关闭面板不取消后台获取，重新打开可查询并选用已有结果。

获取窗口不是播放器：导航前注入 `douyin_quiet.js`，拒绝脚本 `play()`，移除声明式与动态媒体的 autoplay 并暂停媒体；隐藏和显式打开窗口都生效。Windows 在导航前同时设置 WebView2 原生静音，覆盖 WebAudio 与子框架，避免后台出声；只影响独立抖音获取窗口，主应用的视频预览保持正常。

Windows 在导航前安装 WebView2 原生 `Network.responseReceived/loadingFinished` 观察器，读取已完成的目标 detail 响应，并复用同一份提取脚本；每个响应最多 2 MiB，队列最多 20 条。网页替换 fetch/XHR 不再使监听失效；原生读取结果也不依赖网页能否发起自定义协议导航。页面注入仍作为回退，macOS 原生分支尚未补做同等网络监听验收。

获取与分析分离：本次获取成功后自动填回参考素材并收起获取区，无需再点击「使用此视频」；只有点击分析才上传 Cloud、扣除分析积分。立即返回成功及后台轮询完成均支持自动带入；重新打开获取区时，已有完成记录不会自动覆盖当前参考，可点击历史文件名重新选取。来源保留原分享文案、原链接、规范化作品地址和作品 ID。历史播放不重新下载。

下载只接受抖音媒体域名的 HTTPS 地址，逐次检查重定向、公网 DNS 并固定解析地址，限制 200 MiB 和单地址 120 秒；最多尝试六个原始播放地址，一个不支持的候选不阻断其他候选。独立浏览器保持至下载结束；每次请求只读取该目标 URL 适用的浏览器 Cookie，内存中发送，不写入任务、日志或 Cloud，也不使用应用凭据；同时使用页面 User-Agent 和作品 Referer。成功后经真实视频解析和时长校验再保存。取消只关闭本功能创建的窗口及任务，不终止用户浏览器。未声明所有作品均可免登录获取。

## Cloud 与启价边界

复用 `understand_jobs`、租约、暂存、任务所有权和积分结算，不引入 Agent Runner。新增操作 `video-analysis` / `text-rewrite`，始终走异步队列。模型由 Worker 环境变量 `ARK_REPLICATION_VIDEO_MODEL` / `ARK_REPLICATION_TEXT_MODEL` 显式配置，凭据沿用服务端 Ark 配置，不下发桌面。

独立服务项为 `replication_video_analysis` 与 `replication_text_rewrite`，不消耗免费反推次数，不借用 caption 价格。服务端和 UI 共同检查：`active=true`、`parameters.pricing_ready=true`、`unit_cost>0` 才开放。迁移 `0062_video_replication.sql` **不写入价格行**；后续 `0063_video_replication_analysis_price.sql` 启用分析，`0064_video_replication_rewrite_price.sql` 启用改写，**目前两项各暂定 3 积分/次**。两个模型环境变量均显式配置为豆包 Seed 2.0 Mini。

部署顺序：0062 迁移 → 配好明确模型的 Worker → understand-proxy → 0063 分析启价 → 桌面。Worker 镜像需有 ffprobe；当前视频生成镜像已有对应依赖。回滚 Edge/Worker 前先停用 `replication_video_analysis` 并处理新操作的排队任务；旧 Worker 不识别它们。保留价格行与历史账本，不能删除已有计费服务或回退含新操作的历史约束。

### 2026-10-16 分析上线与真实验收

- 模型核对：EfficientCut `backend/shot_library/preferences.py` 及当前用户配置均为 `doubao-seed-2-0-mini-260428`。Worker 显式配置 `ARK_REPLICATION_VIDEO_MODEL`；视频请求与原工具一致：`video_url`、1 fps 采样、6000 max tokens、temperature 0.1、关闭 thinking、JSON 对象输出。沿用服务端 Ark 密钥，未复制 EfficientCut 密钥。
- 云端：0062/0063 已应用；`understand-proxy` v35，现役 `understand-worker` v18 内容一致、无需重部署。Worker 为 `sha256:7fd069976e499b824c22fce62e9c1b52a34081bb727cc16da8439dcb0b7922ce`，基于 9 月 22 日镜像只覆盖理解模块及共享复刻校验五个文件；四消费循环正常，restart 0、非 root/read-only 保持，mock=false。分析 3 积分、pricing_version=1；改写无价格行。
- 真实测试：使用已获取作品 `7629667701687315334`，代理 360×640、10 fps、10.1 秒、494642 bytes、无音轨。隔离测试账号经正式接口创建 `df85b6a9-75a9-4e43-92a4-6ac89d667498`，状态 succeeded，返回 0–5 秒与 5–10.1 秒两段分镜。预授权 3、实际 3，余额 30→27，只有一笔 confirmed hold 和一次 confirm；重复 create、完成后重放和 get-by-key 均为原任务，换内容复用键返回 409。未启价改写返回 not_configured。测试账号已删除，未使用用户账号积分。
- 证据：本机 `.tmp/replication-deploy-20261016/` 含线上备份、部署文件哈希、函数版本及 `live/{live-test.json,analysis-result.json}`。可复验脚本 `apps/cloud/scripts/test-video-replication-live.mjs` 需显式传入代理路径、时长及证据目录，只建立一次真实付费分析，使用一次性账号并保留未知任务的恢复身份。
- 回滚：`bowerbird/generation-worker:rollback-replication-20261016`；VPS `/opt/bowerbird/deploy-backups/replication-20261016/{source.before.tar,env.generation.before}`，旧 Edge 在上述本机目录 `edge-before`。先关闭分析服务再排空新操作；恢复旧镜像及环境、重部署备份 Edge。部署前存在两条旧 generation outcome_unknown，与本次理解任务无关，未改动。
- 本轮增量验证：桌面 TypeScript、隔离 UI（立即成功/轮询成功自动带入、旧历史不覆盖、不自动发起模型）、本地与镜像内 Worker 20/20、Edge 类型检查通过。未发布桌面安装包；已打开工具需关闭后重开以刷新 Cloud 能力。

## 验证入口

### 2026-10-16 改写结果插入画板对话框

时长逻辑 4 项与 TypeScript 检查通过；隔离浏览器覆盖当前编辑保存、关闭工具、真实 CreativeComposer 的视频类型和 13 秒（12.2 向上取整）、输入聚焦、草稿保存 IPC，以及无生成提交。无有效分镜时间的默认值、轮询编辑保留和原有工具交互一并回归。未调用付费生成或发布安装包。

后续移除工具内生成栏目：两栏布局、旧生成记录只读入口、旧记录下新建转入改写、无生成表单/按钮，以及插入画板流程回归通过；前端提交校验拒绝工具内生成，4 项逻辑与 TypeScript 检查通过。保留历史文件及后端兼容协议，未改变画板生成渠道或 Cloud 服务。

### 2026-10-16 文本改写启用

用户要求接通改写后，补齐此前缺失的 `ARK_REPLICATION_TEXT_MODEL=doubao-seed-2-0-mini-260428` 和独立服务价。先检查队列空闲、备份 VPS 环境到 `/opt/bowerbird/deploy-backups/replication-rewrite-20261016/env.generation.before`，在原镜像 `b18d88d42633…` 上重新创建容器，再应用 0064；无需修改 Edge 或重新构建镜像。当前 `video-analysis` 与 `text-rewrite` capabilities 均为 available=true、credits=3；mock=false。

真实改写任务 `cbd8c6fa-bfee-41fd-a1f2-6400a58168fc` succeeded：输入前次视频分析分镜及白色洗发水资料，输出 451 字、4 段改写；独立测试账号 30→27，唯一 confirmed hold 服务为 `replication_text_rewrite`，重复 create、get-by-key、完成后重放均返回原任务，变更输入复用键返回 409。账号已清理，未扣用户账号积分。记录 `.tmp/replication-rewrite-20261016/{prices-before.json,prices-after.json,live/live-test.json,live/rewrite-result.txt}`。复验命令：`node apps/cloud/scripts/test-video-replication-live.mjs <分镜文本文件> 0 <证据目录> text-rewrite`；脚本原视频分析模式仍可用，当前均要求两项能力已启用。

打开中的改写页沿既有状态刷新自动显示 3 积分并解锁；新增 UI 回归验证从关闭到启用时保留分镜草稿、不自动提交。回滚须先将 `replication_text_rewrite` 设为 inactive，排空改写任务后恢复备份环境并重新创建 Worker；保留价格行与账本，不删除历史记录。早期“改写未启价”验收记录均为本次启用前的历史状态。

2026-10-16 价格状态修复：线上数据库及一次性账号正式 capabilities 接口均复核 `video-analysis available=true, credits=3`，`text-rewrite available=false`，未改价格、未调用模型、测试账号已清理。旧 UI 只查询一次并吞异常，初始空状态/失败/未开启共用同一「尚未启价」文案，造成错误提示及无法自动恢复。新增真实组件回归覆盖加载中、读取失败、手动重试与草稿保留、窗口聚焦、失败后自动恢复、返回结构缺失、分析开启与改写关闭；既有画板焦点/重复挂载回归及 TypeScript 均通过。运行中的 `target/debug/bowerbird-desktop.exe` 对应开发服务器 1420 已确认提供包含重试的新代码，旧通用文案已不存在。真实接口证据 `.tmp/replication-capability-20261016/live/live-test.json`；未发布安装包。

### 2026-10-16 分镜字段误拒绝修复

用户任务 `976649f3-b38d-4bcc-a581-ff04ebdeb065` 返回 invalid_provider_response，hold 已 rolled_back，未结算 3 积分。原始模型返回当时未保存，不能反查具体缺失字段；使用该任务同一份 10.731 秒代理复现：豆包正常 stop，5 段分镜中 4 段省略 transition，旧校验要求六个文字字段齐全，导致整份有效分析被拒绝。非截断、非视频上传失败。

缺失/null transition 现在标为「未提供」，不虚构转场；主体、动作、画面字段与时间范围校验仍保留，截断仍拒绝。提示词明确完整字段及时间顺序；错误分别保存截断、JSON、分镜时间、核心字段代码与文案，不再统一要求用户调整输入。真实失败返回离线回放保留 5 段；本地及只读候选镜像 21/21 测试通过。

Worker 修复镜像为 `sha256:b18d88d42633d6287837c3680613108333c1286e3c0f96982ecb3093732f36b8`，只更新理解模块四文件，Edge/数据库/模型/价格不变。回滚标签 `bowerbird/generation-worker:rollback-replication-format-20261016` 指向此前 `7fd069976e49…`，源码备份 `/opt/bowerbird/deploy-backups/replication-format-20261016/source.before.tar`。同视频经完整 Cloud 接口复测任务 `b67d1910-d1db-4f60-9835-0947778c2454` succeeded，返回 4 段分镜（模型分段可变化），隔离账号余额 30→27，单次结算/重复提交/恢复检查全部通过，账号已删除。未修改用户失败历史或再次扣用户积分。证据在 `.tmp/replication-format-20261016/`，真实复测见 `live/live-test.json`。

2026-10-16 本地验收：桌面/采集逻辑 4 项、Rust 专项 5 项、Worker 及理解回归 20 项、隔离 React UI 与隐藏 WebView2 返回通道通过；桌面/Worker TypeScript、Rust 编译及 Edge 类型检查通过。原生夹具首轮因手动重复嵌入 manifest 链接失败、随后因合成 HTML 未声明 UTF-8 发生中文断言失败，修正夹具后通过。

- 桌面 `node --test scripts/video-replication.test.mjs scripts/video-replication-capture.test.mjs`：四项输入/独立操作/目标匹配/原始地址/受保护内容测试。
- 桌面 `node scripts/video-replication-ui.test.mjs`：实际 React 组件的隔离 IPC；工具箱键盘、未启价、抖音登录回填不自动分析、历史保存/原文、轮询与切换保留编辑、带入不生成、暗色/窄窗。
- Rust `cargo test --lib --offline commands::video_replication -- --nocapture`：分享解析、域名/公网目标、非目标/图文/DRM、项目隔离、文件哈希、原文保留和固定标签。
- Worker `node --experimental-strip-types --test src/cloud-understand/replication.test.ts src/cloud-understand/runtime.test.ts`：独立启价门控、真实代理参数、请求契约、截断/分镜格式、未知结果不重投，及既有理解回归。
- Windows 原生返回通道：先 `cargo build --offline --example replication_browser_smoke`，再在桌面目录执行 `node scripts/video-replication-native.test.mjs`。夹具仅访问本机合成页面、使用独立 profile；不运行生产初始化，不读取用户库。当前 build.rs 已为 example 链接 manifest，不能再手动叠加 `/MANIFESTINPUT`。
- 禁播回归：`node scripts/video-replication-quiet.test.mjs`，使用真实可解码无声合成媒体对照，检查声明式 autoplay、显式 play 和动态媒体均暂停。原生夹具验证导航前静音；传入真实链接时另检查获取页媒体均暂停且播放进度为 0，再在独立播放器验证下载文件可播放。
- 编译：桌面与 Worker TypeScript、Rust lib，以及 `deno check supabase/functions/understand-proxy/index.ts`。

本轮修复验收：桌面逻辑 5 项、Rust 专项 5 项、TypeScript、隔离 UI（真实画板开关后仅一个创作框、同一编辑器及草稿、焦点/渲染次数）通过。用户提供作品 `7629667701687315334` 在全新隔离 WebView2 资料中成功获取并通过生产下载实现下载；文件 1,320,618 bytes，Chrome 实际播放验证为 720×1280、10.1 秒。冷启动两次成功；初始失败夹具证明页面已播放但 JS 监听漏采，补上原生网络监听后通过。

真实作品复验：先构建原生 example，再执行 `node scripts/video-replication-native.test.mjs <抖音HTTPS链接>`；只有显式传链接才进行外网获取，默认仍是合成站点。所有资料、视频与输出保存到新的 `.tmp/video-replication/native-<时间>/`，不读写生产库。

上述真实匿名作品验收不等于真实账号登录验证、所有作品或 macOS 原生验收；这些仍需目标账号和正式构建验证。付费视频分析及文本改写均已完成云端真实验收。未打包或重启用户运行中的应用，原生修改需重新构建并重启开发程序。截图及原生夹具输出位于桌面 `.tmp/video-replication/`。
