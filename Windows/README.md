# Bowerbird Windows 版

这里存放 Bowerbird 的 Windows 开发、构建与独立扩展加载工具。平台兼容行为已经并入项目主源码；脚本只把 canonical 项目复制到 Windows/.work，不再用整文件 override 替换源码。Windows/overrides/ 仅保留退役说明，不参与构建。

## 2026-10-10 Windows 26.10.1001 已发布

修复多张画板结果作为普通引用时被要求选择父结果、无法发送的问题；全部引用及精确节点保持，明确继续/重试仍接回原结果。源码 3d46e3a，70 项逻辑、3 组画板合成 IPC、TypeScript/Vite/正式构建、666 个输入与 67 个资源、包内等待 6 项及签名/完整公网下载通过。沿用 904 的更新保留登录规则，Mac 保持 26.10.801；真实安装升级待验。产物 `Windows/dist/Bowerbird_26.10.1001_x64-setup.exe`，发布和回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-09 Windows 26.10.904 已发布

应用内更新现在保留 Bowerbird 账号、权益缓存及 Codex/Dreamina 私有登录；普通手动安装/重装仍重置。实际 NSIS 隔离夹具、新包/资源/签名与完整公网下载验证通过，官网及自动更新已切换。旧客户端通过应用内更新到本版即可保留正常登录；真实账号升级仍待实机验收。产物在 `Windows/dist/Bowerbird_26.10.904_x64-setup.exe`，详见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-09 Windows 26.10.903 已发布

当前 Windows 改动已签名发布至官网与自动更新：生成卡片可选视频，即梦/方舟参数独立保存，结果沿现有连线交付；视频查询临时超时续查原任务，不重复提交生成。Rust 465 passed / 10 ignored、49 项前端逻辑及相关 UI、构建/资源/签名与完整公网下载核验通过。包在 `Windows/dist/Bowerbird_26.10.903_x64-setup.exe`；发布与回滚证据见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。Mac 保持 26.10.801，真实安装升级及付费生成未在本轮验收。

## 2026-10-09 Windows 26.10.902 正式版修正

用户已授权正式版隐藏技能/模板库入口、开放 Agent 图文输出与 Codex CLI。UI、端口、输入及运行时解除 DEV 限制；工作流后端保留 BYO 权益检查，旧聊天/编排保持开发限制。生产请求改存 `%APPDATA%/com.bowerbird.desktop/.agent-z/`，不再引用打包机源码路径。26.10.902 已构建、签名并替换官网和自动更新中的 26.10.901，保留旧包与回滚目录。安装包位于 `Windows/dist/Bowerbird_26.10.902_x64-setup.exe`，完整公网下载验签、67 个资源及原生等待 6 项检查通过；发布证据见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-09 重新核对 Mac 共享源码

补合 `origin/mac@d6027fb` 中先前遗漏的 Codex CLI Agent、循环起点/恢复、数据包交换、Codex 退出登录与入口开关，保留 Windows 封装/v3 布局。逐项源码与验证见 [Mac 增量审计](MAC-SYNC-AUDIT-2026-10-09.md)。本次补合阶段公共安装包为 26.10.901；随后用户明确授权，Mac 原有 DEV/debug 限制与正式请求目录问题已按上节范围修正，并随 Windows 26.10.902 发布。

## 2026-10-09 Windows 26.10.901 已发布

源码 dev@45d5652，包含 10 月 7 日同步的 Mac 增量与模板封装、预览和布局复用。完整 Rust 457 passed / 10 ignored、前端逻辑 153/153、模板 34 项、封装/更新 UI、隔离 CLI 和实际 NSIS 登录重置钩子通过；离线视频单测在临时 APPDATA 补齐正常启动生成的本版 launcher 后通过。安装包构建、旧公钥签名/篡改拒绝、x64/版本/资源/安装钩子及完整公网下载哈希核对通过，官网 Windows 更新清单、双首页和下载配置已切换。真实用户环境升级、登录重置与素材保留仍待专项验收；发布值、证据和回滚入口见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-07 同步 Mac 源码

