# Bowerbird macOS 开发版

本目录记录 Mac 上的本地开发、运行和未签名构建流程。Bowerbird 使用 canonical Tauri / React / Rust 源码，不维护 macOS override。构建架构以 `rustc -vV` 的 host 为准；Intel 为 `x86_64-apple-darwin`，Apple Silicon 原生工具链为 `aarch64-apple-darwin`。

## 2026-09-15 引导遮挡与结束顺序修复

维度环出现时暂时隐藏原生网页，关闭维度环后恢复同一网页，避免第九步「反推提示词」被 WKWebView 覆盖。设计师第十步先显示全画布提示，第十一步才显示最终完成/微信登录弹窗；全画布提示使用「下一步」，只在最终弹窗完成一次。旧会话迁移保留项目及已完成状态。

14 项进度契约、三身份 Chrome 合成 IPC 界面回归与 TypeScript/Vite 构建通过，截图及日志位于本地 `macOS/dist/verification/onboarding-order/`。此轮未执行真实站点、账号或用户素材库操作。

## 2026-09-15 内置浏览器采集修复

Mac 取图此前直接进入“不支持”分支。现在通过当前 WKWebView 的原生 WKDownload 获取图片，沿用浏览器登录态，复用现有去重、来源记录与目标项目入库流程。需要 macOS 11.3+，单图上限 50 MiB、超时 45 秒，采集不刷新原网页。

隔离原生测试使用真实 WKWebView 与生产桥接，验证带 HttpOnly Cookie 的跨域图片、重定向、分块响应、HTTP/HTML/大小/断网/超时错误、临时文件清理与网页状态保持；Rust 浏览器相关 7 项、前端探索契约 7 项及 TypeScript/Vite 构建通过。命令及验收边界见 `dev-doc/EMBEDDED-BROWSER.md`。未操作真实站点账号或生产素材库，物理拖放仍需使用新版实机确认。

构建接缝：Tauri 的较低部署目标会让 Objective-C `@available` 生成 Clang 运行库调用，而 Rust 的 `-nodefaultlibs` 不会自动补入该库。`build.rs` 从实际编译器查询并链接 `libclang_rt.osx.a`；独立 Rust/Objective-C 链接及回调验证通过。

## 2026-09-15 同步

`mac` 从远端 `0fcde4d` 合入 `dev` 的 `01e8372`（26.9.15），包含项目画板、编辑工具、生成恢复、视觉规范与随包引导项目。保留 Finder 启动时的 Homebrew/用户 bin 探测和子进程 PATH；Codex 调用及终端会话回看统一使用 Bowerbird 私有 `cli-profiles/codex`。终端命令通过 AppleScript 参数传递，路径、参数和环境变量逐项进行 shell 转义；同时修复即梦登录入口的 macOS 条件编译错误。

视频工具使用同一绝对路径解析器，Mac 额外探测 `/opt/homebrew/bin`、`/usr/local/bin` 与 `~/.local/bin` 下的 FFmpeg/ffprobe，不修改系统 PATH。

前后端同时识别 `/var/folders/.../T/` 与 `/private/var/folders/.../T/` 中的采集临时来源，禁止把它们作为“移出园丁鸟”的恢复位置；普通用户文件夹仍可恢复。

本次自动化验证：

- Rust 库测试：353 passed / 2 ignored，无过滤；其中真实视频测试另行运行并通过，余下本地分类模型测试未执行。
- 真实视频测试将子进程 PATH 限制为 `/usr/bin:/bin`，清除 FFmpeg 路径覆盖，通过公共解析器找到本机工具，验证临时视频入库、时长/尺寸与 JPEG 海报。
- 画板/生成恢复/引导/探索/路由 136 项、资产移出规则 4 项通过。
- 标题栏与随包引导项目两组 Chrome 合成 IPC 界面回归通过；截图位于本地 `macOS/dist/verification/`。
- TypeScript/Vite production build 通过；保留 dev 既有 Rust 警告与 Vite 大 chunk 提示。

本次交付为 **Intel x86_64**（本机 Node 26.4.0、Rust 1.96.0），不是 arm64/Universal 构建：

