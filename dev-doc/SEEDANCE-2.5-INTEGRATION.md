# Seedance 2.5 视频接入与验收记录

**2026-10-23 发布补记：** 本页当日桌面源码已随 Windows **26.10.2301** 发布（源码 4156e8e0），下方“待发布／未打包”是专项验证时的历史状态。正式包、签名、CDN 及回滚证据见 [桌面自动更新](DESKTOP-UPDATES.md)。原有真实安装／GPU、原生 UI 和 Mac 实机验收边界继续保留。

## 2026-10-23：桌面视频元数据增加系统回退（源码未发布）

- 读取顺序为内置 MP4/MOV/M4V 解析 → Windows Media Foundation / macOS AVFoundation → 可选 ffprobe。`--video-probe-worker` 在主程序初始化前执行；系统探测与 ffprobe 实际探测均在独立进程内，15 秒超时结束并回收，响应限读 64 KiB。复用已有原生静态库与 Windows DLL 延迟加载，不增加媒体工具二进制或依赖包，不修改云端、裁剪/转码或工具发现协议。
- 统一拒绝零宽高、未知/非有限/非正时长。普通 90/270° 旋转在内置解析、系统接口和 ffprobe 三路按显示方向处理。ffprobe 输出改为 JSON，读取旋转 side data；未知时长不降级成有效零值。
- 验证发现 Windows Media Foundation 把 0.4 秒分片 MP4 的 0.08 秒呈现偏移当成时长，因此内置解析补充 `moof/traf/trun/tfdt` 样本时序，保留多个音视频分片的时长；`mvhd` 版本 1 不再把超过 u32 的正常时长当作未知。两份合成分片夹具及生成命令位于 `src-tauri/tests/fixtures/media/`，运行单元测试无需 FFmpeg。
- Windows 独立 `video_probe_smoke` 十项真实文件检查通过：中文路径的 40ms 单帧、旋转 MP4、单/多分片（含音频）MP4、MKV、AVI、WebM 在将 `BOWERBIRD_FFPROBE_BINARY` 指向不存在文件后读取成功；系统不支持的 FFV1 MKV 在无工具时失败，提供 ffprobe 后成功；坏文件明确失败。结果位于 `.tmp/video-probe-20261023/smoke.log`，隔离脚本与构建/单测日志同目录。测试只使用合成文件，不操作用户素材库。
- Rust 元数据专项 **7 passed**，覆盖原生 MP4、旋转、单/多分片时长、JSON/未知时长、损坏输入及超时结束回收；Windows 主程序 `cargo check --bin bowerbird-desktop` 通过，保留既有警告。独立系统 worker 的旋转视频尺寸/时长通过；共用原生库的封面测试重建后，在禁用 FFmpeg 时通过 40ms 单帧、旋转画面与参考图对照及损坏文件拒绝，未回归此前的首帧修复。
- Mac 实现使用 AVFoundation 精确时长与轨道 preferredTransform，但本机不能编译/运行 macOS 原生代码；接收端须运行 `cargo test --lib media::probe::tests`、构建 `video_probe_smoke` 并复验普通/旋转 MP4、系统支持及不支持格式、缺 ffprobe 和损坏文件。格式可用性取决于系统媒体组件，Windows N 缺组件场景也仍待实机验证。本轮未打包或发布更新。

复现入口：`cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib media::probe::tests`；`cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --example video_probe_smoke`；示例参数为 `VIDEO WIDTH HEIGHT SECONDS`，传 `0 0 0` 断言读取失败。

## 2026-10-23：Windows 生成视频静态封面修复（源码未发布）

