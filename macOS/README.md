# Bowerbird macOS 开发版

本目录记录 Mac 上的本地开发、运行和未签名构建流程。Bowerbird 使用 canonical Tauri / React / Rust 源码，不维护 macOS override。构建架构以 `rustc -vV` 的 host 为准；Intel 为 `x86_64-apple-darwin`，Apple Silicon 原生工具链为 `aarch64-apple-darwin`。

## 2026-09-17 引导快照会话与创作提示存档重包

引导卡片从本地画板快照恢复多轮会话，复用普通生成详情和 Lightbox；提示词复用保留引用图、节点、历史别名与画幅。引导右箭头仅在当前步骤完成后推进；创作按钮通过悬停或键盘焦点显示禁用原因。同步保存画板标题与操作提示调整。

本轮验证：画板/生成逻辑 **125/125**、引导逻辑 **14/14**，三身份引导、真实引导快照、禁用原因提示、普通会话续聊 **4 组 Chrome 合成 IPC 回归**通过；TypeScript/Vite 与 Rust release 构建通过。界面测试首次因沙箱禁止绑定本机端口失败，放行后全部通过。260 个原生输入在构建开始时与上一轮验证版本一致，沿用上一轮 Rust **363 passed / 2 ignored**，本轮未重复执行 Rust 测试。保留既有编译警告。

标准 DMG 阶段失败后，使用固定 `package-dmg.sh` 封装本轮 `.app`，应用逐文件一致性、Applications 目标、背景与布局文件、镜像完整性通过。67 个包内资源匹配，版本 26.9.17、Intel x86_64 与 bowerbird 协议注册核验通过。

产物：`macOS/dist/Bowerbird_26.9.17_x64-conversation-installer.dmg`，**86,321,098 bytes**；SHA-256 `038572c9b16551c2d775b90fcf0337c609c1fdc0d98a60c1d674fb17a36278c5`，同目录附 `.sha256`，旧包保留。仅供本地测试，未签名/未公证；打开镜像后将 Bowerbird 拖到 Applications。

证据位于 `macOS/dist/verification/archive-20260917-conversation/`。构建开始保存 415 个输入指纹；等待期间另一任务修改 Cargo.toml、Cargo.lock 和本地分类 runtime.rs，其余 412 项保持一致。本轮存档不纳入这组并行修改；已保留构建输入清单和独立应用副本，二进制不含并行 runtime 新增的系统代理提示。其后新增分类文档也继续留在工作区。未执行真实 OAuth、生成服务、用户库写入或 Apple Silicon 验收，未推送或部署。

## 2026-09-17 引导入口统一存档重包

本轮统一设置重开引导与首次进入：重置身份进度和完成标记，从身份选择、第一步开始；原项目及素材保留，暂停后继续仍恢复当前步骤，不再显示回看提示。同时存档本地分类 Mac 运行时、微信登录回流及固定 DMG 安装布局。

验证：引导契约 **14/14**、三身份引导及本地分类两组 Chrome 合成 IPC 界面回归、TypeScript/Vite 通过；Rust 全量首次 **362 passed / 1 failed / 2 ignored**，唯一失败为沙箱禁止测试绑定本机端口，放行后该项 **1/1** 通过，合计 **363 passed / 2 ignored**。未执行真实 OAuth、真实用户库操作或 Apple Silicon 验收；保留既有编译警告。

产物：`macOS/dist/Bowerbird_26.9.17_x64-onboarding-installer.dmg`，**86,320,119 bytes**，SHA-256 `5e3af307002edc5ef49a9aa0a86e4ecacc5f48b1d1256fc3013a1f4401d6dcc5`；同目录附 `.sha256`，旧包保留。release 构建、67 个包内资源逐文件匹配、413 个构建输入指纹、26.9.17 版本/x86_64 架构/协议注册核验通过。DMG 脚本已检查应用逐文件一致性、Applications 目标、背景和布局文件，镜像完整性通过。

构建与测试证据保存在 `macOS/dist/verification/archive-20260917-onboarding/`。本轮只交付本地 Intel 未签名/未公证测试包，不推送或部署服务端，不替换 `/Applications` 中现有应用。

## 2026-09-17 微信登录回流修复

安装布局补包：上一份基础 `hdiutil` 镜像遗漏 Applications 快捷方式及安装提示。现提供 `macOS/dist/Bowerbird_26.9.17_x64-wechat-fix-installer.dmg`（86,320,030 bytes；SHA-256 `fa3ed530dafe4ada9eb2dcfb881885ba9e094c0939d3ca57788c1b1cb58fe304`），应用与上一份修复版逐文件一致，增加 `/Applications` 快捷方式、左右图标布局和中文拖动提示背景。HFS+ 镜像完整性、重新挂载后的图标位置与大小、快捷方式及应用内容检查通过；当前环境不能截图，Finder 背景属性读取失败，因此未将背景实际显示标记为视觉验收通过。`tauri.macos.conf.json` 已配置相同背景与布局；标准打包不可用时可运行 `bash macOS/installer/package-dmg.sh <已构建.app> <新输出.dmg>`，脚本需访问磁盘镜像服务与 Finder，拒绝覆盖已有输出。

