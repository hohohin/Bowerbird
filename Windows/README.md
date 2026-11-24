# Bowerbird Windows 开发与打包

Windows x64 的本地安装、运行、构建和排障见下文。版本、通道、签名与发布证据见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)，当前状态见 [PROJECT.md](../PROJECT.md#目前进展)。

## 已适配

- 构建 Windows x64 桌面应用与 NSIS `.exe` 安装包。
- 兼容 npm 全局安装生成的 `codex.cmd`，并在 GUI 的 PATH 不完整时检查 `%APPDATA%\npm`。
- 应用内可一键直装官方独立版 codex（从 npm 镜像下载平台包 tarball 解压到应用数据目录，用户无需安装 Node.js；解析时托管副本优先）。
- Codex 登录、生成、检测和打开会话统一使用 `%APPDATA%\com.bowerbird.desktop\cli-profiles\codex`，不继承系统 `CODEX_HOME`、API Key 或共享登录。
- “在 codex 中打开会话”会启动 Windows 命令提示符并运行 `codex resume`。
- 浏览器扩展统一使用 `save_blob + binary`：浏览器取图后上传字节，桌面按当前项目／收集箱规则入库。`apps/extension/` 为主源码，`Windows/extension/` 保持同版供独立加载；Rust 保留旧 `save`／`save_batch` 兼容。配置与更新入口位于探索页的「浏览器插件」，更新后需在浏览器重新加载扩展并刷新采集网页。
- 用户数据继续由 Tauri 写入 Windows AppData，不写入安装目录。

## 环境要求

1. Windows 10 1803+ 或 Windows 11（需要 WebView2；Windows 11 通常已内置）。
2. Node.js 22 LTS+，并启用 pnpm：`corepack enable`。
3. Rust MSVC 工具链：`rustup default stable-x86_64-pc-windows-msvc`。
4. Visual Studio 2022 Build Tools，勾选“使用 C++ 的桌面开发”和 Windows 10/11 SDK。

   构建正式安装包还需把 7-Zip 的 `7z.exe` 加入 PATH。`build.ps1` 调用 `verify-installer.ps1` 从最终 NSIS 包读取主程序，核对安装包与主程序的产品版本及主程序的 x64 架构，再生成签名清单。
5. AI 功能可在应用内一键安装 codex CLI（自动下载独立版，无需 Node.js）并登录 ChatGPT；不安装时素材库仍可用，AI 按项目约定降级置灰。
6. Windows 视频封面在 2026-10-23 后续源码中优先通过独立 Media Foundation 子进程提取，常见 H.264 MP4 不再要求安装 `ffmpeg`；Windows 26.10.2301 已包含此修复，2203 及更早版本需更新。系统缺少解码器或原生提取失败时回退已有 `ffmpeg`。尺寸/时长依次尝试 MP4/MOV/M4V 内置解析、独立 Media Foundation 读取、已有可选 `ffprobe`；不随包附带或自动下载工具。分片 MP4 依据样本时序取时长，普通旋转视频按显示方向取宽高；特殊编码仍可能需要 ffprobe，裁剪/分析转码仍需要 FFmpeg。工具发现检查随附目录、PATH、Windows 注册表 Path 及常见 WinGet/Scoop/Chocolatey 安装位置，特殊安装可用 `BOWERBIRD_FFMPEG_BINARY` / `BOWERBIRD_FFPROBE_BINARY` 指定绝对路径。图片功能不依赖它们。

## 开发运行

在项目根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\dev.ps1
```

开发／Vite 预览服务跟随启动父进程退出，并清理文件监听与端口；不要用退出即结束的临时 PowerShell 启动长期预览。正常源码热更新保留，`.tmp` 生成目录不参与监听。独立确认稿关闭文件监听，改稿后需重启对应服务。修复及验证见 [预览服务生命周期](../project_logs/2026-11-01-preview-lifecycle.md)。

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

脚本先执行 TypeScript 检查和 Rust 测试，再生成 `Windows/dist/Bowerbird_*_x64-setup.exe`。清单生成器核对 updater 签名及紧邻安装包的 `<安装包>.verification.json`，要求测试通过、SHA-256、版本、平台和文件名均匹配。请从可信构建或独立 QA 批次取得记录，保存原始测试输出。需要独立记录时可在原参数后传入测试记录路径，省略发版说明时第四个参数传空字符串。

`-SkipTests` 的输出在 `Windows/dist/untested/<SHA-256>/`，含安装包、签名和跳测记录。晋级须提供同一冻结输入和安装包的等效 TypeScript、Rust 通过记录，再用清单生成器验签、校验实包哈希。审核样本的 [42 项忽略用例处置](RELEASE-IGNORED-2026-11-11.md) 单独记录。发布者 Authenticode 结果和 updater 验签分别登记。

## 应用内更新

更新操作、签名密钥、版本清单、双端发布/回滚及验收边界已集中到 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。打包或发布前先读该文档；Windows 安装清登录与数据保留要求继续见本页「构建安装包」。

## 常见问题

- 提示 Rust host 不是 MSVC：运行 `rustup toolchain install stable-x86_64-pc-windows-msvc`，再运行 `rustup default stable-x86_64-pc-windows-msvc`。
- 链接器或 `windows.h` 缺失：通过 Visual Studio Installer 补装 C++ Build Tools 和 Windows SDK。
- codex 检测失败：在 Bowerbird 设置中检查或安装 CLI，并使用该设置页的登录入口；普通终端的 `codex login` 属于系统 CLI，不会登录 Bowerbird 的独立配置。
- 视频工具提示不可用：先看提示中的实际路径和启动错误；已安装不等于进程 PATH 能找到。预检与视频探测/海报使用同一解析器，不必重复安装或修改全局 PATH。更新应用后需重启实例才能使用新解析逻辑。
