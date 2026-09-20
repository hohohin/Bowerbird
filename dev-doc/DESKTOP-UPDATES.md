# 桌面自动更新：发布、验收与双端协作

本页集中维护自动更新的技术约定、发布操作和部署证据；[PROJECT.md](../PROJECT.md) 只保留项目级摘要及入口。更新代码、构建签名包、发布清单、排查双端差异前先读本页。

## 当前基线

最近公网验收：**2026-09-19 23:08:25（北京时间）**。Windows 为 26.9.1803；M 系列 Mac 已更新至 26.9.1901。

| 平台 | channel | 已发布版本 | 更新入口 / 清单 / 签名包 | 尚未完成 |
|---|---|---|---|---|
| Windows x64 | `windows-x86_64` | 26.9.1803 | 307 / 200 / 完整下载与验签通过 | 真实旧版到新版的安装、重启、登录重置和素材保留验收 |
| Apple Silicon（M 系列）Mac | `darwin-aarch64` | 26.9.1901 | 307 / 200 / 完整下载与验签通过 | 原生替换与重启验收；Developer ID 签名及 Apple 公证 |
| Intel Mac | `darwin-x86_64` | 未发布 | 307 / 404 / 无对应包 | 构建、签名、上传清单和安装包，再做实机验收 |

用户已确认本次只提供 M 系列 Mac 包。不能把 ARM64 包放进 Intel 清单，也不能把 Mac 更新签名当成 Apple 公证。2026-09-18 16:55 官网首页已按用户要求开放 M 系列 Mac 26.9.1802 DMG 下载；Windows 下载同步显示 26.9.1802。后续按用户要求移除首页下载区及 FAQ 的签名、公证及测试版提示，包的技术验收状态仍按本页记录。

**Windows 26.9.18 / 26.9.1802 可通过设置发现 26.9.1803；Mac 旧版可通过设置发现 26.9.1901。** 已上线的旧客户端需先手动检查或下载安装含启动检测的新包；仅更改服务器清单不会给旧客户端增加启动行为。同版本检查显示“当前已是最新版本”，后续更新须提高实际包版本。

## Mac 26.9.1901 发布记录

2026-09-19 23:08:25（北京时间）完成公网验收。用户已将新包、签名和清单上传至 R2；本次将官网 Mac 清单及两份首页的 DMG 链接/版本同步为 26.9.1901。发布说明包含启动检查更新、账号升级直达权益/兑换、仅开放设计师路线，以及本地分类人工示例匹配与重新扫描改进。本轮验证发布产物及链路，未在 Mac 原生执行这些功能。

| 产物 | 大小（bytes） | SHA-256 |
|---|---:|---|
| Bowerbird_26.9.1901_aarch64.app.tar.gz | 85,893,526 | af077004a66804fe9f16c79ecf35828b3acdfd5b00df48c64090b29b5c3ec06f |
| Bowerbird_26.9.1901_aarch64-updater-installer.dmg | 86,439,465 | f1d59df9ed63c6c9ff7a7eb15fb922a037e960103e863cf178247cc3af2035bf |

两个文件继续由 R2 mac_package/ 托管；本次未新增官网大文件镜像，旧镜像仍保留。已核对完整下载与上传方 SHA-256、清单签名与 .sig 一致、旧 Mac 公钥验签和篡改拒绝；包内 Info.plist 为 26.9.1901、可执行文件为 ARM64，嵌入原 Mac 公钥及官网更新入口，未混入 Windows 公钥。官网服务器独立完整下载更新包的哈希一致。本机首次更新包下载在 300 秒达到超时，收到 65,238,528 bytes 后续传完成；当前客户端下载超时仍为 300 秒，慢网络下载失败重试的风险仍在，不能据验签通过声称所有网络均可一次更新成功。

现役目录：/opt/bowerbird/website-releases/20260919-mac-26.9.1901；回滚目录：/opt/bowerbird/website-releases/20260918-26.9.1803。从现役站点复制候选，仅替换 Mac 清单和两个 HTML 的三处 Mac 版本引用，候选验收后原子切换。server.mjs、环境配置和 Windows 清单逐字节保持；Windows 清单 SHA-256 为 f090fa3f7dbf9908c13cad6c58bcfb44e7671a539772f27337898798919ba2fd。未部署工作区其他官网、桌面、Worker 或数据库修改。回滚会将 Mac 检查与首页恢复至 26.9.1802，不影响 Windows 26.9.1803，亦不会降级已升级客户端。

