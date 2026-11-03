# 手机真实协议隔离检查

从仓库根运行：

```powershell
cargo +stable test --manifest-path apps/desktop/scripts/fixtures/quick-transfer-mobile/Cargo.toml --target-dir .tmp/quick-transfer-transport-tests/target --offline -- --nocapture
```

需要现有 Rust 1.90、Chrome、`apps/html-renderer/node_modules/playwright`；不安装工具链、不启动主应用、不访问用户素材库。该独立 Cargo 包直接编译正式 transport，临时目录写入合成 PNG 名称的测试字节，注入接收确认/拒绝与延迟；它验证传输协议和网页状态，不代替生产媒体内容校验。

Chrome 执行 `scripts/quick-transfer-mobile.test.mjs`，使用正式 `src-tauri/src/quick_transfer/upload.html`、真实 scoped listener/Host/Origin/CSP/PIN 与上传接口，覆盖顺序、确认前进度、中文名称、字面 XSS、显式重复、拒绝与只重试未确认项、鉴权取消、断网、已收到但丢失回执、旧链接、关闭监听、320px 深浅色。脚本只向临时目录写关闭信号，让 Rust 实际停止 listener；不添加测试 HTTP 端点。

截图及 JSON 报告写入 `apps/desktop/.tmp/quick-transfer-mobile/`。浏览器与接收句柄均在结束时关闭。这里只是 Chrome 窄视口、临时数据，未代表真实 iOS/Android、局域网防火墙、手机后台或安装包验收。传输自身的其他单测也由该 harness 执行。
