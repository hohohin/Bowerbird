# 探索视频流采集与采集记录

2026-11-02 开工，2026-11-03 接续。用户要求接入 Blob／分段视频采集，并在探索右上角提供类似 Chrome 下载的进度与记录。按 `ub-mode` 实施，代码、测试和证据共同存档；本轮不发布安装包。

## 操作与原因

1. 阅读 PROJECT 当前进展与约定、开发计划、内置浏览器、视频媒体、画板、错误提示与 UI 规范；确认只改内置探索，保留外部插件与素材库链接采集的既有边界。
2. 先做普通 Blob／MediaSource／HLS／DASH 合成实验。证明普通 Blob 能在创建文档读取，MSE 对象地址不能直接变成完整文件；缺片时 FFmpeg 仍可能成功退出，因而必须先逐片下载并校验。研究产物在 `.tmp/video-stream-research-20261102/`。
3. 分开实现来源解析与浏览器传输、清单解析与本地合并、前端采集队列；用真实浏览器行为和本机 FFmpeg 作为验证，避免用仅检查字符串的测试替代执行结果。
4. 页面启动时观察视频对象、请求响应与实际 `appendBuffer` 关系。优先匹配当前笔记／Pin 的明确视频元数据，关联不唯一就返回中文错误，不按最后一次网络请求猜测素材。
5. 流采集先检查清单、逐片完整下载、再用本机 FFmpeg 合并与完整解码。FFmpeg 只读取受管临时目录；每个文件使用本机生成名称，失败和取消释放临时内容。
6. 采集按钮放在探索浏览器工具栏右侧，使用既有主题和 ModalShell，统一原生 WebView 遮挡、Esc 与焦点恢复。图片和视频串行排队，提供真实进度、取消、重试、查看已保存素材；本机只保留最近 50 条记录摘要。
7. 取消与保存通过原子状态切换裁定；保存开始后继续完成入库。前端等待任务注册的进度握手，避免在原生命令注册前丢失取消。已入库而交付失败时，重试只补交付。
8. 交叉审查补充空元数据 URL、DASH 时间轴缺口、压缩响应长度、跨域浏览器读取和画板失败重试身份检查。原有笔记文字拖选的 15 项 Chromium 回归通过。

## 验证记录

验证使用合成媒体、localhost、隔离 WebView2 profile 和临时 SQLite，不操作用户素材库或真实站点账号。

| 命令／入口 | 实际结果 |
| --- | --- |
| `cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --no-run`，临时副本运行 `source_browser --nocapture` | 编译通过；27 passed／1 ignored，覆盖原桥接、取消、入库、传输与清单解析 |
| 单独运行 `real_hls_and_dash_preserve_video_audio_and_decode --ignored --nocapture` | 1 passed，内部 HLS TS、HLS fMP4、独立 fMP4 音轨、独立 TS 音轨与 DASH 五组均保留 100 视频帧、音轨及 4 秒时长，损坏 AAC 负例拒绝 |
| `scripts/verify-native-video-stream.mjs` | 全组通过；普通 Blob、无 CORS 的 Cookie 跨源、同源重定向至跨源、gzip 正文／清单、HLS／独立音轨／DASH、缺片／206、等待同源响应头时取消断连、SPA 切页旧 Blob 拒绝；最终补验正常跨域 CORS 清单、重定向／无 CORS／CSP 清单拒绝且不请求错误目录片段、清单确认等待时取消 |
| `scripts/source-browser-video.test.mjs` | 真实 Chromium 来源解析、普通 Blob 分块及大小、当前笔记／Pin、多源歧义、MSE 实际 append 与无关后续清单、空元数据和 gzip 边界 |
| `scripts/explorer-capture-history-ui.test.mjs` | 正式组件队列、真实字节／未知长度、冻结目标、重试、取消握手与保存边界、查看、重开／重启、50 条、隐私字段、WebView 遮挡、Esc／焦点及深浅窄窗通过 |
| `scripts/explorer-capture-canvas-retry-ui.test.mjs` | 真实 CanvasWorkspace 持久化队列：只下载一次、原节点与原坐标、新拖入独立实例及重载一致，通过 |
| `scripts/explorer-video-ui.test.mjs`、`explorer-classification-dock-ui.test.mjs`、`explorer-selection-drag.test.mjs`、`explorer.test.mjs` | 原视频、图片分类、15 项文字选择／媒体命中与 3 项载荷／生命周期边界回归通过 |
| 完整 TypeScript、独立 Vite 构建 | 通过；输出到 `.tmp/explorer-capture-history/build`，不覆盖客户端 |

失败边界保留：全仓 `user-error-boundaries` 仍报已有 ScreenshotHistoryPanel 和 TextDocumentEditor 两处，当前历史项经过展示转换且已精确注册；旧 `explorer-canvas-ui` 卡在已过时的“中央素材”Tab 定位，本次画板逻辑使用上述新的真实组件用例验证，未把旧用例计为通过。