`dev` 从 `f196d6c` 快进合入 `origin/mac@d537a66`。完整功能与平台边界见 [Mac → Windows 交接](../macOS/WINDOWS-SYNC-2026-10-07.md)，当前项目状态见 [PROJECT.md](../PROJECT.md)。本地既有模板封装改动已恢复并保持未提交；以下验证针对包含该增量的 Windows 工作区。共享源码版本为 26.9.2002，Windows 最近记录的已发布版本仍为 26.9.1803；本轮未打包、发布或部署云服务。

- 工作流循环、稳定输入管道、主输入追加/单格覆盖、内容交付恢复、本机 Agent 图文/表格、默认生图 provider、截图/贴图、会话组图、官方视频模型/积分与静态封面已同步。SQLite 0031–0033 沿原迁移链，不重复编号；循环等字段继续由 JSON 保存，无新增 SQL。
- Mac 原生标题栏、WKWebView、AVFoundation、debug 钥匙串辅助程序和签名 runner 保留平台条件；Windows 封面提取仍使用 FFmpeg，凭据隔离及 NSIS 安装清登录钩子保留。
- Windows 原生 examples 链接 Tauri 已生成的 Common Controls v6 资源，解决截图隔离夹具启动时报 `0xc0000139`。视频 UI 测试使用独立 Vite 配置，避免已有开发服务端口冲突。
- 验证通过：Rust 库 **457 passed / 10 ignored**、全部目标编译检查、前端逻辑 **153/153**、模板 **34 项**及 **21 组 Chromium 合成 IPC**（含封装）；canonical 与 `Windows/.work` TypeScript/Vite 构建、隐藏 WebView2 快捷键/贴图窗口、真实 FFmpeg 合成短视频入库及封面通过。视频 UI 首轮端口失败已修复并单独复跑通过；原生窗口关闭时有 WebView2 类注销 1412 日志，夹具断言通过且退出码为 0。
- 追加主程序 debug 构建在替换 `target/debug/bowerbird-desktop.exe` 时因现有开发实例占用失败；未终止用户应用，也不将这次构建记为通过。需要退出该实例后才能覆盖这个输出路径；源码同步与上述隔离验证已完成。
- 仍待验收：真实 F1/F3 屏幕与剪贴板操作、混合 DPI/多显示器、素材库升级副本及安装包、真实登录/付费任务恢复。当前隔离测试不操作用户库或模型，不等于这些项目已通过。证据在本机 `.tmp/mac-sync-20261007/`；同步前源码另有逐文件备份与保留的 stash。

原生及媒体复核命令（使用临时设置/测试库，不初始化生产应用）：

```powershell
cargo check --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
cargo run --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --example screenshot_smoke
cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib generated_video_ingest_probes_short_clip_and_real_poster -- --ignored
```

## 已适配

- 构建 Windows x64 桌面应用与 NSIS `.exe` 安装包。
- 兼容 npm 全局安装生成的 `codex.cmd`，并在 GUI 的 PATH 不完整时检查 `%APPDATA%\npm`。
- 应用内可一键直装官方独立版 codex（从 npm 镜像下载平台包 tarball 解压到应用数据目录，用户无需安装 Node.js；解析时托管副本优先）。
- Codex 登录、生成、检测和打开会话统一使用 `%APPDATA%\com.bowerbird.desktop\cli-profiles\codex`，不继承系统 `CODEX_HOME`、API Key 或共享登录。
- “在 codex 中打开会话”会启动 Windows 命令提示符并运行 `codex resume`。
- 浏览器采集服务的 `save_batch` 与 `save_blob + binary` 两条协议均位于 canonical Rust 源码；`apps/extension/` 与 `Windows/extension/` 分别使用对应协议。
- 用户数据继续由 Tauri 写入 Windows AppData，不写入安装目录。

## 环境要求

