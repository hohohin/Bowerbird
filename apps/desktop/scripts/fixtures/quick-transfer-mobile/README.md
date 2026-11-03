# 手机真实协议隔离检查

从仓库根运行：

```powershell
cargo +stable test --manifest-path apps/desktop/scripts/fixtures/quick-transfer-mobile/Cargo.toml --target-dir .tmp/quick-transfer-transport-tests/target --offline -- --nocapture
```

需要现有 Rust 1.90、Chrome、`apps/html-renderer/node_modules/playwright`；不安装工具链、不启动主应用、不访问用户素材库。该独立 Cargo 包直接编译正式 transport，临时目录写入合成 PNG 名称的测试字节，注入接收确认/拒绝与延迟；它验证传输协议和网页状态，不代替生产媒体内容校验。

默认绑定 loopback。需验证真实局域网地址时，在同一 PowerShell 调用设置 `$env:BOWERBIRD_TEST_BIND_IP='本机实际IPv4'`；该地址仍须通过正式 transport 的本机私网校验。2026-11-03 已用 WLAN `192.168.1.5` 完成 18 项测试，不仅使用 loopback。此主机访问自己的 LAN 地址不能证明另一台手机或路由器的入站路径。

Chrome 执行 `scripts/quick-transfer-mobile.test.mjs`，使用正式 `src-tauri/src/quick_transfer/upload.html`、真实 scoped listener/Host/Origin/CSP/PIN 与上传接口，覆盖顺序、确认前进度、中文名称、字面 XSS、显式重复、拒绝与只重试未确认项、鉴权取消、断网、已收到但丢失回执、旧链接、关闭监听、320px 深浅色。脚本只向临时目录写关闭信号，让 Rust 实际停止 listener；不添加测试 HTTP 端点。

跟进补充：公共短地址仅展示配对表单，8 位码保留前导零、接受带空格粘贴；错误码原地提示、正确码才进入上传页。三次错误后的真实 HTTP 429 由 Rust 测试覆盖；浏览器注入 429 检查停用与不自动重试。Safari/微信 User-Agent 及触屏/窄视口在 Chromium 中实际渲染并上传，检查 Content-Type UTF-8、CSP、no-store、no-referrer、DENY；这不是 WebKit/iOS 真机。

相册跟进：浏览器实际点击“相册”与“文件”并检查 filechooser；相册请求 `image/*,video/*` 多选、无 capture，文件入口无 accept，保留音频/文本。空选择保留队列，同文件重选重置待发送，PNG/MP4 与 TXT/MP3 都通过真实临时上传。此事件验证不代表 Android 系统相册真机已测；具体选取 UI 由系统/浏览器提供。

截图及 JSON 报告写入 `apps/desktop/.tmp/quick-transfer-mobile/`。浏览器与接收句柄均在结束时关闭。这里只是 Chrome 窄视口、临时数据，未代表真实 iOS/Android、局域网防火墙、手机后台或安装包验收。传输自身的其他单测也由该 harness 执行。