候选、正式服务及公网 GET/HEAD、307/no-store、Mac 200 清单、首页链接/静态资源、健康、Windows 清单不变和旧包保留验证通过。Intel 清单仍为 404。本轮 git fetch origin mac 仍停留 13c7280，该分支旧文档不能作为新版构建证据；版本、公钥和签名以实际产物核验为准，Mac 同事仍需补齐 26.9.1901 源码提交/构建记录，以及旧版替换、重启、启动提示和数据保留实机验收。Apple 签名/公证本轮未复验，不把 updater 验签当成公证。

本地证据：.tmp/release-mac-26.9.1901/ 的 artifact-report.json、package-inspection.json、public-report.json、清单、签名、包、部署/回滚与验证脚本；服务器交接目录：/tmp/bowerbird-release-mac-26.9.1901/，包含候选与正式验证报告。首次候选检查将健康端点正常的 204 误期望为 200，修正为接受 HTTP 成功状态后通过；失败发生在生产切换前。

## Windows 26.9.1803 发布记录

2026-09-18 23:57:06（北京时间）完成公网验收。包含启动时静默检查/可跳过新版提醒、仅开放设计师路线、应用内账号管理与兑换入口及官网链接修正。旧客户端先通过设置检查并升级一次，之后每次启动自动检查；发现更新仍由用户决定下载、安装和重启。

安装包 Bowerbird_26.9.1803_x64-setup.exe：83175110 bytes，SHA-256 f5477cdefaa4d224f8c734ea46af2c7fe7cfb3f81eddae8f27f8d83135670f46。包、.sig、.sha256 在官网 downloads；Windows 清单和双首页下载同步为 26.9.1803。沿用原 Windows 更新公钥，完整公网下载哈希、公钥验签/篡改拒绝、529 个构建输入、43 个引导资源和安装清登录钩子核对通过；未执行真实旧版到新版安装。Mac 的清单字节与 26.9.1802 基线一致，SHA-256 22c88a3808f2b420a5963c00cf53c0b2e575aaadff9db9d9073b4a037672ba05，须另在 Mac 上构建签名新版本。

当前现役目录为 /opt/bowerbird/website-releases/20260918-26.9.1803，回滚目录为 /opt/bowerbird/website-releases/20260918-26.9.1802-download-copy。server.mjs SHA-256 3e88d4d1827db435462cf74d388fab40d2cfddea2fd0bca2b25d7b13e74e6940。生产环境仅调整 BOWERBIRD_WINDOWS_DOWNLOAD_URL，其余配置保留；候选验证后原子切换，旧包继续保留。整体回滚会恢复 Windows 26.9.1802 的清单和首页，Mac 不受影响。

本地证据：.tmp/release-20260918-1803/ 下 result.json、public-report.json、build.log、deploy.log、verify.mjs、deploy.sh、rollback.sh；服务器脚本、哈希及候选/正式报告在 /tmp/bowerbird-release-20260918-1803/。本轮没有更新 Worker 或数据库，原生升级、Mac 公证与 Intel 验收边界保持。

## Windows 26.9.1802 构建与交付

2026-09-18 完成第二版 Windows x64 签名安装包，包含设计师引导 7.1 与文案调整。产物为 Windows/dist/Bowerbird_26.9.1802_x64-setup.exe（83177187 bytes，SHA-256 97d75f3007115cf71b8dc4a2a674e5e47531ebb55f7a43fff23ccebe25383c79），同目录提供 .sig、.sha256 与 windows-x86_64.json。签名复用现有 Windows 密钥；内置公钥验签、篡改拒绝、解包版本/x64、43 个引导资源和 528 个源码输入校验通过，证据在 .tmp/package-20260918-2/。

该包当日已按下方历史发布记录上线，当时双端官网清单均为 26.9.1802。构建与发布是独立步骤；本次仍未执行用户环境安装或原生升级。

## 给 Mac 同事：26.9.18 首次上线分歧的解决方法与统一口径