- 用户报告另一台电脑生成的视频在画板只见胶片装饰和播放标记，点击可正常播放。旧 Windows 入库可原生解析 MP4，但封面只走本机 FFmpeg；没有可用 FFmpeg 时仍入库、封面为空。另一缺口是前端信任已有封面路径，加载失败后不重建。本次没有取得原机日志，不能断言该机具体是哪一种情况。
- 新增 `windows/video-thumbnail.cpp`，通过 Windows Media Foundation Source Reader 解码首个显示帧；复用 `--video-thumbnail-worker` 的独立隐藏子进程，15 秒超时结束并回收。按显示区域剔除解码器补齐像素（540 → 544），保留旋转与行方向，在 Rust 中等比缩小并转 JPEG。父进程校验后替换缓存，失败回退原 FFmpeg 路径。媒体 DLL 延迟加载，避免缺少 Media Foundation 的系统在主程序启动时直接失败；该系统变体未实机验证。
- `VideoPoster` 在已有封面实际加载失败时仅发起一次补建，修复后使用新请求地址；重建仍失败则显示占位图，不留下破图或透明空白，不循环解码。后端复用封面前验证图片可解码，可修复丢失/损坏缓存。沿现有串行队列与注册素材校验，画板不创建隐式视频播放器、不修改原视频或重发生成任务。
- 验证：Windows 独立 `video_poster_smoke` 在测试进程将 `BOWERBIRD_FFMPEG_BINARY` 指向不存在路径，验证中文路径、40ms 单帧、旋转 H.264 MP4、270×480 JPEG、真实画面和损坏视频拒绝；输入由 FFmpeg 合成，仅用于测试。Rust 封面测试 3 项通过，覆盖缓存丢失/损坏、复用、无锁解码及删除竞态。`media-previews-ui`、`media-lifecycle-ui`、`canvas-media-ui` 和 TypeScript 通过，覆盖 StrictMode、失效封面单次修复、修复失败占位、切换隔离及被动预览零视频请求。旧生命周期夹具的 `poster.jpg` 原本不存在，现补充实际图片响应以符合加载失败修复语义。
- 独立测试输出/日志位于本机 `.tmp/video-poster-20261023/`。未构建安装包或发布更新，另一台电脑需更新后实机复验；原生 WebView 的完整卡片到后端链路及特殊编码仍未由以上测试替代。

