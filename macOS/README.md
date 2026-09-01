# Bowerbird macOS 开发版

本目录记录 Apple Silicon（arm64）Mac 上的本地开发、运行和未签名构建流程。Bowerbird 使用 canonical Tauri / React / Rust 源码，不维护 macOS override。

> **codex CLI 隐形**：首启若 codex 未就绪，引导页可在 app 内一键安装（优先免 Node 直装独立版，直装失败且本机有 npm 时回退 `npm install -g @openai/codex`，进度流式）+ 一键 OAuth 登录（`codex login` 自动开浏览器），用户全程不碰终端。macOS 上 npm/codex 检测除当前 PATH 外还会查 `/opt/homebrew/bin`、`/usr/local/bin` 与用户 bin，Finder 双击启动 `.app` 也能找到。

> **浏览器扩展随包内嵌 + 心跳状态 + 通用网页采集**：release 构建会把 `apps/extension/` 内嵌进 `.app`（`extension/` 资源），首启引导复制路径让你粘到 Chrome「加载已解压扩展」加载；扩展每 15s 心跳，app 据此显示连接状态（30s 无心跳自动判离线）。通用网页采集由扩展 background 在浏览器登录态/系统代理环境内读取图片字节、经 `save_blob` 上传，桌面端免二次下载（Pinterest 等需登录站必需）；小红书等公开图床仍走 `save_batch`。

## 当前支持范围

本阶段目标：

- Apple Silicon Mac 本地开发运行；
- 生成本地 `.app`；
- 生成仅供测试的未签名 DMG；
- 验证 Finder、WKWebView、浏览器扩展与 AI CLI 的平台接缝。

本阶段不包含：

- Developer ID 签名与 Apple 公证；
- Intel Mac 或 Universal Binary；
- App Store 发布；
- Windows 素材库/数据库迁移；
- ffmpeg/ffprobe sidecar 打包。

## 环境要求

1. 安装 Xcode Command Line Tools：

   ```bash
   xcode-select --install
   xcode-select -p
   ```

2. 安装 Node.js 22 LTS，并启用 Corepack：

   ```bash
   node --version
   corepack enable
   pnpm --version
   ```

   项目固定使用 pnpm `11.10.0`。

3. 安装原生 Apple Silicon Rust 工具链：

   ```bash
   rustup default stable-aarch64-apple-darwin
   rustc -vV
   cargo --version
   ```

   `rustc -vV` 的 host 应为 `aarch64-apple-darwin`。

4. 可选外部能力：

   - Codex：`npm install -g @openai/codex`，再运行 `codex login`；素材库基础能力不依赖 Codex。
   - 即梦：按官方安装方式安装 `dreamina`，再运行 `dreamina login`；仅即梦出图依赖它。
   - 视频：`ffmpeg` 和 `ffprobe`；图片导入与浏览不依赖它们。

## 安装依赖与静态检查

在仓库根目录执行：

```bash
uname -m
pnpm install --frozen-lockfile
pnpm lint
pnpm build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

`uname -m` 应输出 `arm64`。

## 开发运行

```bash
pnpm tauri dev
```

至少验证：

- 素材库初始化、图片和文件夹导入；
- 原图、缩略图和详情页显示；
- ProseMirror 中文输入、粘贴、图片 chip 与素材拖拽；
- 右键“在所在文件夹中显示”能在 Finder 定位文件；
- “用系统程序打开”正常；
- Chrome/Chromium 加载 `apps/extension/` 后能连接 `127.0.0.1:39871` 并采集入库；
- 未安装 AI CLI 时相应功能置灰，应用不崩溃。

## 构建 Apple Silicon app 与未签名 DMG

```bash
pnpm tauri build --bundles app,dmg
```

产物位于：

```text
apps/desktop/src-tauri/target/release/bundle/macos/
apps/desktop/src-tauri/target/release/bundle/dmg/
```

实际文件名以 Tauri 输出为准。检查应用主二进制：

```bash
file apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app/Contents/MacOS/*
```

应显示 arm64 Mach-O。本阶段不要求 Universal Binary。

构建完成后必须在 Finder 中双击 `.app` 测试，不要只从 Terminal 运行可执行文件；Finder 启动环境更接近用户实际使用，也能暴露 PATH 差异。

## Codex / Dreamina PATH 排查

先检查终端中的安装位置：

```bash
which codex
which dreamina
```

macOS 从 Finder 启动 GUI 应用时，通常不会继承交互 shell 的完整 PATH。Bowerbird 的 Codex 探测除当前 PATH 外还会检查：

- `/opt/homebrew/bin/codex`
- `/usr/local/bin/codex`
- `~/.local/bin/codex`
- `~/.volta/bin/codex`
- `~/.local/share/pnpm/codex`

也可使用 `BOWERBIRD_CODEX_BINARY` 显式指定 Codex 绝对路径，但 Finder 启动的应用不一定继承终端临时设置的环境变量，因此优先使用稳定安装路径。

Dreamina 默认检查 `~/.local/bin/dreamina` 与 PATH。登录操作会拉起 Terminal.app 运行 `dreamina login`，因为该 CLI 的交互式 OAuth 需要真实 TTY。

## 未签名产物说明

本阶段 DMG 仅用于本地开发验证，不是可公开分发的正式安装包。若从其他机器下载或传输后触发 Gatekeeper，可在 Finder 中按住 Control 点击/右键应用并选择“打开”完成本地测试。

不要把关闭 Gatekeeper、签名或公证当作本阶段步骤。公开分发前必须另行完成 Developer ID 签名、公证、staple 和干净机器验收。

## 回传验证结果

若构建或运行失败，请记录并回传：

- macOS 版本与芯片；
- `node --version`、`pnpm --version`、`rustc -vV`；
- 失败命令和完整 stderr；
- 是从 `pnpm tauri dev` 运行，还是 Finder 双击 `.app`；
- Codex / Dreamina / ffmpeg 是否安装及 `which` 输出。