- “Mac 当时不能更新”属实，原因是包和版本清单尚未发布；“现役 `server.mjs` 没有更新路由”与服务器进程、回环请求及公网 GET 证据不符。12:47 的服务已含三个平台入口，Mac 分支 `add14dd` 的“端点未部署”记录已过时。
- 反馈地址中的大写 `/API/` 会 404，正式路径为小写 `/api/`；`jdarwin-x86_64` 如为实际请求内容，则多了一个 `j`。原来的 HEAD 请求也会 404；本次已修复 HEAD，使其与 GET 一样返回 307。未取得同事原始完整命令，不把某一种请求方式认定为唯一原因。
- 检查应分开记录“入口首跳”“跟随跳转后的清单”“清单中的包”。Mac 当时是首跳 307、清单 404；不能只看 `curl -L` 的最终 404 就断言缺路由。
- 已核验用户上传的 ARM64 包、公钥、签名和哈希，并发布官网清单。Mac 下载地址改为用户提供的 R2 文件，官网留镜像；Windows 包和清单不变。官网并发下载 Mac 包曾超过 300 秒，R2 最终完整下载约 183 秒；这是本次测量，不是速度保证。
- **交接共识：共享官网入口和协议，按平台保留各自更新公钥、架构及不可变包；以现役部署和公网结果确认上线，不以任一分支文档推断生产。** 每次交接写明版本、channel、包 URL、签名、SHA-256、部署目录及尚未验收项。后续 Mac 分支同步本页入口，删除或标注其旧“未部署”结论，不用旧 `server.mjs` 覆盖现役 HEAD 修复。
- 网络、哈希、验签通过只代表发布链路通过；双方都应补做原生升级验收。Mac 接续重点是 Intel 构建、Apple 签名/公证及旧版到新版替换重启，不再重复补已上线的路由。

## 客户端行为与代码入口

**启动检测（Windows 26.9.1803 已发布；Mac 26.9.1901 发布说明包含此功能，原生验收待补）：** 应用初始化完成后，每次启动在后台检查一次。只有发现更高版本才弹出“发现新版本”，提供“立即更新”和“暂不更新”；前者开始下载，下载与验签完成后由用户确认“安装并重启”。跳过、关闭或 Esc 只影响本次运行，下次启动重新检查；已是最新版或自动检查失败时不弹窗，手动检查失败仍显示原因。不定时轮询、不自动下载或强制安装。

检查与提醒状态只保存在本次会话，避免 React StrictMode、组件重挂载触发重复请求。若设置、素材库迁移、引导等对话框已打开，先静默检查并等待它们关闭后提醒。提醒内复用 `AppUpdateCard` 的进度、验签、任务与保存保护；关闭提醒后可在设置继续处理。

**Mac 交接及上线边界：** 此功能属于 Windows/Mac 共享前端；两端同步 `App.tsx`、`StartupUpdateDialog.tsx`、`AppUpdateCard.tsx`、`appUpdater.ts` 后，分别提高实际版本、重新构建签名包并发布清单。已上线的旧 26.9.1802 仍只能手动检查，需先通过设置或官网升级一次到含此功能的新包。仅部署官网或更新清单不会改变旧客户端启动行为，不能覆盖已发布的 26.9.1802 包。针对性合成 IPC UI 回归与 TypeScript/Vite 构建通过；已覆盖启动有更新/无更新/离线、初始化/其他弹窗等待、StrictMode 去重、跳过/关闭后本次不再提醒及下次重查、主动下载、验签失败重试和安装前任务/保存保护；尚未执行双端新包实机验收。

设置 → 关于我们 → 当前版本：检查更新 → 下载更新 → 安装并重启。使用 Tauri 官方 updater，内置公钥校验更新包。只有下载及验签都成功才允许安装；重复操作互斥，关闭设置保留进度。失败可重试，不把检查失败显示为“最新版本”。检查超时 30 秒、下载超时 300 秒。

安装前等待已知生成、Agent 和素材整理任务结束，并等待画板保存。Windows 使用 passive NSIS，安装器启动后应用退出，由安装器重新启动；其他桌面平台安装返回后调用 relaunch，失败时提示手动重启。

