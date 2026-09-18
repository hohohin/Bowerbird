# 桌面自动更新：发布、验收与双端协作

本页集中维护自动更新的技术约定、发布操作和部署证据；[PROJECT.md](../PROJECT.md) 只保留项目级摘要及入口。更新代码、构建签名包、发布清单、排查双端差异前先读本页。

## 当前基线

最近公网验收：**2026-09-18 13:56:45（北京时间）**。本次存档不重新打包或部署。

| 平台 | channel | 已发布版本 | 更新入口 / 清单 / 签名包 | 尚未完成 |
|---|---|---|---|---|
| Windows x64 | `windows-x86_64` | 26.9.18 | 307 / 200 / 完整下载与验签通过 | 真实旧版到新版的安装、重启、登录重置和素材保留验收 |
| Apple Silicon（M 系列）Mac | `darwin-aarch64` | 26.9.18 | 307 / 200 / 完整下载与验签通过 | 原生替换与重启验收；Developer ID 签名及 Apple 公证 |
| Intel Mac | `darwin-x86_64` | 未发布 | 307 / 404 / 无对应包 | 构建、签名、上传清单和安装包，再做实机验收 |

用户已确认本次只提供 M 系列 Mac 包。不能把 ARM64 包放进 Intel 清单，也不能把 Mac 更新签名当成 Apple 公证。当前 Mac DMG 仍为未签名、未公证测试包；官网首页的 macOS 公开下载入口未开放。

**26.9.18 检查 26.9.18 应显示“当前已是最新版本”**。后续升级必须提高应用实际版本；不得只修改清单版本来强迫同版本安装。没有更新入口的旧客户端，先手动安装一次带更新入口的版本。

## Windows 26.9.1802 本地交付（尚未上线）

2026-09-18 完成第二版 Windows x64 签名安装包，包含设计师引导 7.1 与文案调整。产物为 Windows/dist/Bowerbird_26.9.1802_x64-setup.exe（83177187 bytes，SHA-256 97d75f3007115cf71b8dc4a2a674e5e47531ebb55f7a43fff23ccebe25383c79），同目录提供 .sig、.sha256 与 windows-x86_64.json。签名复用现有 Windows 密钥；内置公钥验签、篡改拒绝、解包版本/x64、43 个引导资源和 528 个源码输入校验通过，证据在 .tmp/package-20260918-2/。

本地清单已生成，官网清单仍为 26.9.18，不能将本地打包记作线上发布。后续发布按下方流程上传不可变包并验证，再原子更新 Windows 清单；Mac 清单保持独立。本次未执行用户环境安装或原生升级。

## 给 Mac 同事：本次分歧的解决方法与统一口径

- “Mac 当时不能更新”属实，原因是包和版本清单尚未发布；“现役 `server.mjs` 没有更新路由”与服务器进程、回环请求及公网 GET 证据不符。12:47 的服务已含三个平台入口，Mac 分支 `add14dd` 的“端点未部署”记录已过时。
- 反馈地址中的大写 `/API/` 会 404，正式路径为小写 `/api/`；`jdarwin-x86_64` 如为实际请求内容，则多了一个 `j`。原来的 HEAD 请求也会 404；本次已修复 HEAD，使其与 GET 一样返回 307。未取得同事原始完整命令，不把某一种请求方式认定为唯一原因。
- 检查应分开记录“入口首跳”“跟随跳转后的清单”“清单中的包”。Mac 当时是首跳 307、清单 404；不能只看 `curl -L` 的最终 404 就断言缺路由。
- 已核验用户上传的 ARM64 包、公钥、签名和哈希，并发布官网清单。Mac 下载地址改为用户提供的 R2 文件，官网留镜像；Windows 包和清单不变。官网并发下载 Mac 包曾超过 300 秒，R2 最终完整下载约 183 秒；这是本次测量，不是速度保证。
- **交接共识：共享官网入口和协议，按平台保留各自更新公钥、架构及不可变包；以现役部署和公网结果确认上线，不以任一分支文档推断生产。** 每次交接写明版本、channel、包 URL、签名、SHA-256、部署目录及尚未验收项。后续 Mac 分支同步本页入口，删除或标注其旧“未部署”结论，不用旧 `server.mjs` 覆盖现役 HEAD 修复。
- 网络、哈希、验签通过只代表发布链路通过；双方都应补做原生升级验收。Mac 接续重点是 Intel 构建、Apple 签名/公证及旧版到新版替换重启，不再重复补已上线的路由。

## 客户端行为与代码入口