1. Windows 10 1803+ 或 Windows 11（需要 WebView2；Windows 11 通常已内置）。
2. Node.js 22 LTS+，并启用 pnpm：`corepack enable`。
3. Rust MSVC 工具链：`rustup default stable-x86_64-pc-windows-msvc`。
4. Visual Studio 2022 Build Tools，勾选“使用 C++ 的桌面开发”和 Windows 10/11 SDK。
5. AI 功能可在应用内一键安装 codex CLI（自动下载独立版，无需 Node.js）并登录 ChatGPT；不安装时素材库仍可用，AI 按项目约定降级置灰。
6. Windows 视频封面提取仍需 `ffmpeg`；MP4/MOV/M4V 的尺寸/时长优先用内置解析器，失败及其他格式回退 `ffprobe`。应用会检查随附工具、PATH、Windows 注册表 Path 及常见 WinGet/Scoop/Chocolatey 安装位置。特殊安装可用 `BOWERBIRD_FFMPEG_BINARY` / `BOWERBIRD_FFPROBE_BINARY` 指定绝对路径；缺少封面工具不阻止原生解析成功的 MP4 入库。图片功能不依赖它们。

## 开发运行

在项目根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\dev.ps1
```

## 构建安装包

后续 NSIS 安装包必须保留 `src-tauri/windows/installer-hooks.nsh`。2026-10-09 新约定：应用内 `/UPDATE` 保留 Bowerbird 账号、权益缓存及独立 CLI 登录；普通手动安装/同版本重装（含静默安装）仍重置。重置失败时安装报错并保留待重置标记；更新不删除此前失败标记，下次启动在恢复账号和启动后台任务前重试。系统 Codex/Dreamina 原登录保留。此调整已通过隔离 NSIS 夹具并随 26.10.904 签名包发布；应用内更新到本版即可生效。

Dreamina Windows 凭据保存在其进程的私有注册表空间 `HKCU\Software\Bowerbird\CliAuth\Dreamina`。启动器仅对自己创建的 CLI 子进程重映射 HKCU，使用 Job Object 管理生命周期；隔离失败即拒绝执行，不回退共享凭据。重装先结束应用私有运行目录中的 CLI 启动器，避免旧 OAuth 进程迟到写回登录。只重置登录及权益缓存，素材、项目、settings 与 CLI 历史文件保留。此注册表适配与安装钩子针对 Windows x64；不能把设置 HOME 等同于其他平台的原生凭据隔离。

验证命令（隔离脚本使用 PowerShell 7；仅使用临时目录、测试注册表分支及假凭据）：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib cli_credentials
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib installation
# HelperDirectory 为上述构建生成的 target/debug/build/bowerbird-desktop-*/out
./Windows/test-cli-isolation.ps1 -HelperDirectory <helper-output-directory>
./Windows/test-installer-auth.ps1
```

首次切换不复制系统 CLI 的凭据或原生会话目录；素材库中的生成历史保留，但旧共享 Codex 会话的终端续聊仍归原系统 CLI。之后由 Bowerbird 新建的独立 CLI 会话历史在重装时保留。

原生启动器由 `build.rs` 使用 MSVC 构建并嵌入桌面程序，无需改写 Dreamina 官方二进制。该机制隔离凭据命名空间，不是权限沙箱。参考：[Tauri NSIS hooks](https://v2.tauri.app/distribute/windows-installer/#extending-the-installer)、[Windows RegOverridePredefKey](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regoverridepredefkey)。

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\build.ps1 -Clean
```

脚本先执行 TypeScript 检查和 Rust 测试，再生成 `Windows/dist/Bowerbird_*_x64-setup.exe`。仅在已单独验证时可用 `-SkipTests` 跳过测试。

## 应用内更新

更新操作、签名密钥、版本清单、双端发布/回滚及验收边界已集中到 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。打包或发布前先读该文档；Windows 安装清登录与数据保留要求继续见本页「构建安装包」。

## 常见问题

- 提示 Rust host 不是 MSVC：运行 `rustup toolchain install stable-x86_64-pc-windows-msvc`，再运行 `rustup default stable-x86_64-pc-windows-msvc`。
- 链接器或 `windows.h` 缺失：通过 Visual Studio Installer 补装 C++ Build Tools 和 Windows SDK。
- codex 检测失败：在 Bowerbird 设置中检查或安装 CLI，并使用该设置页的登录入口；普通终端的 `codex login` 属于系统 CLI，不会登录 Bowerbird 的独立配置。
- 视频工具提示不可用：先看提示中的实际路径和启动错误；已安装不等于进程 PATH 能找到。预检与视频探测/海报使用同一解析器，不必重复安装或修改全局 PATH。更新应用后需重启实例才能使用新解析逻辑。