Windows 保留原安装清登录钩子：重置 Bowerbird 账号、权益缓存及独立 CLI 登录，素材、项目、settings 和独立 CLI 历史保留，不操作系统 CLI 登录。Mac 清单的发布说明称保留登录，但本轮未实测，不将此文案视作凭据保留验收。

| 入口 | 用途 |
|---|---|
| [appUpdater.ts](../apps/desktop/src/lib/appUpdater.ts) | 更新状态、超时、下载/安装/重启 |
| [AppUpdateCard.tsx](../apps/desktop/src/components/AppUpdateCard.tsx) | 设置 UI、任务与保存保护 |
| [StartupUpdateDialog.tsx](../apps/desktop/src/components/StartupUpdateDialog.tsx)、[App.tsx](../apps/desktop/src/App.tsx) | 启动静默检查、新版提醒、等待其他对话框关闭与本次跳过 |
| [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) | 共享版本、入口模板、Windows 更新公钥、签名产物开关 |
| `apps/desktop/src-tauri/tauri.macos.conf.json`（Mac 分支） | Mac 独立更新公钥覆盖；26.9.1802 核验来源 `origin/mac:13c7280`，公钥与已发布旧版一致 |
| [server.mjs](../website/server.mjs) | 三平台 GET/HEAD 跳转、清单 no-store |
| [Windows/build.ps1](../Windows/build.ps1)、[Windows/update-manifest.mjs](../Windows/update-manifest.mjs) | Windows 构建、签名与清单生成 |
| `macOS/update-manifest.mjs`（Mac 分支） | `.app.tar.gz` 的架构与版本清单生成 |

Mac 专属文件当前不在 dev 工作树；应从 Mac 分支接续，不能因 dev 缺少文件而重建或替换 Mac 密钥。

## 入口、存储与清单协议

客户端模板：`https://bowerbird.cn/api/desktop-update/{{target}}-{{arch}}`。

| channel | 默认清单 | 可选 HTTPS 环境覆盖 |
|---|---|---|
| `windows-x86_64` | `/downloads/updates/windows-x86_64.json` | `BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL` |
| `darwin-aarch64` | `/downloads/updates/darwin-aarch64.json` | `BOWERBIRD_DARWIN_AARCH64_UPDATE_MANIFEST_URL` |
| `darwin-x86_64` | `/downloads/updates/darwin-x86_64.json` | `BOWERBIRD_DARWIN_X86_64_UPDATE_MANIFEST_URL` |

上述相对路径均在 `https://bowerbird.cn`。入口 GET/HEAD 返回 307 和 `Cache-Control: no-store`，清单同样禁止缓存。未支持的 channel 返回 204；已配置通道缺清单仍是错误，不伪装为“最新版本”。路径大小写敏感。

清单包含 `version`、`notes`、`pub_date`、`platforms[channel].url` 和 `platforms[channel].signature`。`signature` 是 `.sig` 文件的文本内容，不是签名文件 URL。包必须是带版本及架构的不可变 HTTPS 文件，不能覆盖已发布的同名包。