原生实现依据：[Source Reader 视频处理](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-source-reader-enable-video-processing)、[MP4 源与旋转信息](https://learn.microsoft.com/en-us/windows/win32/medfound/mpeg-4-file-source)。

## 2026-10-19：截帧就近落位（源码未发布）

- 原 `addVideoFrame` 使用隐藏视频产物坐标，碰撞后沿通用视口搜索，导致截图离开源卡。现在解析可见会话/素材组的别名和实际显示边界，排除分区框，把截图优先放在视频右侧；碰撞调用 `placeCanvasCardNearSource`，不再回退到视口搜索。多个相同视频实例按选中优先、距可见中心最近排序。
- 没有画板实例的素材库视频按当前可见画布中心放置，保留平移/缩放换算并扣除底部创作栏占用，不因中心已有内容而偏移。保存前冻结项目、源位置和障碍，沿原队列与入库缓存处理重试；当前帧及尾帧共用逻辑。
- `scripts/video-frame-placement.test.mjs` 用真实本地合成 MP4 与模拟 IPC，验证视频旁有障碍时就近避让、折叠会话隐藏产物远在 20000 坐标时仍按可见卡放置、素材库视频在非默认平移/缩放与中心已有内容时精确居中。测试会话夹具补齐原生产要求的 `schema_version` 后通过；既有播放器专项（像素、尾帧、失败重试、跨项目保存、重载）与 TypeScript 通过。未操作用户素材或打包，原生 WebView 尚未实机复验。

## 2026-10-14：即梦视频完整错误查询（源码未发布）

- 失败轮新增「查询完整错误 / 复制完整诊断」。后端只调用 `query_result --submit_id` 与 `list_task --submit_id --limit 1`，不带下载参数、不提交新任务、不改任务终态。两路独立记录退出码、stdout 解析结果、stderr、超时/启动错误，其中一路失败不会丢弃另一路结果。
- 查询返回所有诊断字段，展开嵌套 JSON，保留 `fail_reason / logid / queue_info` 及未知错误码；提示词、媒体链接和认证字段脱敏。关联本机 CLI 日志按精确 `submit_id` 读取，限最近 24 文件、每文件末尾 512 KiB、最多 60 条；明确这不是无限历史扫描。报告保存至应用数据目录 `diagnostics/dreamina/<submit_id>.json`，保存失败独立报告，不遮蔽查询结果。
- 新生成的上游失败不再只取一句 `fail_reason`：任务错误同时保存脱敏原响应、CLI 命令名、退出码和 stderr；非零退出/非法响应/未知状态也保留诊断。暂时查询错误沿原有有限重试，远端 fail 仍不自动重投。
- 隔离验证：Rust 即梦相关测试 10 passed / 1 ignored，含精确任务日志匹配、嵌套错误保留、脱敏、两路独立失败、只读命令无下载参数和既有提交/恢复协议；浏览器验证卡片切换迟到响应隔离、缺编号禁用、复制、查询失败后重查及窄屏。TypeScript 与 Vite 隔离构建通过。
- 显式执行真实已有失败任务的只读查询测试 1 passed，验证命令返回及诊断落盘。结果与列表均返回通用 `generation failed: final generation failed`，没有具体审核/尺寸/内部故障子码，不能将通用失败猜测为某项根因。任务编号和原提交 logid 已留在本机诊断；本轮未发起付费生成、下载媒体、重新打包或发布。`credit_count` 不作为实扣或退款证据。

## 2026-10-14：画板视频播放器与截帧（源码未发布）

- 同日修复新容器无法播放：主应用启用 React StrictMode，首次 effect 清理删除 `video.src` 后，重放 setup 未恢复地址，点击播放即失败。播放器 effect 现在对称恢复/释放当前源；视频专项启用与主应用一致的 StrictMode，新增源地址保留断言（修复前实际为 null、失败；修复后播放、截帧和保存通过），媒体生命周期也在 StrictMode 下验证不预加载与关闭释放。此根因与原生媒体编码无关；原生验收范围仍按下文记录。

- 画板素材、当前生成会话及历史会话的 Lightbox 使用 `VideoPlayer`：独立深色播放容器、中央固定指针与可横向拖动的缩略图胶片，点击定位、方向键 0.1 秒步进，细调放大时间轴并改为 0.01 秒步进（时间步进，不宣称任意帧率逐帧寻址）。拖动即暂停，定位完成后可「添加该帧到画板」。
- 用当前播放器已解码的原始尺寸画面生成 PNG，不截取控件或低清缩略图；按视频名和时间命名。复用 `import_image_bytes` 与项目画板写入队列，以 `video-frame` 标记来源且不自动反推/命名；素材按既有精确字节去重复用，画板实例独立。优先放在源视频旁，已有内容占位时沿现有落位逻辑避让。
- 保存操作冻结项目与节点身份；入库成功而画板写入失败时重试原写入，不重新导入。保存中关闭预览或切换项目仍只落原项目，迟到结果不写入当前页面。未完成解码、正在播放/拖动/寻址或保存时不可截帧。
- 被动预览仍只用静态封面。2026-10-16 修正主动预览首帧空白：播放器从 `preload="none"` 改为 `preload="auto"`，打开即加载首帧并保持暂停，加载期间显示状态提示；就绪后用一个限时解码器串行采样 12 张时间轴缩略图，关闭/切换释放播放器和采样资源。无需新增 FFmpeg 运行依赖或数据库迁移。
- 2026-10-16 回归：真实 MP4 在 StrictMode 下无需点击即解码出第 0 秒红色首帧，保持暂停且可截帧；旧代码在同一断言处超时，修复后播放器专项（含拖动/细调/PNG 像素/保存重试）、媒体生命周期专项（30 轮被动挂载零视频请求、5 轮主动预览关闭释放）和 TypeScript 检查通过。本次为 Chromium 隔离验证，未重跑原生 WebView 或构建安装包。
- 同日展示与键盘调整：已完成的视频生成会话复用图片结果的无外框布局，按所选视频比例呈现，保留轻量播放标记；独立视频素材移除紫色框与深色底。视频单击直接打开预览；未完成/失败会话继续展示状态和提示词。容器读取 `videoWidth/videoHeight`，按原始尺寸、可用视口与实际控制栏高度等比缩小，不再固定 1000px 横屏宽度。打开期间空格切换播放/暂停，覆盖时间轴/按钮及底层残留焦点，忽略长按重复事件，关闭卸载监听。真实 9:16、1:1、宽屏 MP4 在 1500×1000 与 480×800 下验证比例、边界、单击及空格交互；图片会话、画板媒体与媒体生命周期回归通过，原生播放器仍待实机验收。
- `scripts/video-player-ui.test.mjs` 用真实三段变色 MP4 验证鼠标拖动、细调、PNG 原始尺寸/对应像素、失败重试、防重复提交、窄屏、持久化重载与关闭/跨项目迟到保存。既有画板媒体与媒体生命周期回归、TypeScript、Vite 构建和 Rust 离线编译检查通过；浏览器使用模拟 IPC，原生 WebView2/WKWebView 的播放与截帧仍待实机验收，未打包发布。

## 2026-10-17：一键添加尾帧（源码未发布）

- 播放器在「添加该帧到画板」旁提供「添加尾帧到画板」。点击后暂停并寻址到时长结束前 1ms（极短视频取半时长），等待解码完成再沿原 PNG 截帧与画板保存链路提交；保留原始尺寸，成功后停留尾帧并禁用本次预览的重复添加。
- 寻址有 10 秒超时，出错或卸载释放源时结束等待；定位期间关闭不保存未就绪画面。保存失败可重试，沿既有项目归属和导入缓存避免重复导入。未改变数据库、原生接口或模型调用。
- `scripts/video-player-ui.test.mjs` 用最后仅一帧为黄色的真实 MP4 验证尾帧像素、播放中暂停定位、保存失败重试及去重，并覆盖 40ms 单帧视频和定位中关闭；既有首帧、键盘、比例、截帧与跨项目保存回归及 TypeScript 检查通过。仅 Chromium 隔离验证，未打包或验证原生 WebView。

## 2026-10-17：视频入出点裁剪（源码未发布）

- 播放器「裁剪」提供入点、出点滑块、秒数输入及「设为当前」，预览只播放所选区间；全长未调整时禁用保存。原时间轴与细调保留，关闭裁剪后恢复截帧入口。
- 新增 `commands/video_trim.rs` 的 `trim_video` IPC，要求已登记的视频素材及有限有效范围。复用本机 FFmpeg，解码后按时间重新编码，避免关键帧复制造成起点偏移；保留首条视频和可选首条音轨。新副本为 H.264/AAC MP4；覆盖保留容器扩展名，WebM 使用 VP9/Opus，其余使用 H.264/AAC。奇数尺寸最多补一个像素，不拉伸。裁剪有 300 秒超时和单任务互斥，不调用模型、不扣生成积分。
- 「另存为新视频」沿生成产物入库链路创建独立身份，来源 `video-trim`、名称追加「-裁剪」。画板保存冻结发起项目与落点，写入失败重试缓存结果，不重复编码；切换项目后的迟到结果只保存原项目。
- 「覆盖原视频」限素材库管理的视频，外部文件引用禁止覆盖。编码及尺寸/时长校验完成后才创建原件备份，替换时保留 ID、文件路径与关联，刷新时长、尺寸、封面并清除过期提色。文件替换失败保留原件，数据库提交失败恢复备份；若恢复也失败，错误明确给出备份位置。此为运行时失败回滚，不宣称文件系统与 SQLite 具有断电原子事务。
- 前端覆盖前释放主播放器与缩略图采样源，完成后用新修订地址重载；失败也重载原视频并保留裁剪选择。裁剪使用可用本机 FFmpeg，缺失时提示；没有改变普通播放、截帧或视频生成的工具依赖配置，也未随本次增加工具分发。
- 验证：`cargo test --lib video_trim --no-default-features -- --include-ignored --nocapture` 为 **2 passed**，使用上述既有本地 FFmpeg/FFprobe 与临时素材库。长 GOP 三色合成片验证非关键帧起点像素、保留音轨、独立副本、同身份覆盖、更新失败和替换后的延迟外键提交失败回滚、非法范围及外部路径保护。`scripts/video-trim-ui.test.mjs` 验证真实 MP4 播放、范围键盘、另存、画板写入失败重试不重编码、覆盖释放源、失败恢复范围、覆盖后新时长、窄屏及跨项目保存；既有播放器专项及 TypeScript 检查通过。浏览器使用模拟 IPC；未完成原生 WebView 端到端交互验收、重新打包或发布。

## 2026-10-09：结果查询临时超时恢复（Windows 26.10.903 已发布）

- 用户报告官方 CLI `a857341-dirty` 查询 `get_history_by_ids` 等待响应头超时、退出码 1。旧 `jimeng_video::poll_video` 将单次查询错误直接返回，显示失败；该错误本身不证明远端生成失败，也不能确定网络或上游服务的具体故障点。
- 查询阶段遇到命令层 deadline/client/I/O/TLS 超时、连接重置或应用单次命令超时，间隔 10 秒重查同一 `submit_id`，连续最多额外重试 3 次；有效响应清零次数。耗尽时提示“远端生成状态尚未确认，可稍后取回原任务”；远端明确 `fail`（包括原因中出现 timeout）、登录错误、解析失败及未知状态不作传输重试。生成提交不重试，避免重复创建；生成与恢复共用此轮询。
- 隔离临时 AppData + Windows 原生启动器 + 本地假 CLI 验证 **Rust 视频 7/7**：首查超时后下载成功、原 ID 取回、连续错误计数重置/耗尽、登录错误/远端失败立即退出、取消打断重试等待、失败临时目录清理及提交次数。前端 `video-generation.test.mjs` / `video-reference-editor.test.mjs` **21/21**。测试无真实模型调用，不读取用户素材库；未核实该用户的远端任务状态或实际费用。后续随 Windows 26.10.903 签名发布，完整 Rust 465 passed / 10 ignored 及公网包核验通过，详见 [桌面自动更新](DESKTOP-UPDATES.md)。
- 已报错且保留提交编号的任务，可在详情选择“取回已提交的视频（继续查询，不重新生成）”；该入口已有，继续取原任务，不创建新任务。

## 2026-09-30：官方模型与积分查询（源码未发布）

本节补充当前接口与验收；下方 9 月 6 日的固定 2.5 / 480p–720p 记录保留为历史，不再是当前即梦 UI 范围。

- 本机官方 CLI `ec1b9fa-dirty`，commit `ec1b9fa`，build time `2026-09-09T09:09:35Z`。四模式 `--help` 已只读核对：共通 `seedance2.5`、`seedance2.0`、`seedance2.0fast`、`seedance2.0_vip`、`seedance2.0fast_vip`、`seedance2.0mini`；单图另含 `seedance1.0fast` / `seedance1.5pro`，首尾帧另含 `seedance1.5pro`。账号权限和运行时可用性仍由官方决定。
- 2.5 支持 480p/720p/1080p、4–30 秒；2.0 VIP 支持 720p/1080p/4k、4–15 秒；其他 2.0 为 720p、4–15 秒；1.5 Pro 为 720p、5–12 秒，1.0 Fast 为 720p、5–10 秒。2.0 多参考限制为 9 图/3 视频，参考视频每条及总时长 2–15 秒；2.5 保留 30 图/10 视频和 2–30 秒。应用不暴露音频输入。
- `user_credit` 真实返回数值 `total_credit`；本轮只读快照为 9434，非固定 UI 数据。`list_task --limit 1` 真实返回 `commerce_info.credit_count=240`；用该记录的精确 `--submit_id` 再查询，只核验编号匹配及积分字段，不保存提示词、用户信息、任务编号或产物链接。未发起生成、下载素材或改账号状态。
- 新增三个只读 IPC：`dreamina_video_models` / `dreamina_credit_balance` / `dreamina_task_credit`，复用应用当前平台的官方 CLI 启动及登录环境。模型选项从对应模式的官方帮助解析；余额/任务费用只返回必要数字。查询 30 秒超时并关闭子进程，失败提示检查网络/登录，缺失字段不当作零。
- 当前 CLI 没有生成前报价命令，界面标注「暂无官方生成前报价；提交后显示任务消耗」。任务费用按准确 submit_id 匹配官方字段；不以账户余额差、方舟 token 单价或历史样例估价。提交和结束触发余额刷新，任务消耗可手动重新查询。费用没有写入 Bowerbird 积分账本，也没有新增数据库迁移。
- 每轮历史从既有 `generation_meta.submit_id` 恢复，实时提交/任务恢复填入对应轮；旧无 turn_key 的同文案记录也按 submit_id 区分，防止多个官方任务被合并导致费用错配。Cloud 仍只支持 2.5，切换渠道时恢复其合法模型/分辨率，不变更云端计费。

验证：前端视频/引用/恢复 22 项；Rust 官方字段解析 2 项、视频命令/离线子进程 6 项、历史 2 项；`scripts/video-controls-ui.test.mjs` 覆盖模型切换、限制、Cloud 切换、余额提交/结束刷新、失败/缺失/零值、迟到响应及真实画板创作器和双轮检查器。380/560/900 宽度回归及 TypeScript/Vite 构建通过。浏览器使用合成 IPC，不冒充 Tauri 原生全链路；未验证新的付费生成或发布安装包。

---

> 日期：2026-09-06。状态：本地接入、自动回归与合成媒体验收完成；真实即梦生成及 Tauri 原生 UI 待验。
> 本文负责即梦官方 Dreamina CLI；并行的 Cloud 国内方舟接入见 [VIDEO-API-INTEGRATION.md](VIDEO-API-INTEGRATION.md)。两者均已纳入当前桌面源码，CLI 真实生成验收仍待完成。
> 本文记录本专项的接口核验与验收证据；项目全局决策仍以 [PROJECT.md](../PROJECT.md) 为准。

## 1. 范围与依据

应用接入 `seedance2.5` 文生视频、单图生视频、首尾帧生视频和全能参考四种模式。沿用现有本机即梦登录态、生成队列、持久化和项目画板归属。

本次明确指定 Seedance 2.5：请求必须显式传 `--model_version seedance2.5`；权限不足或服务暂不可用时说明原因，不能静默切换为 2.0/fast。固定旧模型的 `multiframe2video` 不属于 Seedance 2.5 四模式；早期五模式规划已删除，历史 spike 可从 Git 查阅。

相关资料：

- [官方 Dreamina CLI 入口](https://jimeng.jianying.com/cli)。网页工具本次未成功提取入口内容，接口契约以已安装官方 CLI 的本机帮助输出为证。
- [生成与理解 provider](Bowerbird开发计划.md#生成与理解)。
- [当前项目画板契约](PROJECT-CANVAS-PLAN.md)。

## 2. 官方 CLI 本机核验

2026-09-06 只读运行了以下命令，未发起生成、未上传参考素材、未扣生成积分：

```powershell
& "$env:USERPROFILE/bin/dreamina.exe" version
& "$env:USERPROFILE/bin/dreamina.exe" text2video -h
& "$env:USERPROFILE/bin/dreamina.exe" image2video -h
& "$env:USERPROFILE/bin/dreamina.exe" frames2video -h
& "$env:USERPROFILE/bin/dreamina.exe" multimodal2video -h
& "$env:USERPROFILE/bin/dreamina.exe" query_result -h
```

本机位置：`C:\Users\Hins\bin\dreamina.exe`。

```json
{
  "version": "a857341-dirty",
  "commit": "a857341",
  "build_time": "2026-07-31T16:28:32Z"
}
```

四个模式的帮助均明确列出 `seedance2.5`。统一约束：**VIP-only、输出时长 4–30 秒、分辨率 480p 或 720p**；`--video_resolution` 必填。

| 模式 | 参考参数 | prompt | ratio | CLI 实际默认模型 |
|---|---|---|---|---|
| `text2video` | 无参考图 | 必填 `--prompt` | 可传；省略为 16:9 | `seedance2.0fast` |
| `image2video` | 一张 `--image` | 必填 `--prompt` | 不支持，按输入图推断 | `seedance2.0_vip` |
| `frames2video` | `--first` 与 `--last` | 可传 `--prompt` | 不支持，按首帧推断 | `seedance2.0_vip` |
| `multimodal2video` | 重复 `--image` / `--video` / `--audio` | 可传 `--prompt` | 可传；省略为 16:9 | `seedance2.0_vip` |

因此不能依赖 CLI 默认模型。历史文档“2.5 默认”不等于 CLI 当前帮助中的默认值；应用指定 2.5 才能确保用户选择得到准确执行。

可设置的比例仅六档：`1:1`、`3:4`、`16:9`、`4:3`、`9:16`、`21:9`。图片生成的 `2:3`、`3:2` 不适用于这里。

全能参考模式的 Seedance 2.5 帮助还列出：

- 最多 30 张图片、10 个视频、10 个音频，总输入最多 50 项。
- 支持纯音频输入；每条以及视频/音频总时长受 2–30 秒限制。
- 输入采用重复的单数参数 `--image`，不能误用图片生成的 `--images`。
- 以上是 CLI 完整能力，不代表本次 UI 已暴露视频/音频输入；应用首版输入范围应按最终实现与验收记录说明。

CLI 帮助明确说明：模型列表是公开支持集合，运行时可用性、输入上限与权限仍由后端配置决定。本次帮助核验不等于当前账户已经真实生成成功。

同日只读执行 `dreamina user_credit` 成功（exit 0）：当前登录态有效，返回 `vip_level=standard`、`total_credit=30`。该摘要不包含用户标识或凭据。此结果不足以认定账户已具备 Seedance 2.5 VIP 权限；不得沿用历史 spike 的 maestro 等级/余额作为本次验收前置，也未据此发起生成。

## 3. 异步查询、下载与错误边界

- `--poll N` 表示提交后每秒查询、最多等 N 秒；`--poll 0` 禁用此等待。应用应取得 `submit_id` 后尽快持久化，再进入后续查询。
- `query_result` 仅暴露 `--submit_id` 和 `--download_dir`。继续查询同一 `submit_id`，不能通过重新提交来模拟查询恢复。
- 所有四模式支持 `--session int`，默认 0。即梦会话 ID 与 Bowerbird 项目/创作线程归属不是同一个标识。
- 返回 `AigcComplianceConfirmationRequired` 时，官方帮助要求先到即梦 Web 使用该模型完成首次生成。
- 权限不足、积分不足、未登录和并发限制应保留可行动原因。Seedance 2.5 具体费用不能用旧 spike 中 2.0fast 的 10 积分直接代替。
- 本地停止不代表远端任务取消或退款；保留已提交 ID 供取回。
- 视频输出文件名、实际容器/编码、当前账户 2.5 费用与排队耗时尚无本次真实生成样例，不能写成已验证。

## 4. 验收清单

| 检查项 | 验收标准 | 本次状态 |
|---|---|---|
| 四模式命令 | 模式正确，显式 `seedance2.5`，拒绝静默降级 | Rust/前端专项通过 |
| 参数边界 | 4/30 秒接受，3/31 秒拒绝；仅 480p/720p | Rust/前端专项通过 |
| 比例 | 文生/全能参考六档；单图/首尾帧省略 ratio | Rust/前端专项通过 |
| 参考顺序 | 按编辑器顺序传入；首尾帧精确映射；不自动混入上轮图片 | Rust/前端专项通过 |
| 输入检查 | 无效路径、缺失素材、模式数量不符在提交前拒绝 | 已实现 preflight；数量/provider 前端与 Rust 回归通过 |
| 下载 | 只收集临时目录内允许的视频产物；图片不能假作视频成功 | Rust 扫描/离线协议回归通过；拒绝 symlink，保留准确临时根 |
| 队列与恢复 | 保存提交 ID；恢复按 job 媒体类型下载；不重复提交 | 离线 CLI 续查/取消/失败/未知状态测试通过；恢复取消链路已审查 |
| 入库 | MP4 可探测尺寸/时长，poster 实际存在且可解码 | 真实本地合成 MP4 单项通过 |
| 短视频与损坏文件 | <1 秒视频可抽帧；损坏 MP4 不成功入库 | 0.4 秒首帧回退、poster 解码及坏 MP4 拒绝通过 |
| 展示与历史 | 结果/历史/画板按视频渲染，重试保留模式与参数 | 参数/历史回归与真实 React 组件播放检查通过；完整桌面真机 UI 待验 |
| 图片回归 | 图片仍走原 provider，既有项目归属与续轮不受影响 | Rust 全量与前端既有 96 项回归通过 |
| 真实 2.5 生成 | 账户实际提交、成功下载与播放，核对实际计费 | 未执行 |

## 5. 实现入口与测试记录

源码入口（最终改动以 diff 为准）：

- [Dreamina provider](../apps/desktop/src-tauri/src/codex/jimeng.rs)、[共享请求类型](../apps/desktop/src-tauri/src/codex/types.rs)、[生成 IPC](../apps/desktop/src-tauri/src/commands/codex.rs)。
- [持久化生成队列](../apps/desktop/src-tauri/src/core/task_queue.rs)、[生成收尾与恢复](../apps/desktop/src-tauri/src/core/generation_worker.rs)、[资产入库](../apps/desktop/src-tauri/src/core/ingest.rs)。
- [视频元数据](../apps/desktop/src-tauri/src/media/probe.rs)、[视频缩略图](../apps/desktop/src-tauri/src/media/thumb.rs)。
- [创作板](../apps/desktop/src/components/CreationBoard.tsx)、[生成结果](../apps/desktop/src/components/GenerationPanel.tsx)、[前端状态](../apps/desktop/src/store.ts)。

本机初次检查时 `ffmpeg` 与 `ffprobe` 不在 PATH。[FFmpeg 官方下载页](https://ffmpeg.org/download.html) 只提供源码并列出 Windows 构建供应方；尝试从其推荐的 [gyan.dev Windows builds](https://www.gyan.dev/ffmpeg/builds/) 下载 release essentials，但连接低速/超时，后续原站与 GitHub 镜像 DNS 失败。下载未完成，**没有执行该未校验的下载包**。

最终测试工具使用本机既有 `D:\H\Project\ccHome\ScriptCut\src-tauri\binaries\` 中的 `ffmpeg-x86_64-pc-windows-msvc.exe` 和 `ffprobe-x86_64-pc-windows-msvc.exe`。只读核验版本均为 `8.0-full_build-www.gyan.dev`，复制到本仓 `.tmp/video-integration/tools/local/ffmpeg.exe` / `ffprobe.exe`；复制前后 SHA-256 一致。原项目文件未修改，只在测试进程临时设置 PATH，未全局安装。这是本地已有 sidecar 的复用与复制一致性检查，不宣称通过了本次网络下载的发布校验。

| 本地工具 | SHA-256 |
|---|---|
| ffmpeg.exe | `81B5832F6C548D64FEBA0EC7D643397E2351D9F3460A65C6C296956045EEBAEA` |
| ffprobe.exe | `421DBC81A3D758DFE114534FF48EF47A61EF91896EB4B9E819609A8752AB8272` |

2026-09-06 当前验证记录：

- Rust 全量：**284 passed / 0 failed / 3 ignored**。随后单独执行其中的本地合成短 MP4 测试，**1/1 通过**；另 2 个是既有 Agent Z 真机测试。
- 真实本地媒体验收：FFmpeg 合成 0.4 秒、120×240 的 MP4；`ingest_generated` 经 FFprobe 得到正确尺寸/时长，`source=jimeng` 与生成 session 关联正确；第 1 秒无帧时回退首帧，poster 可解码、最长边不超过 480，并完成提色。损坏 MP4 被拒绝，数据库素材数仍为 1。证据：`.tmp/video-integration/backend-media-test.log`；本测试不调用即梦或其他生成服务。
- Rust 视频专项覆盖四模式精确参数、时长/分辨率/模型/模式拒绝、引用顺序、视频下载扫描、失败原因、非法 JSON，以及视频参数的历史持久化。
- 离线 CLI 协议测试编译仓库内的 [测试替身](../apps/desktop/src-tauri/tests/fixtures/dreamina-video-cli.rs)，验证只提交一次、下载嵌套产物、按同一 ID 恢复、失败/未知状态与取消轮询。这是本地子进程协议测试，**没有调用即梦服务**；替身文件也不是可播放的视频验收样例。
- 前端最终回归 **106/106**（新增专项 10 + 既有 96），覆盖生产 store 的首尾顺序/项目归属、provider 拒绝、精确视频续轮、空参考文生重试、项目草稿、启动恢复与对应轮参数；TypeScript 与 Vite production build 通过。证据：`.tmp/video-integration/frontend-tests.txt`、`frontend-build.txt`。
- 真实 React 组件验证：380/560/900 px 三档无横向溢出，发送入口可见；本地合成视频的 controls 与播放/暂停通过。证据 `.tmp/video-integration/ui-check.json` 明确 `nativeTauri=false`，不能据此宣称 Tauri 原生桌面全链路已验。
- 独立增量审查按本次 `.tmp/video-integration/baseline` 对照，已推动修正：下载扫描不跟随符号链接、清理准确临时根；恢复等待/轮询响应取消并释放并发许可；迟到 Submit 不复活终态；恢复事件携带视频参数；图片/视频混合轮次使用对应轮的媒体、模型和 provider 快照。
- 最终历史复用修正已复核：任务未载入或仅载入最新轮时，旧画板 prompt 都按输出资产与精确 `turn_key` 读取持久化历史；不套用最新轮的图片参数。缺失历史则停止并提示，异步回调检查项目路由是否过期。视频轮的 Agent 重试入口也按该轮媒体类型禁用。上述修正后前端仍为 **106/106**，TypeScript 与 Vite 构建重跑通过。

剩余验收：完整桌面真机 UI、当前账号真实 Seedance 2.5 提交到成功播放及实际计费。常规启动的应用仍需要可用的 FFmpeg/FFprobe；此次只对测试进程临时注入工具目录，未完成全局安装或桌面分发配置。帮助参数核验、离线协议测试和本地合成媒体验收均不等同于真实即梦 Seedance 2.5 生成端到端通过。