主事件循环补接 macOS `RunEvent::Opened`，将系统投递的微信/邮箱登录链接交给既有 Rust 账号处理。此前仅处理启动参数与 single-instance 回调，Mac 扫码后无法进入验证。回调 state 校验、服务端换码、Keychain 持久化和前端通知沿用现有实现。

登录专项 Rust **19/19** 通过，包含 Opened 批量 URL/编码参数保留、非 URL 事件忽略及现有微信/邮箱安全校验。真实微信扫码仍需安装修复版后重新发起验证；测试未读写真实账号或素材库。证据保存在本地 `macOS/dist/verification/wechat-login-20260917/`。

TypeScript/Vite 与 Rust release 构建通过。Tauri DMG 脚本在沙箱中失败后，使用系统 `hdiutil` 从完整 `.app` 目录生成独立未签名 Intel 包 `macOS/dist/Bowerbird_26.9.17_x64-wechat-fix.dmg`（88,339,538 bytes；SHA-256 `5096cfb322990dcdf00d2c7dc3afd27e5b76b42cfb7ce1c2f66ec54d978f39e3`）。完整性校验、只读挂载后应用逐文件对比、x86_64 架构及 `bowerbird` 协议注册检查通过。原 26.9.17 DMG 保留；未替换 `/Applications` 中的应用，未执行真实 OAuth。

## 2026-09-17 同步 dev 26.9.17

本地 `dev` 已经 7890 代理快进到远端 `8bef9d2`；`mac` 合入该版本，保留 WKWebView 原生取图、系统标题栏、Finder CLI 路径探测和 FFmpeg 适配。新版画板交互、0030 素材库可见性与 v0917 引导资源均已同步；引导保持先画布提示、后完成/登录弹窗，维度环或滑出侧栏出现时原生网页临时隐藏。

本次在 Intel Mac 验证：Rust **361 passed / 2 ignored**（无过滤）、前端契约 **151/151**、**14 组 Chrome 合成 IPC 界面回归**、TypeScript/Vite 和 release 构建通过。界面覆盖引导流程/完整快照、双平台标题栏、探索/侧栏、素材库隐藏与恢复、建组/展开、层级、分区缩放、吸附、透明图、创作框及本地分类。真实 WKWebView 取图夹具通过 Cookie/跨域/重定向/分块/错误/超时清理及页面状态保持；真实 Tauri/AppKit 隐藏窗口验证三个标准按钮与主题切换通过。保留已有 Rust 警告和 Vite 大 chunk 提示。

- Intel x86_64 测试包：`macOS/dist/Bowerbird_26.9.17_x64.dmg`，**86,325,439 bytes**；未经 Developer ID 签名/公证。
- SHA-256：`25b1a2a3674153a8f388f4f2ab8933e4b98a94f1d7d3502a9a31a8da15d613fc`，同目录附 `.sha256`；`hdiutil verify` 通过，旧 26.9.15 DMG 保留。
- 应用：`apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app`；版本、架构、原生取图桥接、Mac 主题权限、**67 个资源文件**（含 43 个 v0917 文件）及 **418 个构建输入指纹**核对通过。
- 证据：本地 `macOS/dist/verification/sync-dev-20260917/`，包含测试/构建日志、引导截图、源码指纹和产物校验。

合并前七个文件的本地分类适配修改已完整恢复，继续保持未提交，并保留 stash 备份；本次应用按恢复后的工作区构建，因此包含这组适配。该功能的真实模型分类质量仍有已记录的误判，不能将安装/推理和界面回归通过视作准确率验收；详见 `dev-doc/LOCAL-CLASSIFICATION.md`。未操作真实素材库/账号或付费生成，未推送分支或部署服务；完整应用中的真实站点拖放、全屏空间切换及 Apple Silicon 构建未在本轮验收。

## 2026-09-15 原生 Mac 标题栏

Mac 使用系统原生标题栏：左上角红色关闭、黄色最小化、绿色缩放/全屏，标题由系统居中显示，悬停和失焦外观交给 AppKit。现有 `applyTheme` 同步 Tauri 应用主题；`capabilities/macos-titlebar.json` 仅为 Mac 的 main WebView 授予 `core:app:allow-set-app-theme`，原生标题栏跟随应用浅色/深色设置。前端 Mac 不再渲染自绘标题栏，因此没有右侧重复按钮或多余空白；Windows 保持原来的自绘标题栏。