- Windows 当前包：[Bowerbird_26.9.1803_x64-setup.exe](https://bowerbird.cn/downloads/Bowerbird_26.9.1803_x64-setup.exe)。官网手动下载和更新清单已同步，后续仍须分别发布及核验。
- Mac 当前更新包：[R2 ARM64 .app.tar.gz](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/Bowerbird_26.9.1901_aarch64.app.tar.gz)。这是线上清单的实际下载地址，必须持续保留；R2 的 `mac_package/` 目录首页不提供可靠文件列表，核验具体文件 URL。
- Mac 旧版官网镜像（26.9.1802）：[ARM64 .app.tar.gz](https://bowerbird.cn/downloads/Bowerbird_26.9.1802_aarch64.app.tar.gz)，同目录提供 `.sig`；各版本 SHA-256 见发布记录。
- Mac 当前首页手动安装包：[26.9.1901 ARM64 DMG](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/Bowerbird_26.9.1901_aarch64-updater-installer.dmg)，本轮未复验 Apple 签名与公证；DMG 不作为 updater 安装包。
- Mac 旧版手动初装测试包（26.9.18，之后可应用内升级）：[ARM64 DMG](https://bowerbird.cn/downloads/Bowerbird_26.9.18_aarch64-updater-installer.dmg)。DMG 不作为 updater 安装包。

## 密钥与发布流程

2026-09-18 用户确认同日第二版使用 `26.9.1802`，表示“9 月 18 日第 2 版”。Cargo/Tauri 使用三段版本号，不使用 `26.9.18.2`；后续同月版本须保持数值递增，例如次日首版为 `26.9.1901`，不能退回 `26.9.19`。平台独立清单按各自实际构建版本发布。

Windows 私钥在被 Git 忽略的 `Windows/.signing/updater.key`；同目录 `updater.key.dpapi` 是当前 Windows 账号加密的本地备份，不替代异地备份。Mac 私钥由 Mac 构建机维护，记录位置为 `macOS/.signing/updater.key`，与 Windows 独立。已发布客户端固定信任对应公钥，后续发版复用同一私钥；密钥轮换必须另做兼容迁移，不能临时重新生成。

构建使用 `TAURI_SIGNING_PRIVATE_KEY`（路径或内容）及可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。Windows 脚本优先读环境变量，否则读取本机私钥；直接执行 Tauri 构建也须提供私钥。私钥不提交 Git、不上传下载目录、不打进安装包。

1. 同步提升 `apps/desktop/src-tauri/Cargo.toml` 和 `tauri.conf.json` 的版本，确保高于该通道已发布版本。需要时同步锁文件中的包版本。同一天再次发布也需提高 patch，不覆盖旧包。
2. Windows 执行 `Windows/build.ps1`，可传 `-ReleaseNotesFile`，产出 `.exe`、`.exe.sig`、`windows-x86_64.json`。默认包地址在官网 downloads。
3. Mac 在对应架构构建 `.app.tar.gz` 及 `.sig`，另生成手动安装 DMG；确认包内架构、公钥和版本。Apple 签名/公证与 updater 签名是两条独立要求。
4. 先上传包、签名和哈希文件，验证目标 URL 的完整下载、大小、SHA-256、公钥验签及篡改拒绝。签名针对包字节，更换托管 URL 不重签同一包，但须再次验证下载内容。
5. 用清单生成器指定实际 HTTPS 下载 URL，随后原子发布清单。Windows 调用参数为 `<installer> <https-url> <manifest-output> [notes-file]`；Mac 为 `<app.tar.gz> <aarch64|x86_64> <https-url> <manifest-output> [notes-file]`。工具只检查清单与签名格式，不能替代完整包验签。
6. 变更路由时先验证候选服务，再原子切换官网目录；仅变更清单时先备份，在同目录写临时文件后重命名替换。保留旧包、旧清单和回滚目录。
7. 公网分别验收入口、清单和包，最后在隔离机器执行真实旧版到新版升级，核对重启、数据及平台登录行为，再记录验收范围。

## 26.9.1802 双端发布记录

2026-09-18 16:41:42（北京时间）完成公网验收。Windows 来源 dev `138beb3`，Mac 构建与交接记录见 origin/mac `13c7280`（包版本提交 `cc45eef`）；两端均包含设计师引导文案与第 7.1 步。

| 平台 | 包大小 | SHA-256 | 下载位置 |
|---|---:|---|---|
| Windows x64 | 83,177,187 | `97d75f3007115cf71b8dc4a2a674e5e47531ebb55f7a43fff23ccebe25383c79` | 官网 downloads，首页按钮同步更新 |
| M 系列 Mac | 85,891,597 | `70696d89fbdc9a2794038ebb68c739c4eb142e62f89253830b45ab6846d40be5` | R2 mac_package 直下；官网 downloads 保留同字节镜像 |

本次双端更新发布目录：`/opt/bowerbird/website-releases/20260918-26.9.1802`（随后首页下载补齐的现役目录见下节）。更新通道回滚目录：`/opt/bowerbird/website-releases/20260918-mac-updater-published`，其中两端清单均为 26.9.18。旧包保留；回滚发布入口不会自动降级已经升级的客户端。本次双端发布时服务代码未改，环境配置只更新 `BOWERBIRD_WINDOWS_DOWNLOAD_URL`。

本次核验时 R2 共用 `darwin-aarch64.json` 仍指向 26.9.18，发布侧用 26.9.1802 的实际签名重新生成官网清单；客户端仍以官网清单为检查来源。先上传并核对两端包，再验证候选服务并原子切换目录，同时发布两个通道，未将仅改文件名或清单视为完成升版。

验证通过：两端公网 GET/HEAD、no-store 清单、完整下载哈希及客户端公钥验签/篡改拒绝；旧新公钥一致；Mac 包内 ARM64、26.9.1802、官网入口和 Mac 公钥；Windows 包内版本/x64 沿用构建交付证据；候选/正式服务、首页下载配置、官网/后台健康及旧包保留。Intel 未发布、Mac 公证和双端实际安装重启仍待验收。

证据在本地 `.tmp/release-26.9.1802/`，包括 `deploy.sh`、`rollback.sh`、`SHA256SUMS`、`deploy.log`、`package-inspection.json`、`public-report.json` 及公网清单；服务器交接目录为 `/tmp/bowerbird-release-26.9.1802/`。Windows 构建证据继续见 `.tmp/package-20260918-2/`。临时证据不入 Git，关键发布值以本节为准。

## 26.9.1802 官网首页下载补齐

2026-09-18 16:55（北京时间）按用户要求上线。核验时两端更新清单和 Windows 动态下载地址已为 26.9.1802，但首页 Windows 静态备用链接仍为 26.8.7，Mac 按钮禁用并写着“即将推出”。本次修正两份首页及服务端 Windows 默认地址，展示双端版本，开放 M 系列 DMG 直下，同步平台说明；Mac 明确标注未签名、未公证测试版，Intel 暂未提供。

Mac DMG 来源为 `origin/mac:13c7280` 所记构建产物，R2 完整下载 **86,425,875 bytes**，SHA-256 `3ba05d84f3d523ee526b831b149e79e22ebeaf4777bbbbffa784fd0d4d2b70d3` 与构建记录一致。未重新构建或覆盖包，更新清单、签名包及服务环境配置保持原样。

首页下载补齐时的发布目录：`/opt/bowerbird/website-releases/20260918-26.9.1802-downloads`。本次首页变更回滚目录：`/opt/bowerbird/website-releases/20260918-26.9.1802`，回退后应用内更新仍为 26.9.1802，但首页 Mac 下载入口会撤回。候选验证通过后原子切换官网符号链接并重启 `bowerbird-website.service`；失败自动回滚。

同日按用户反馈移除两份首页下载区和 FAQ 中的“未签名、未公证测试版”文案，保留版本、M 系列说明及下载地址。该次文案发布目录为 `/opt/bowerbird/website-releases/20260918-26.9.1802-download-copy`，本次文案回滚目录为 `/opt/bowerbird/website-releases/20260918-26.9.1802-downloads`。候选、正式服务及公网双首页检查通过；包、清单及环境配置未变。证据位于 `.tmp/website-download-copy/` 与服务器 `/tmp/bowerbird-website-download-copy/`。

验证：官网更新接口回归、候选与正式服务的双首页链接/版本、两端清单及完整包哈希、旧包保留、首页/后台/健康检查通过；公网双首页链接与两份手动安装包 HEAD 200/大小通过，Mac DMG 完整公网哈希通过。未做原生安装或 Apple 公证。部署脚本、验证脚本及日志在本地 `.tmp/website-download-1802/`，服务器副本在 `/tmp/bowerbird-website-download-1802/`。

## 26.9.18 历史发布与回滚证据


26.9.18 发布时，`/opt/bowerbird/website` 指向 `/opt/bowerbird/website-releases/20260918-mac-updater-published`；当前现役目录以本文最新发布记录为准。服务为 `bowerbird-website.service`，监听 `127.0.0.1:4173`，候选验证端口为 4174。两次发布的 `server.mjs` 内容相同，SHA-256 为 `d2a31c19f07993640a12238430c896f5008d03d6db7135ee253d4d1732882003`。

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `Bowerbird_26.9.18_x64-setup.exe` | 83,178,026 | `f7da5237d1d8d75cab5363769c9c3f76795fe0f725525e0046a74abd9ee5a781` |
| `Bowerbird_26.9.18_aarch64.app.tar.gz` | 85,891,464 | `e7d51d75be739a3ff121a51694350b2b807056c33439b1e2bf23a7da9f7c3d91` |
| `Bowerbird_26.9.18_aarch64-updater-installer.dmg` | 86,425,997 | `1504d411b2f3fe48a85c3e74057bf6696f57d64d04773a2166b0b84b13f35f3d` |

最终 `darwin-aarch64.json` SHA-256：`445da23c66621d67ad03c516ea06febeb4f6f08ebc56308434fbb1c14daf8063`。Mac 清单初次指向官网镜像，最终原子改为 R2；环境配置、Windows 包和清单保持不变。公网最终完整下载 Windows 约 190 秒、Mac R2 约 183 秒，均小于本次客户端 300 秒超时；性能随网络变化。

部署顺序及历史目录：

| 阶段 | 发布目录（均位于 `/opt/bowerbird/website-releases/`） | 当时状态 |
|---|---|---|
| Windows 首发 | `20260918-app-updater-v2` | Windows 包、清单上线；当时回滚到 `20260914-code-admin` |
| 合入 Mac 路由 | `20260918-mac-update-channels` | 来源 `origin/mac:8534144`；两个 Mac 清单当时仍缺失 |
| 本次最终发布 | `20260918-mac-updater-published` | Windows 与 ARM64 清单/包可用，HEAD 修复，Intel 仍待发布 |

26.9.18 发布当时的回滚目标为 `20260918-mac-update-channels`。回退到该历史目录会同时撤回 HEAD 修复和 Mac 清单/镜像，不可将其误报为 Mac 仍可用；Windows 原有发布继续保留。当前版本应使用最新发布记录指定的回滚目标；若只需回退 Mac 的下载 URL，可从对应备份恢复清单，无需回退整个服务。

本地证据：`.tmp/mac-updater-publish/` 下的 `deploy.sh`、`rollback.sh`、`deploy.log`、`prepared.json`、`public-report.json`、`package-inspection.json`、`result.json` 和 `report.md`。服务器交接副本在 `/tmp/bowerbird-mac-updater-publish/`，包括最终报告、脚本、`SHA256SUMS` 和 `darwin-aarch64-before-r2.json`。这些临时目录不入 Git、可能被清理，本页保留可复查的关键值；清理前需另存发布证据。

之前的 Windows 发布证据在 `.tmp/app-updater-release/`，Mac 路由部署证据在 `.tmp/mac-website-20260918/`，分歧请求矩阵在 `.tmp/updater-dual-audit/`。首次 Windows 候选因 Node 18 不支持 `--env-file` 在切换前停止，后改兼容环境加载器；后续部署沿用该加载方式，避免照抄新 Node 参数。

## 复测命令与验收边界

下列 curl 命令使用 `curl`；Windows PowerShell 可改为 `curl.exe`，避免旧版别名差异。

```sh
# 首跳：应为 307；不要用最终 404 推断首跳结果
curl -sS -D - https://bowerbird.cn/api/desktop-update/darwin-aarch64
# HEAD 已修复，应同为 307
curl -sSI https://bowerbird.cn/api/desktop-update/darwin-aarch64
# 跟随跳转：应得到 version=26.9.1802、Mac channel 及 R2 包 URL
curl -fsSL https://bowerbird.cn/api/desktop-update/darwin-aarch64
# Windows 清单应为 200；Intel 在未发布前仍为 404
curl -fsSL https://bowerbird.cn/api/desktop-update/windows-x86_64
```

本地回归：

```sh
node --check website/server.mjs
node website/scripts/app-updater.test.mjs
pnpm --filter @bowerbird/desktop test:app-updater
```

已验收：候选/正式服务及公网 GET/HEAD、禁止缓存清单、完整包哈希、双端公钥验签/篡改拒绝、ARM64 包内版本和公钥、官网/后台/健康接口及旧 Windows 下载；UI 合成 IPC 覆盖离线/最新/新版本、进度、关闭重开、重复操作、签名失败、重试、任务/保存保护及安装/重启失败。

未验收：两端原生旧版到新版的实际安装替换与重启；Windows 本次真实升级的登录重置/素材保留；Mac 本次真实升级的登录保留、Developer ID 签名/公证和干净机器验收；Intel 全流程。不要把构建成功、HEAD 200、UI 合成 IPC 或 minisign 验签扩写为完整实机验收。
