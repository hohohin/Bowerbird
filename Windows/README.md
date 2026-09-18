# Bowerbird Windows 版

这里存放 Bowerbird 的 Windows 开发、构建与独立扩展加载工具。平台兼容行为已经并入项目主源码；脚本只把 canonical 项目复制到 `Windows/.work/`，不再用整文件 override 替换源码。`Windows/overrides/` 仅保留退役说明，不参与构建。

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
6. 视频预览另需 `ffmpeg` 与 `ffprobe`；应用会检查随附工具、PATH、Windows 注册表 Path 及常见 WinGet/Scoop/Chocolatey 安装位置。特殊安装可用 `BOWERBIRD_FFMPEG_BINARY` / `BOWERBIRD_FFPROBE_BINARY` 指定绝对路径。图片功能不依赖它们。

## 开发运行

在项目根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\dev.ps1
```

## 构建安装包

后续 NSIS 安装包必须保留 `src-tauri/windows/installer-hooks.nsh`：每次安装（包括同版本重装、升级及静默安装）都清除 Bowerbird 账号 refresh token、权益缓存及独立 CLI 登录。重置失败时安装报错并保留待重置标记；下次启动在恢复账号和启动后台任务前重试。首次升级到独立凭据版本需要在 Bowerbird 设置中重新登录，系统 Codex/Dreamina 原登录保留。

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

设置 → 关于我们 → 当前版本提供「检查更新 → 下载更新 → 安装并重启」。采用 Tauri 官方 updater，HTTPS 获取版本清单，内置公钥验证安装包签名；校验失败不启用安装。关闭设置保留当前下载状态，安装前阻止已知运行中的生成/Agent/素材整理，并等待画板写入队列。Windows 使用 passive NSIS 安装并自动重新启动，保留原有清登录钩子和用户素材/项目。现有无更新入口的版本需先手动安装一次 26.9.18 或更高版本。

发布公钥固定在 `apps/desktop/src-tauri/tauri.conf.json`。本机私钥在被 Git 忽略的 `Windows/.signing/updater.key`，请在发布前安全备份；不可提交、复制到官网或打入安装包，也不能为每次发布重新生成。其他构建机器通过 `TAURI_SIGNING_PRIVATE_KEY`（路径或内容）和可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 使用同一私钥。直接 `pnpm tauri build` 也必须设置该环境变量。`Windows/build.ps1` 优先使用环境变量，否则读取本机私钥；缺少签名会使打包失败。

每次发布：

1. 同步提升 `Cargo.toml` 与 `tauri.conf.json` 版本。必须高于已发布版本；同一天再次发布可增加 patch 数字，不覆盖已发布安装包。
2. 执行 `Windows/build.ps1`，可传 `-ReleaseNotesFile <UTF-8文本>`，产出 `.exe`、`.exe.sig` 和 `windows-x86_64.json`。清单 URL 默认 `https://bowerbird.cn/downloads/Bowerbird_<version>_x64-setup.exe`。
3. 先上传安装包及签名至现有官网 downloads，并验证下载内容与本地哈希及签名一致；随后原子替换 `downloads/updates/windows-x86_64.json`。版本清单中 signature 是 `.sig` 文件内容，不能填文件地址。最后更新官网手动下载链接。
4. 官网 `/api/desktop-update/windows-x86_64` 以禁止缓存的 307 跳转到清单，可用 `BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL` 指定 HTTPS 清单地址。没有上传清单或网络失败会报检查失败，不冒充「最新版本」。目前只发布 Windows x64，其他平台返回 204；Mac 必须另外构建签名 `.app.tar.gz` 并接入对应平台入口。

本地回归：`pnpm --filter @bowerbird/desktop test:app-updater`、`node website/scripts/app-updater.test.mjs`。合成 IPC 回归不会启动真实安装程序；正式发布前仍需在隔离 Windows 环境演练旧版 → 新版安装、重启、登录重置和素材保留。

## 常见问题

- 提示 Rust host 不是 MSVC：运行 `rustup toolchain install stable-x86_64-pc-windows-msvc`，再运行 `rustup default stable-x86_64-pc-windows-msvc`。
- 链接器或 `windows.h` 缺失：通过 Visual Studio Installer 补装 C++ Build Tools 和 Windows SDK。
- codex 检测失败：在 Bowerbird 设置中检查或安装 CLI，并使用该设置页的登录入口；普通终端的 `codex login` 属于系统 CLI，不会登录 Bowerbird 的独立配置。
- 视频工具提示不可用：先看提示中的实际路径和启动错误；已安装不等于进程 PATH 能找到。预检与视频探测/海报使用同一解析器，不必重复安装或修改全局 PATH。更新应用后需重启实例才能使用新解析逻辑。