`tauri.macos.conf.json` 仅覆盖主窗口配置，尺寸、最小尺寸和网页拖放设置与公共配置一致；使用 `decorations: true` 与 `titleBarStyle: Visible`。原生标题栏位于网页内容之外，加载或应用弹窗不会挡住按钮。配置机制见 [Tauri 平台配置](https://v2.tauri.app/reference/config/)。

验证命令：在桌面目录运行 `node scripts/window-titlebar-ui.test.mjs`；原生隔离验证运行 `cargo run --offline --manifest-path src-tauri/Cargo.toml --example mac_titlebar_smoke`。后者仅创建隐藏的非持久窗口，核验三个 AppKit 标准按钮存在、未隐藏、启用以及原生装饰与主题，不运行生产初始化或读取用户素材库。

本次通过 Windows/Mac Chrome 合成 IPC 标题栏回归（含 900px 布局、无重复控件/空白、主题同步）、TypeScript/Vite 构建，以及上述真实 Tauri/AppKit 隐藏窗口验证。证据保存在本地 `macOS/dist/verification/native-titlebar/`；未操作生产窗口或用户数据，未自动演练真实窗口的全屏空间切换。

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
- 未经 Developer ID 签名/公证的测试包：`macOS/dist/Bowerbird_26.9.15_x64.dmg`，74,555,790 bytes。
- SHA-256：`efa87f439b5f6b2f354776e7a4a04ae855404f044471aa44bf7463e42cce948c`；同目录附 `.sha256`，`hdiutil verify` 完整性检查通过。
- 本次原生标题栏重包已核对版本、Mach-O 架构、原生取图桥接保留、Mac 主窗口主题权限、49 个包内资源文件与 233 个构建源码/配置文件指纹；结果见本地 `macOS/dist/verification/native-titlebar/`。此前引导和取图验证分别见 `onboarding-order/`、`browser-capture/`，同步验证（包含公开 Cloud 配置构建注入）见父目录记录。上一个引导修复包备份在 `macOS/dist/archive/20260915-before-native-titlebar/`，更早的包仍保留。

平台边界：

- 本地分类源码已于 2026-09-16 支持 macOS 13.3+（Intel / Apple Silicon），尚未纳入此处 26.9.15 安装包；固定包及验证边界见 `dev-doc/LOCAL-CLASSIFICATION.md`。原生 Adobe Illustrator AI 导出仍限 Windows，Mac 可用图片导入与 PSD 导出。
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

## Mac DMG 固定打包与交付流程

本节是后续每次 Mac 打包的操作入口，适用于测试版、热修复版和同版本重包。产品约定见 [PROJECT.md「关键约定」](../PROJECT.md#关键约定)。

### 1. 保持统一安装界面

- 窗口 660 × 400，左侧 `Bowerbird.app`，右侧 `Applications` 快捷方式，目标必须是 `/Applications`。
- 图标位置分别为 `(180, 190)`、`(480, 190)`；背景使用 [installer/background.png](installer/background.png)，包含方向箭头及中文拖动安装提示。
- 标准构建读取 `apps/desktop/src-tauri/tauri.macos.conf.json`；独立重打包脚本使用同一背景和位置。修改布局时同步两处。
- 不交付缺少 Applications 快捷方式或安装提示的基础 DMG。

### 2. 构建或重封装

源码有变化时，完成相关检查后从仓库根目录运行标准构建：

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

仅调整安装布局，或标准 DMG 阶段失败但 `.app` 已构建通过时，复用该应用，不为重新封装重复编译。使用以下脚本，先把输出文件名替换为本次实际版本与架构：

```bash
bash macOS/installer/package-dmg.sh \
  apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app \
  "macOS/dist/Bowerbird_<版本>_<架构>-installer.dmg"
```

脚本制作 HFS+ 镜像、加入 Applications 快捷方式和背景，通过 Finder 保存图标布局，再转换为只读压缩 DMG；自动检查应用内容一致性、链接目标、`.DS_Store`、镜像完整性并生成 `.sha256`。需要本机磁盘镜像服务和 Finder 可用；沙箱报设备不可用时使用正常权限流程运行该脚本，不改用缺少布局的简包。若 `/Volumes/Bowerbird 安装` 已存在，先确认并推出旧的同名安装镜像。脚本拒绝覆盖已有输出，旧包应保留或归档，再选择新文件名。

### 3. 检查后直接交付

1. 确认版本、实际架构、`bowerbird` 协议注册与本次要求的资源；只重封装时确认包内 `.app` 与输入应用逐文件一致。
2. 运行 `hdiutil verify <成品.dmg>`；核对 Applications 链接、背景文件和已保存的 `.DS_Store`。新建或修改打包流程时，可只读重新挂载核对布局；已有检查通过后不重复验证。
3. 在 `macOS/dist/` 保留成品与 SHA-256 校验文件，记录产物路径、大小、哈希及实际检查结果；保留旧版本。未经签名/公证的包如实标注。
4. **无需截图或录屏验收，也不把 Finder 背景属性读取失败当成交付阻塞。** 基础检查通过即交付安装包链接，说明将 Bowerbird 拖到 Applications；不为获取截图反复挂载、重包。

涉及 Finder 启动环境、登录回调等功能变更时，功能实测与安装包检查分开记录；未执行的真实登录/用户环境验证不得写成已通过。纯安装布局重包不要求重新登录、操作素材库或重复完整功能验收。

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
