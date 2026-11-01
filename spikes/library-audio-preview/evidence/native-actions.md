# Windows 原生音频隔离验证动作记录

2026-11-01。执行范围仅为 `apps/desktop/src-tauri/examples/audio_preview_smoke.rs`、`apps/desktop/scripts/audio-preview-native.test.mjs` 与本目录；没有修改正式播放器、数据库或用户素材。上层任务另外提供合成媒体与独立 UI fixture。

## 有效结果

- `run-1793496852579/result.json`：裸 Node WebSocket CDP，没有连接 Playwright、没有开启 Network domain。8 个合成 WAV/FLAC/VBR MP3/M4A 文件都从中点开始，`play()` 成功后继续推进至少 0.2 秒；包括一小时 MP3/FLAC 与十分钟 115.2 MB WAV。全部进入时 `navigator.userActivation.hasBeenActive/isActive=false`，`muted=false`、音量 0.03。
- 同一裸 CDP 进程完成三轮各 100 次真实 CDP pointer 移动，约 16 ms 间隔；每轮移出后自然等待 5 秒，没有强制 GC。全进程树 private memory 为 240.33 / 251.18 / 249.05 MiB；renderer 为 32.91 / 41.18 / 37.11 MiB；每轮迟到播放为 0，唯一 audio 暂停且移除 src。不能把全 WebView2 进程树归为波形或音频解码器的专用内存。
- `run-1793496942523/result.json`：实际独立 `preview.html/preview.js` 使用 Tauri 原生 asset URL，WAV 与一小时 MP3 在 50% 位置开始并推进，移到 header 后收到 pointerleave，立即暂停并移除 src。只有一个 audio，音量 0.03。90 ms 停留策略下 100 次快速划过新增媒体请求为 0。
- 最后一轮 UI 有 8 次 asset 请求，全部带 Range、全部返回 206；记录的 Content-Length 合计 7,424,078 bytes。该值是协议响应体长度，不是物理磁盘读取量，也不保证取消的响应被完整消费。两次播放后 private 为 325.89 MiB；快速划过并等待 5 秒后 285.96 MiB。该轮仍有 Playwright 的 Network 观测，仅用作交互与协议证据。
- 原生环境为 Windows WebView2 `Edg/156.0.0.0`，Tauri 2.11.5 / Wry 0.55.1，debug 构建；记录了实际 WebView2 `--autoplay-policy=no-user-gesture-required` 参数。macOS 未运行。
- `source-integrity.json`：八份合成源文件的 SHA-256 与任务开始时 `original-hashes.json` 全部一致。

## 操作与原因

1. 阅读 ub-mode、PROJECT 当前约定、媒体/架构/Windows 文档以及已有 video_player_smoke 和 video-player-native-ui 测试，沿用无生产 setup/plugins 的最小 Tauri 例子。
2. 创建 debug-only example：独立 identifier、APPDATA/LOCALAPPDATA/profile；只允许指定合成目录的 asset scope，注入的 ID→路径映射逐项 canonicalize 并限制到该目录。没有调用正式应用初始化、数据库或账号代码。
3. 离线编译。沙箱构建在 Tauri 文件生成处 Access denied；正常本机权限下 `cargo build --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --example audio_preview_smoke` 成功。既有库编译警告保留，不修改无关代码。一次 rustfmt 受沙箱路径权限限制，未据此改动其他文件。
4. 编写真实媒体请求驱动、CDP Range 旁路记录、单播放器控制器与进程树内存采样。初次沙箱启动无法连接 CDP/CIM；转正常本机权限后修复端点先于页面加载的测试启动竞态。
5. 初轮 `run-1793496159364` 的长音频断言误把已设定 currentTime 当成时间推进，且按钮边框造成中点偏差。保留原记录，但此轮不能作为通过证据。改为以实际鼠标矩形宽度求比例，必须等 `play()` fulfilled，并检查相对设定目标再推进 0.2 秒。严格 8 格式重跑 `run-1793496231979` 通过。
6. 三轮 raw 切源 + Network 观测的 `run-1793496485497` 出现 private 持续增长，主要在一个 WebView2 进程，Rust 宿主约 4–5 MiB。只读核对 Playwright 内部也开启 Network，Chromium DevTools 会保留响应 payload；没有修改产品播放路径来掩盖指标。
7. 增加裸 CDP 对照：不连接 Playwright，不启用任何 Network domain，只用 Runtime（userGesture:false）与 Input。上述持续每轮增长在有限三轮中消失。结合源码与对照，观测保留是有证据支持的主要解释；这不是对所有机器、运行时或无限长时间的内存无泄漏证明，也不是严格单变量因果实验。
8. 真实 UI 首次停止断言失败。诊断截图和 elementFromPoint 证明测试代理丢失 Accept:text/css，使 Vite 返回 CSS 模块 JS，样式缺失导致巨大 canvas，(5,5) 仍命中同一 audio-wave，根本没有 pointerleave。修复测试代理的 Accept 透传，UI 代理随后提供不依赖 Vite 的静态 server；保留原停止断言，没有放宽产品行为。
9. 进程树采样补上父子 CreationDate 检查，排除 Windows PID 复用误纳旧进程；保留角色（renderer/gpu/utility）而不输出完整命令行。旧 UI-only `run-1793496601817` 的内存因误纳旧进程不能使用。
10. 单独复验真实 UI；最终用 Audio 构造时即设音量 0.03，避免页面重载重新变成音量 1。`run-1793496942523` 为最终 UI 证据。最后复核 8 个合成文件 SHA-256，无变化。

## 重现命令（PowerShell，仓库根目录）

```powershell
cargo build --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --example audio_preview_smoke
$env:BOWERBIRD_AUDIO_NATIVE_MANIFEST = 'D:/H/Project/Bowerbird/.tmp/audio-preview-fixtures/sources.json'
$env:BOWERBIRD_AUDIO_NATIVE_NO_NETWORK = '1'
node apps/desktop/scripts/audio-preview-native.test.mjs
Remove-Item Env:BOWERBIRD_AUDIO_NATIVE_NO_NETWORK
$env:BOWERBIRD_AUDIO_NATIVE_UI_ONLY = '1'
node apps/desktop/scripts/audio-preview-native.test.mjs
```

正常权限的原生进程启动与 CIM 采样是本环境所需；没有下载工具、重启正式应用、commit 或 push。测试启动的进程与 server 在 finally 清理，结果和隔离 profiles 保留为证据。

## 指标边界

- pointerenter→play promise fulfilled 是软件播放启动指标；裸 CDP 的一小时 MP3 51.6 ms、FLAC 33.2 ms、十分钟 WAV 31.9 ms。每个文件只有这轮单样本，不是 P95。
- UI 的 pointer→观察到目标后推进 0.2 秒包括 90 ms 停留、播放时间和轮询，不能叫首音延迟。
- 没有进行声卡回录、扬声器听感、首个可听样本测量、严格 VBR 瞬态对齐、持续数小时压力或 Mac 验证。
- 脱离 Network 观测的内存数据与开启观测的 Range 字节数据分别采集，不能合并成同一轮性能数字。