- UI 截图：`apps/desktop/.tmp/explorer-capture-history/dark-progress.png`、`light-narrow.png`；已人工查看工具栏位置、深浅色和窄窗排版。
- 任务取消单测先以无取消实现运行，得到预期 2 failed／1 passed，再修复原子状态。Windows 测试 EXE 需要给临时副本嵌入已有 CommonControls manifest，原构建输出不修改。
- 来源解析先覆盖普通 Blob、当前笔记／Pin、多视频歧义、切页、实际 MSE append 与后续无关清单；解析器先以占位实现产生预期失败，再补齐支持。
- 分离 AAC／TS 的 MP4 合并曾因两个起始包 DTS 同为 0，被合并步骤 `-xerror` 拒绝；原始完整轨道严格解码成功，`genpts/igndts/copyts` 不能解决。最终先严格解码每条输入，允许 mux 正常整理时间戳，再严格解码最终文件，并保留下载完整性与时长校验。损坏 AAC 仍失败，不把放宽 mux 警告当成跳过媒体校验。
- Windows FFmpeg 测试生成器默认将 fMP4 init／DASH 分片写到 cwd，已改每次使用独立临时 cwd；只清理／移回本测试产生并核对过的文件。一次编译碰到其他会话尚在编辑的 Cloud 鉴权调用，等待原作者修复后重编译，未修改其代码。
- 原生最终 profile：`apps/desktop/.tmp/video-stream-native-1793637285442`（包含最后的清单重定向拒绝）；前一轮完整链路为 `1793636482183`。原生浏览器／HTTP 测试进程已清理；详细逐步日志在 `.tmp/video-stream-browser/log.md`、`.tmp/explorer-stream/native-log.md`、`.tmp/explorer-capture-history/action-log.md`。

## 明确边界

- 这是源码增量，公开 Windows 包仍为 26.11.202／SQLite 0050。
- 支持有限、未加密 HLS 与静态单 Period DASH；直播、DRM／加密、Range 清单、动态／多 Period、时间轴断层及无法明确关联的 MSE 不宣称支持。
- Worker／转封装后重新分配的缓冲区不一定能追溯到原请求；没有明确站点元数据或唯一清单关系就失败，不采集旁边视频或封面。
- Windows CDP 跨域资源读取不暴露最终重定向 URL。对这种通路取得的清单，额外使用浏览器 CORS／manual 请求确认无跳转；跳转、CORS／CSP 阻断或无法确认均明确拒绝，不能使用旧目录的同名片段。普通完整 MP4 的跨域／重定向通路保留。同源 renderer 及 Mac WKDownload 可取得最终响应 URL。
- CDP 在跨域请求尚未返回响应头时没有可关闭的 stream handle：取消会停止本地任务和后续保存，底层请求仍可能继续至响应／浏览器结束；迟到响应会关闭流。原生“取消后服务端断连”测试只覆盖可用 AbortController 的同源路径，不泛化为跨域保证。
- Mac 仅同步源码与静态审查，本轮 Windows 原生验证不能作为 WKWebView 验收。真实小红书／Pinterest、OS 物理拖放与发布包仍待对应环境确认。

## 工作区与质量工具

只提交本轮明确修改的文件；保留工作区原有图片、画布测试、DSH 配置和其他会话增量。未创建额外工作树，保留本轮复验材料。

官方 crapper／dryer／mutator 0.1.0 沿用 `.tmp/ub-tools/venv`，未修改项目依赖。前端 dryer 在 0.8 阈值未发现重复；mutator 在独立副本初轮扫描 97 个候选，定向执行取消握手 3 个变异，3 killed／0 survived，不能据此声称全模块覆盖。早期 Windows 编码、fixture 缺项及官方 `os.killpg` 超时兼容失败均单独保留，不算 killed。

Rust crapper 实际执行失败：tree-sitter-language-pack 缺少本机 Rust grammar，获取 GitHub manifest 时 DNS 错误（11001）；首次 metrics-root 参数未发现输入的空运行也不计验证。未获得 Rust CRAP 分数。

两个新前端文件按进度接收、会话运行、取消结果及缩略图／进度／操作拆分职责，保留已有行为。通过真实 Chromium V8 范围与 Vite source map 导出 LCOV，实测行覆盖 100%、分支覆盖 90.52%，最大 CC 8、最高 CRAP 8.8，严格阈值 9.99 通过。拆分后按新行号 152／165 复跑相同三个取消变异，3 killed／0 survived；完整 TypeScript／独立 Vite 再次通过。旧 ExploreWorkspace 外层和 Canvas 大组件未额外重构，不把它们或 Rust 计入这个指标。

最后交叉审查将跨域清单重定向从“不保证支持”收紧为明确拒绝：已复现旧目录存在同名有效片段时可能误读。最初 `no-cors + manual` 方案在 Chromium 返回 TypeError，WHATWG Fetch 也规定此组合失败；改为 `cors + manual` 并实测正常 CORS、opaqueredirect、无 CORS／CSP 失败。校验请求复用原生预设 ID／AbortController／关闭机制，15 秒超时；不增加无法取消的后台请求。新负例要求拒绝后不请求旧目录任何片段，正常跨域 CORS 清单及普通 MP4 重定向继续回归。
