# Pinterest 视频采集修复 · 2026-11-05

用户复测确认小红书已可采集，但 Pinterest 普通视频仍提示未找到分段清单。本轮沿 ub-mode 完成来源复现、红绿回归、原生验证及局部质量检查；复用 `source_browser_video.js` 的身份／手势解析、`source_browser_network.rs` 的浏览器会话读取和既有 `capture_video`，不新增下载服务或视频抓取器。

## 诊断与修复

1. 隔离浏览器被登录页阻挡；用户按 Esc 后停止窗口操作、撤销临时诊断，再获得「允许后台诊断」。之后仅连接隐藏 WebView 的本机调试端口，不移动物理鼠标、不读取／导出 Cookie，不向用户素材库写入测试内容。
2. 登录页实际 Pin `657947826857074269`（Naval Zone | Battleship Game）的 GraphQL 使用不透明 `id` 与数字 `entityId`，视频位于 `storyPinData.pages[].blocks[].videoDataV2.videoListMobile`／`videoList720P`。旧解析只认识 REST 名称。保留实际结构、替换身份／媒体 URL 的夹具先复现“尚未找到当前视频的分段清单”，然后补齐字段及数字身份解析。其他实际页面仍可能有旧 REST 数据，因此不把所有失败归因于单一 GraphQL 路径。
3. 首屏 `__PWS_RELAY_SSR_REQUESTS__` 的 `response.data.v3GetPinQueryv2.data` 还提供完整 MP4，旧初始状态只有 HLS。增加有界读取（最多 128 个请求），只提取已匹配 Pin 的媒体记录，优先明确完整 MP4。回归先复现返回 HLS 而非 MP4，再验证修复。一次真实页的补充 SSR 请求已被网站标记 `Timeout waiting for relay SSR response`，刷新隐藏页面后完成；最终真实视频的生产拖动脚本返回同一 Pin 的 `_720w.mp4`。未编造 MP4 地址、未调用未观察到的站点接口。
4. 真实 Pinterest CDN 的 HLS 返回 `Access-Control-Allow-Credentials: false`；旧 CORS 清单确认使用 `credentials: include`，得到未知结果，匿名请求则成功。Windows 只对 HTTPS `pinterest.com`／`www.pinterest.com` 页面到 HTTPS `pinimg.com` 或其子域使用无凭据读取。CDP 字节读取与 renderer 清单无跳转检查共用原生计算的同一策略；其他站点、HTTP 和伪装域名不放行。
5. 该真实 HLS 使用字节范围分段，原解析按既定边界拒绝。它同时有站点明确提供的完整 MP4，最终走完整文件路径；本轮没有宣称支持字节范围 HLS。没有完整文件、或网站补充数据超时且仅有这类清单时，仍可能失败。无稳定 Pin 身份的广告也不猜测旁边视频。

## 验证

- `node scripts/source-browser-video-sites.test.mjs`：14 组通过，含首屏 Relay、GraphQL SPA、直接视频／多视频、身份冲突、压缩 JSON XHR、跨 SPA 返回、小红书 EF 分组、大状态索引与 Pinterest 卡片手势。
- `node scripts/source-browser-video.test.mjs`：匿名 CDN CORS 与默认凭据、真实 Blob 字节／分块／大小限制、MSE 对应／歧义及旧站点路径通过。
- `cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example explorer_smoke source_browser_network::tests`：3 项通过；新策略覆盖 9 组有效／伪装／HTTP／其他站点组合。
- 原生例程与生产源文件共用代码、独立主页面和登录资料。最终 `cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example explorer_smoke` 成功；`verify-native-video-stream.mjs` 通过 HLS／独立音轨／DASH／压缩清单／跨源 CORS、XHS response/index 与 Pin response/index/graphql/relay 六条来源链路，以及 Cookie 会话、重定向／未知清单拒绝、缺片／部分内容、取消和文档切换。日志为 `.tmp/pinterest-video-20261105/native-final.log`，隔离目录 `apps/desktop/.tmp/video-stream-native-1793815063062/`。
- 可选 `--live-pinterest=<公开 pinimg.com 媒体地址>` 只用于人工复核，默认套件保持隔离。实际完整 MP4 经生产 Rust 采集函数得到 **303,812 字节，720×450，5.601995 秒，含音轨**；FFmpeg 全片解码通过。测试文件只保存在本轮临时目录，不进入用户库。
- ub-mode：官方 Crapper／Dryer／Mutator 在 Windows 使用已安装解析器适配。对本次修改的 10 个 JS 辅助函数作保持行号／字节位置的提取，以两套真实浏览器用例的 V8 覆盖率映射；行覆盖 100%，CRAP 1–8，Dryer 阈值 0.8 无重复候选。7 个定向变异（身份、GraphQL story／block、多视频、变体选择、默认凭据、Relay 缓存）全部被行为断言杀死。此指标只代表这些 JS 函数；原生 Rust 以单元和原生端到端测试验证，不虚报 Rust 覆盖率或整个模块 CRAP。

## 交付边界与清理

真实网页验证包括现有视频元素、生产拖动脚本的合成事件及解析返回；下载验证使用同一原生采集实现。没有执行 OS 物理拖动到用户标签／素材库并保存，不将两段验证写成用户库端到端验收。未发布安装包，未验证 Mac 原生。

临时启用的 9577／9578 调试配置已从 `tauri.conf.json` 与 `source_browser.rs` 撤回；这两个文件不进入提交。本轮保留小型诊断／质量证据，清理确认不再使用的真实视频临时副本；不删除其他任务的临时文件或未提交改动。只提交本轮来源、网络策略、夹具／测试和上述文档，不夹带其他会话的画板、预览或 H3 修改。

开发 EXE 于 2026-11-05 01:57（本机时间）自动重建并重启；逐字节检查运行路径 `apps/desktop/src-tauri/target/debug/bowerbird-desktop.exe` 与最终 `explorer_smoke.exe` 均嵌入本次完整 JS 源码，9577／9578 无监听。原生实站下载的两份 `pin-public.mp4` 验证后删除，保留尺寸／时长／解码日志。
