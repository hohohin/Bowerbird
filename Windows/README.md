# Bowerbird Windows 版

这里存放 Bowerbird 的 Windows 开发、构建与独立扩展加载工具。平台兼容行为已经并入项目主源码；脚本只把 canonical 项目复制到 `Windows/.work/`，不再用整文件 override 替换源码。`Windows/overrides/` 仅保留退役说明，不参与构建。

## 已适配

- 构建 Windows x64 桌面应用与 NSIS `.exe` 安装包。
- 兼容 npm 全局安装生成的 `codex.cmd`，并在 GUI 的 PATH 不完整时检查 `%APPDATA%\npm`。
- 应用内可一键直装官方独立版 codex（从 npm 镜像下载平台包 tarball 解压到应用数据目录，用户无需安装 Node.js；解析时托管副本优先）。
- 登录检测支持 `CODEX_HOME` 和 `%USERPROFILE%\.codex\auth.json`。
- “在 codex 中打开会话”会启动 Windows 命令提示符并运行 `codex resume`。
- 浏览器采集服务的 `save_batch` 与 `save_blob + binary` 两条协议均位于 canonical Rust 源码；`apps/extension/` 与 `Windows/extension/` 分别使用对应协议。
- 用户数据继续由 Tauri 写入 Windows AppData，不写入安装目录。

## 环境要求

1. Windows 10 1803+ 或 Windows 11（需要 WebView2；Windows 11 通常已内置）。
2. Node.js 22 LTS+，并启用 pnpm：`corepack enable`。
3. Rust MSVC 工具链：`rustup default stable-x86_64-pc-windows-msvc`。
4. Visual Studio 2022 Build Tools，勾选“使用 C++ 的桌面开发”和 Windows 10/11 SDK。
5. AI 功能可在应用内一键安装 codex CLI（自动下载独立版，无需 Node.js）并登录 ChatGPT；不安装时素材库仍可用，AI 按项目约定降级置灰。
6. 视频预览另需 `ffmpeg` 与 `ffprobe` 在 PATH；图片功能不依赖它们。

## 开发运行

在项目根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\dev.ps1
```

## 构建安装包

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\build.ps1 -Clean
```

脚本先执行 TypeScript 检查和 Rust 测试，再生成 `Windows/dist/Bowerbird_*_x64-setup.exe`。仅在已单独验证时可用 `-SkipTests` 跳过测试。

## 常见问题

- 提示 Rust host 不是 MSVC：运行 `rustup toolchain install stable-x86_64-pc-windows-msvc`，再运行 `rustup default stable-x86_64-pc-windows-msvc`。
- 链接器或 `windows.h` 缺失：通过 Visual Studio Installer 补装 C++ Build Tools 和 Windows SDK。
- codex 检测失败：在普通命令提示符运行 `codex --version` 与 `codex login`，然后完全退出并重开 Bowerbird。
- 视频无缩略图：安装 ffmpeg，并确认 `ffmpeg -version`、`ffprobe -version` 都能运行。