- 应用：`apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app`。
- 未经 Developer ID 签名/公证的测试包：`macOS/dist/Bowerbird_26.9.15_x64.dmg`，74,555,391 bytes。
- SHA-256：`11af9c9c93c2371b19a2e533de88b2106b9eb2734b43e337d7b1662e7aa9f40a`；同目录附 `.sha256`，`hdiutil verify` 完整性检查通过。
- 本次引导修复重包已核对版本、Mach-O 架构、原生取图桥接保留、49 个包内资源文件与 230 个前端/Rust/原生源文件指纹；结果见本地 `macOS/dist/verification/onboarding-order/`。此前取图验证见 `browser-capture/`，同步验证（包含公开 Cloud 配置构建注入）见父目录记录。上一个取图修复包备份在 `macOS/dist/archive/20260915-before-onboarding-order-fix/`，更早的包仍保留。

平台边界：

- 本地分类模型运行时、原生 Adobe Illustrator AI 导出仍沿用 dev 的 Windows 实现；Mac 可用图片导入与 PSD 导出。
- Dreamina 在 Mac 上沿用官方 CLI 的凭据存储；Windows 注册表隔离与 NSIS 安装清登录钩子不适用于 Mac，不能宣称 Mac Dreamina 凭据已隔离。
- 本次不改写真实素材库，不执行付费生成或真实 OAuth。Chrome 合成 IPC 回归不等同于 WKWebView/Finder 真机验收。

> **codex CLI 隐形**：首启若 codex 未就绪，引导页可在 app 内一键安装（优先免 Node 直装独立版，直装失败且本机有 npm 时回退 `npm install -g @openai/codex`，进度流式）+ 一键 OAuth 登录（`codex login` 自动开浏览器），用户全程不碰终端。macOS 上 npm/codex 检测除当前 PATH 外还会查 `/opt/homebrew/bin`、`/usr/local/bin` 与用户 bin，Finder 双击启动 `.app` 也能找到。

> **浏览器扩展随包内嵌 + 心跳状态 + 通用网页采集**：release 构建会把 `apps/extension/` 内嵌进 `.app`（`extension/` 资源），首启引导复制路径让你粘到 Chrome「加载已解压扩展」加载；扩展每 15s 心跳，app 据此显示连接状态（30s 无心跳自动判离线）。通用网页采集由扩展 background 在浏览器登录态/系统代理环境内读取图片字节、经 `save_blob` 上传，桌面端免二次下载（Pinterest 等需登录站必需）；小红书等公开图床仍走 `save_batch`。

## 当前支持范围

本阶段目标：

- Mac 本地开发运行（按本机 Rust 架构构建）；
- 生成本地 `.app`；
- 生成仅供测试的未签名 DMG；
- 验证 Finder、WKWebView、浏览器扩展与 AI CLI 的平台接缝。

本阶段不包含：

- Developer ID 签名与 Apple 公证；
- Universal Binary 与跨架构运行验收；
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

3. 安装与本机架构匹配的 Rust 工具链：

   ```bash
   rustup default stable
   rustc -vV
   cargo --version
   ```

   `rustc -vV` 的 host 应与目标机器匹配；不要把 x86_64 构建标记为 arm64。

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

`uname -m` 与 `rustc -vV` 用于记录本次构建架构。

Cloud 构建需在被 Git 忽略的 `apps/cloud/.env.local` 配置 `BOWERBIRD_SUPABASE_URL` 与 `BOWERBIRD_SUPABASE_PUBLISHABLE_KEY`；仅放公开客户端配置，不放 service-role 或模型密钥。官方站点 `/api/image-config` 提供公开 URL 与 publishable key。离线权益验证另需匹配服务端的 `BOWERBIRD_ENTITLEMENT_PUBKEY`；缺失时不启用离线宽限验签。

网络需要代理时，可仅为本次命令设置 `https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890`。

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

## 构建本机架构 app 与未签名 DMG

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

应显示与本次 Rust host 匹配的 Mach-O 架构。本阶段不要求 Universal Binary。

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