设置 → 关于我们 → 当前版本：检查更新 → 下载更新 → 安装并重启。使用 Tauri 官方 updater，内置公钥校验更新包。只有下载及验签都成功才允许安装；重复操作互斥，关闭设置保留进度。失败可重试，不把检查失败显示为“最新版本”。检查超时 30 秒、下载超时 300 秒。

安装前等待已知生成、Agent 和素材整理任务结束，并等待画板保存。Windows 使用 passive NSIS，安装器启动后应用退出，由安装器重新启动；其他桌面平台安装返回后调用 relaunch，失败时提示手动重启。

Windows 保留原安装清登录钩子：重置 Bowerbird 账号、权益缓存及独立 CLI 登录，素材、项目、settings 和独立 CLI 历史保留，不操作系统 CLI 登录。Mac 清单的发布说明称保留登录，但本轮未实测，不将此文案视作凭据保留验收。

| 入口 | 用途 |
|---|---|
| [appUpdater.ts](../apps/desktop/src/lib/appUpdater.ts) | 更新状态、超时、下载/安装/重启 |
| [AppUpdateCard.tsx](../apps/desktop/src/components/AppUpdateCard.tsx) | 设置 UI、任务与保存保护 |
| [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) | 共享版本、入口模板、Windows 更新公钥、签名产物开关 |
| `apps/desktop/src-tauri/tauri.macos.conf.json`（Mac 分支） | Mac 独立更新公钥覆盖；本次核验来源 `origin/mac:add14dd` |
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

- Windows 当前包：[Bowerbird_26.9.18_x64-setup.exe](https://bowerbird.cn/downloads/Bowerbird_26.9.18_x64-setup.exe)。官网手动下载链接与更新清单分别配置，修改首页按钮不等于更新清单已发布。
- Mac 当前更新包：[R2 ARM64 .app.tar.gz](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/Bowerbird_26.9.18_aarch64.app.tar.gz)。这是线上清单的实际下载地址，必须持续保留；R2 的 `mac_package/` 目录首页不提供可靠文件列表，核验具体文件 URL。
- Mac 官网镜像：[ARM64 .app.tar.gz](https://bowerbird.cn/downloads/Bowerbird_26.9.18_aarch64.app.tar.gz)，同目录保留 `.sig` 和 `.sha256`。
- Mac 手动初装测试包：[ARM64 DMG](https://bowerbird.cn/downloads/Bowerbird_26.9.18_aarch64-updater-installer.dmg)。DMG 不作为 updater 安装包。

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

## 本次发布与回滚证据

现役 `/opt/bowerbird/website` 指向 `/opt/bowerbird/website-releases/20260918-mac-updater-published`；服务为 `bowerbird-website.service`，监听 `127.0.0.1:4173`，候选验证端口为 4174。现役 `server.mjs` SHA-256：`d2a31c19f07993640a12238430c896f5008d03d6db7135ee253d4d1732882003`。

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

本次回滚目标为 `20260918-mac-update-channels`。回滚整个官网会同时撤回 HEAD 修复和新发布的 Mac 清单/镜像，不可将其误报为 Mac 仍可用；Windows 原有发布继续保留。若只需回退 Mac 的下载 URL，可从备份恢复清单，无需回退整个服务。

本地证据：`.tmp/mac-updater-publish/` 下的 `deploy.sh`、`rollback.sh`、`deploy.log`、`prepared.json`、`public-report.json`、`package-inspection.json`、`result.json` 和 `report.md`。服务器交接副本在 `/tmp/bowerbird-mac-updater-publish/`，包括最终报告、脚本、`SHA256SUMS` 和 `darwin-aarch64-before-r2.json`。这些临时目录不入 Git、可能被清理，本页保留可复查的关键值；清理前需另存发布证据。

之前的 Windows 发布证据在 `.tmp/app-updater-release/`，Mac 路由部署证据在 `.tmp/mac-website-20260918/`，分歧请求矩阵在 `.tmp/updater-dual-audit/`。首次 Windows 候选因 Node 18 不支持 `--env-file` 在切换前停止，后改兼容环境加载器；后续部署沿用该加载方式，避免照抄新 Node 参数。

## 复测命令与验收边界

下列 curl 命令使用 `curl`；Windows PowerShell 可改为 `curl.exe`，避免旧版别名差异。

```sh
# 首跳：应为 307；不要用最终 404 推断首跳结果
curl -sS -D - https://bowerbird.cn/api/desktop-update/darwin-aarch64
# HEAD 已修复，应同为 307
curl -sSI https://bowerbird.cn/api/desktop-update/darwin-aarch64
# 跟随跳转：应得到 version=26.9.18、Mac channel 及 R2 包 URL
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
