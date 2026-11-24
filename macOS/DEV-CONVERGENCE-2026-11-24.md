# 2026 年 11 月 24 日 macOS 收口至 dev 验证

## PR 候选复验（dev 26.11.2403）

- PR 以 `origin/dev@af955e57` 为基线，普通合并接收首轮候选 `d3cd1b87`，保留 `mac@13fdfdb2` 历史。共用版本为 `26.11.2403`，SQLite 迁移连续到 `0062`。Mac updater 配置、原生桥接、标题栏 capability 与 Cargo runner 已逐文件对照归档分支。
- 合并保留 dev 新增的分支快照控制台和 stdio 热切换。stdio 与 Gemini 继续复用同一只读工具协议。Windows OAuth 回环夹具由当前 dev 创建授权，切换候选进程后保留原配置、访问令牌和刷新令牌，并成功调用四个工具。
- 固定版 pnpm 的冻结安装、lint、Vite 生产构建及 Cloud 路由契约通过。画板逻辑套件 140 通过、10 失败。对 dev 对照副本仅补齐 Node 直跑所需的 `.ts` 导入后，复现同名 10 项画板夹具失败。音频菜单、素材交付与画板边界的 Chrome 夹具通过。
- Node 24.22.3 下的 MCP 测试 44 通过、0 失败、1 项 Windows 文件共享测试跳过，两项 Chrome 回归均通过。
- Apple Silicon 使用 Rust 1.97.1（`aarch64-apple-darwin`），开发签名、隔离钥匙串、`cargo check --locked` 通过。Rust 全量 **1427 通过、0 失败、57 忽略**。启用本机 FFmpeg／FFprobe 后另跑 3 项原生音频裁剪，全部通过，覆盖 VBR MP3／Vorbis 时间轴、WAV 编码位深保留和跨格式登记。
- 隔离 `pnpm tauri dev` 通过合成图片导入、WKWebView 原生预览、画板创建移动删除及 DSH 未登录保护。隔离库 `user_version=62`、`integrity_check=ok`。定向发送的合成系统登录回调到达 WKWebView。Intel 依用户指示跳过。
- 2026-11-24，负责人确认 Mac 专用账号真实登录、线上 DSH · Cloud v2 对话、恢复及历史原单查询均已核对通过，并批准将 [PR #4](https://github.com/hohohin/Bowerbird/pull/4) 合入 `dev`。
- `mac` 作为历史归档保留，后续开发统一使用 `dev`。此次范围为源码和本地验证。专用 Gemini 公网端点及正式桌面发版按各自的部署流程处理。

复验日志位于本机 `/private/tmp/bowerbird-mac-convergence-pr-verification/`。

## 首轮候选源码范围（dev 26.11.2402）

- 本机 `mac@13fdfdb2` 的跟踪文件干净，未跟踪项均在临时目录。已执行 `git fetch origin`，远端 `dev@0d044e83017f42d1c6464434ca01939d39c49815` 已是本机 mac 的祖先。隔离工作树使用普通合并提交 `071e299c` 保留两个父提交。Mac 的独占改动及历史见 [累计存档](CROSS-PLATFORM-SYNC-2026-11-24.md)。
- 保留 dev 的共用版本 `26.11.2402`。Mac 26.11.2403 是已经冻结的独立 ARM 测试包。Mac updater 配置、`macos-titlebar.json` 和 Cargo runner 与 mac 逐字相同。Objective-C 浏览器遮罩、截图焦点、HEIC 色彩桥、Mac 签名及打包脚本均纳入候选。
- SQLite `0001` 至 `0062` 的 62 个文件与 Rust 迁移登记一一匹配。Tauri 命令沿正常前端 API 验证，Rust 画板回归覆盖工作流卡保存、输入和投递字段。通过 `git check-ignore` 核对 `macOS/.signing/updater.key`、`apps/cloud/.env.local` 及 MCP 的 `.local/`。

## 首轮 ARM 构建与烟测

| 验证 | 回执 |
|---|---|
| 环境 | Apple Silicon、macOS 27.2.1，Rust 1.97.1（`aarch64-apple-darwin`），pnpm 11.10.0。桌面前端使用 Node 22.22.1，MCP 使用 Node 24.22.3。 |
| 静态检查和构建 | `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm build` 和 `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` 全部退出 0。生产构建自带 Cloud 路由契约测试。 |
| Rust 全量 | `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` 为 **1427 通过、0 失败、55 忽略**。按现有约定指定本机 FFmpeg／FFprobe，覆盖 DSH Cloud v2 字段、原请求恢复、停止、结算边界，以及 macOS 回调和 HEIC。 |
| 签名和钥匙串 | `bash macOS/test-dev-signing.sh`、`bash macOS/test-dev-keychain.sh` 通过。覆盖开发 App 身份、稳定凭据 helper、假凭据跨重编译读写与撤销。 |
| `pnpm tauri dev` | 一次性工作树通过正常 Tauri 开发入口启动 ARM Mac WKWebView，使用临时 Bundle ID、应用数据、假凭据服务名和 SQLite 库。通过真实前端 API 导入 24×18 合成 PNG、用 asset 协议解码预览、按正式画板 JSON 创建、移动及移除同一素材卡。SQLite `user_version=62`、`integrity_check=ok`。测试加载脚本及数据隔离修改仅在一次性工作树。 |
| 登录回流与 DSH Cloud v2 | 向隔离 App 定向发送系统 `bowerbird://auth/callback` 合成错误 URL，真实 WKWebView 收到 Rust 转发的登录失败事件。未登录的 DSH Cloud 报价命令提示先登录，本地原请求查询返回空。Rust 回环用例验证认证网关、v2 消息、按原请求恢复与断线后的幂等处理。真实专用账号登录成功、线上 v2 对话及原单回收待现场验收。 |

## 首轮独立 Gemini 隧道验证

- Node 全量测试 **36/36**。Mac 与 Windows 分别启用精确签发方及独立授权，覆盖配置拒绝、旧默认、专用 SSH 参数、5 秒重连、重启及撤销。旧 `dev@0d044e83` 启动夹具创建的 Windows OAuth 状态，在新进程中原配置原字节读取，原访问令牌成功调用四个工具，原刷新令牌正常续期。该检查使用 Mac 上真实回环 HTTP 与模拟 SSH。
- Mac 刷新入口用真实导出器、受限 HTTP 和模拟 SSH 运行两次。第二次沿用同一 launcher PID 和访问／刷新令牌，`project_overview` 返回新的导出时间，`read_file` 读到临时未提交标记。SSH 参数为 `127.0.0.1:48734:127.0.0.1:48731` 和 `bowerbird-mcp-mac@106.55.44.143`。
- Mac 专用公钥部署包已生成并校验 SHA-256，安装和回滚脚本通过 Bash 语法检查。OpenSSH `sshd -T` 展开 Mac Match 后确认仅远程 TCP、`PermitListen=127.0.0.1:48734`、`PermitOpen=none`、`MaxSessions=0`，本地 TCP、TTY、Agent、X11 和 StreamLocal 转发均关闭。配置、私钥、`known_hosts` 均为 `0600`。
- 公网只读基线显示现役 `mcp.bowerbird.cn` 的匿名 MCP 返回 401、OAuth 发现返回 200。首轮验证时 Mac 子域未解析，随后用户已添加 A 记录 `106.55.44.143`。Mac 站点的证书、公网 OAuth 及 Gemini 账号授权待批准部署后验收。操作和回滚见 [MCP 接入说明](../apps/code-reader-mcp/README.md#apple-siliconintel-mac-独立-gemini-隧道)。

候选验证回执保存在本机 `/private/tmp/bowerbird-dev-mac-verification/`。提交的 Git 记录包含验证范围和命令，部署用公钥包与本机授权材料由原有 `.local/` 隔离。
