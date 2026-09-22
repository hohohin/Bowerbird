# Bowerbird macOS 开发版

本目录记录 Mac 上的本地开发、运行和未签名构建流程。Bowerbird 使用 canonical Tauri / React / Rust 源码，不维护 macOS override。构建架构以 `rustc -vV` 的 host 为准；Intel 为 `x86_64-apple-darwin`，Apple Silicon 原生工具链为 `aarch64-apple-darwin`。

## 2026-09-21 Mac 26.9.2002 已发布

发布侧核验 R2 上现成 26.9.2002 更新包及 DMG 后，已同步官网 Mac 清单与两份首页入口。完整下载哈希、旧公钥签名/篡改拒绝、ARM64/包内版本及公网链路通过；Windows 保持 26.9.1803。2002 接替下述 2001 历史构建，不再按旧交接发布 2001。产物、回滚及验收边界见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)「Mac 26.9.2002 发布记录」。原生更新/重启及 Apple 公证仍待验收。

## 2026-09-20 Mac 26.9.2001 更新包（历史构建，已由 2002 接替）

收录 9 月 19/20 存档工作：本地分类向量精确匹配判官（jina-clip-v2 int8，可选安装、未装回退 VLM）与可选云端最终校验 Jev、画板新卡锚定当前可视区左上角、视频卡独立样式与 ▶ 徽标、文本卡表格增强（标题编辑/整表复制 CSV/行高列宽拖拽）、创作模式空白框选、mac「打开所在文件夹」Finder 选中与对话框方向键乱码修复。版本按同日序号规范定为 **26.9.2001**（20 日第 1 包，> 线上 26.9.1901，护栏通过；1901 清单已由发布侧替换上线，2026-09-20 确认）。构建前验证：Rust 全量 **379 passed / 6 ignored**、画板纯逻辑 **127/127**、creation-editor/creation-marquee/notes/media/reference/local-classification 六组 UI 回归与 `tsc --noEmit` 通过（`canvas-arrangement-ui`、`canvas-selection-to-board-ui` 的既有等待失败维持不处理）。

本机缺失 `macOS/.signing/r2.env`（R2 凭据），本轮 `R2_SKIP_UPLOAD=1 bash macOS/release.sh macOS/dist/release-notes-26.9.2001.txt` 仅本地产出（产物在 `macOS/dist/`，不入 Git）：

- 更新器安装包：`Bowerbird_26.9.2001_aarch64.app.tar.gz`，**86,344,811 bytes**，SHA-256 `de431a5fdc9da85cda13df2901df3ab54b1e075c2b793bb5fe077179d19931e0`；同名 `.sig`/`.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.2001_aarch64-updater-installer.dmg`，**86,881,253 bytes**，SHA-256 `852fe0edd1d2304c4761a583bf3f75f43f2f049c1b537acf6e0f139f7220cfa5`；未签名/未公证。
- 更新清单：`darwin-aarch64.json`（version 26.9.2001，SHA-256 `ed68d36aecf2f6c5ae3d2c18c670a4e71ff238af2e06ebd9f9f80ef8b27de46a`，URL 指向 R2 直下 `mac_package/Bowerbird_26.9.2001_aarch64.app.tar.gz`）。

本机核验：`CFBundleShortVersionString` = 26.9.2001、arm64 二进制内嵌 Mac 公钥与 `tauri.macos.conf.json` 及已发布 26.9.1802/1901 逐字节一致（key id `0b5a2efc4865664f`）、DMG `hdiutil verify` 通过、minisign 主签名与全局签名通过（`minisign-verify` 0.2.5 同构造）、篡改字节被拒、清单 signature 与 `.sig` 逐字节一致。

**发布进度（2026-09-20）**：待恢复 `macOS/.signing/r2.env` 后在仓库根执行 `/tmp/bowerbird-release-26.9.2001/upload-r2.sh`（上传 6 个文件 + 公网完整下载哈希 + minisign 复核），再在服务器 106.55.44.143 执行 `/tmp/bowerbird-release-26.9.2001/swap-manifest.sh`（备份 26.9.1901 清单 → 哈希断言 `ed68d36a…` → rename 原子替换 → 公网复核）。回滚：把备份文件 rename 回原名。交接值与协议见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)「Mac 26.9.2001 发布侧核验」。本轮未运行真实应用内更新。

## 2026-09-19 Mac 26.9.1901 更新包（已发布）

合并远端 dev `3f089bf`（Windows 26.9.1803 源码：启动静默检查更新与可跳过提醒 `StartupUpdateDialog`、仅开放设计师路线、账号升级直达权益/兑换面板、官网快照对齐）并纳入 mac 侧本地分类误标根治后出包。版本按同日 patch 序号规范定为 **26.9.1901**（9 月 19 日第 1 包；因前日已用 26.9.1802/1803 四位序号，19 日首个包需用 1901 才能高于线上 darwin-aarch64 26.9.1802，护栏通过）。合并后验证：Rust 全量 **371 passed / 5 ignored**、TypeScript `tsc --noEmit`、app-updater/引导/本地分类三组 UI 回归通过（随包 Vite production build 在 tauri build 内完成）。

用 `R2_SKIP_UPLOAD=1 bash macOS/release.sh macOS/dist/release-notes-26.9.1901.txt` 完成签名构建与归档（本轮仅本地产出，未上传 R2）：arm64 二进制内嵌 Mac 公钥、`CFBundleShortVersionString` = 26.9.1901、DMG `hdiutil verify` 通过。产物在 `macOS/dist/`（不入 Git）：

- 更新器安装包：`Bowerbird_26.9.1901_aarch64.app.tar.gz`，**85,893,526 bytes**，SHA-256 `af077004a66804fe9f16c79ecf35828b3acdfd5b00df48c64090b29b5c3ec06f`；同名 `.sig`/`.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.1901_aarch64-updater-installer.dmg`，**86,439,465 bytes**，SHA-256 `f1d59df9ed63c6c9ff7a7eb15fb922a037e960103e863cf178247cc3af2035bf`；未签名/未公证。
- 更新清单：`darwin-aarch64.json`（version 26.9.1901，notes 为本地分类防误标与启动检查更新说明，URL 指向 R2 直下 `mac_package/Bowerbird_26.9.1901_aarch64.app.tar.gz`）。

**已发布（2026-09-19/20 交接确认）：** 上述 26.9.1901 产物已经发布侧执行清单原子替换上线，2026-09-20 公网复核线上 darwin-aarch64 清单为 26.9.1901；26.9.1802 客户端经设置手动检查升级，启动静默检查自本版本起在 Mac 生效。后续 26.9.2001 见上节。

## 2026-09-18 Mac 26.9.1802 引导更新包（已发布）

合并 dev `56699d3`（官网更新修复 + 设计师引导文案与 7.1 步骤）后，按 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md) 流程构建同日第二包：版本采用同日 patch 序号规范 **26.9.1802**（tauri.conf.json + Cargo.toml，> 已发布 26.9.18，updater 识别为升级），签名 release 构建通过；合并后引导契约 **14/14**、三身份引导 UI 与 v0917 包界面回归通过。arm64 二进制内嵌 Mac 公钥，`CFBundleShortVersionString` = 26.9.1802，DMG `hdiutil verify` 通过。产物在 `macOS/dist/`（不入 Git）：

- 更新器安装包：`Bowerbird_26.9.1802_aarch64.app.tar.gz`，**85,891,597 bytes**，SHA-256 `70696d89fbdc9a2794038ebb68c739c4eb142e62f89253830b45ab6846d40be5`；同名 `.sig`/`.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.1802_aarch64-updater-installer.dmg`，**86,425,875 bytes**，SHA-256 `3ba05d84f3d523ee526b831b149e79e22ebeaf4777bbbbffa784fd0d4d2b70d3`；未签名/未公证。
- 更新清单：`darwin-aarch64.json`（version 26.9.1802，notes 为设计师引导更新说明，URL 暂指官网镜像 `https://bowerbird.cn/downloads/Bowerbird_26.9.1802_aarch64.app.tar.gz`；若沿用 R2 直下，发布前用实际 URL 重新生成清单）。

**已发布（同日）：** 上述 26.9.1802 产物已经双端发布流程核验上线，`darwin-aarch64` 清单现指向 R2 直下包；发布证据与验收边界以 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md) 为准。（曾短暂构建过 26.9.19 版本号，不符合同日序号规范，产物未发布已删除。）

## 一键发布流程（打包后自动上传 R2，2026-09-18 建立）

`macOS/release.sh` 把发布串成一条命令（协议见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)）：

```bash
bash macOS/release.sh <release-notes.txt>          # 完整：护栏→签名构建→归档校验→R2清单→上传→公网核对
R2_SKIP_BUILD=1 R2_SKIP_UPLOAD=1 bash macOS/release.sh   # 本地演练：复用产物、不上传、无需凭据
```

流程内容：读取 `tauri.conf.json` 版本并按本机 rustc 架构选 `aarch64`/`x86_64`；**版本护栏**（必须高于该通道线上清单版本，同日重发布用日期+序号如 `26.9.1802`）；带私钥签名构建 `app,dmg`；核对包内版本/架构、DMG 完整性，归档 `macOS/dist/` 并生成 SHA-256；生成**指向 R2 直下地址**的 `darwin-<arch>.json` 清单；用 rclone 上传 `mac_package/`（更新包、`.sig`、`.sha256`、DMG、DMG 校验、清单）；最后公网 HEAD 核对 Content-Length。结束打印交接摘要（版本、URL、SHA-256、清单路径）。

一次性准备：

1. `brew install rclone`（上传工具，环境变量内联配置，不留配置文件）。
2. `cp macOS/r2.env.example macOS/.signing/r2.env` 并填入 R2 的 Account ID / Access Key / Secret / 桶名（创建方式见模板注释；`.signing/` 不入 Git）。
3. 更新器私钥沿用 `macOS/.signing/updater.key`。

上传 ≠ 发布：官网 `downloads/updates/darwin-<arch>.json` 仍由发布侧**核验完整下载、SHA-256、公钥验签后原子替换**；上传后本机公网核对只验证了可达与大小。上传前请确认版本号已按规范提升（脚本护栏会拦同版本/降版本）。

## Mac 应用内更新（darwin 通道，2026-09-18 配置）

Mac 与 Windows 共用 Tauri 官方 updater 及同一入口 `https://bowerbird.cn/api/desktop-update/{{target}}-{{arch}}`；官网端点现接受 `darwin-aarch64` 与 `darwin-x86_64`，307 跳转到 `https://bowerbird.cn/downloads/updates/darwin-<arch>.json`（可用 `BOWERBIRD_DARWIN_AARCH64_UPDATE_MANIFEST_URL` / `BOWERBIRD_DARWIN_X86_64_UPDATE_MANIFEST_URL` 覆盖），其他平台仍返回 204。

Mac 使用**独立签名密钥**，与 Windows 通道互不影响：私钥在本机被 Git 忽略的 `macOS/.signing/updater.key`（当前为空口令，首个 Mac 更新版本发布前可换为带口令密钥并同步更新 pubkey——一旦有带更新入口的 Mac 版本发布，密钥不可再换），公钥覆盖在 `apps/desktop/src-tauri/tauri.macos.conf.json` 的 `plugins.updater.pubkey`。共享 `tauri.conf.json` 已开启 `createUpdaterArtifacts`，因此**每次 mac 构建都必须提供私钥**，否则打包在签名一步失败：

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat macOS/.signing/updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm tauri build --bundles app,dmg
```

（密钥文件是空口令的 minisign 加密容器；不显式给 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` 时 CLI 会尝试交互式询问口令，无终端的打包脚本直接失败。）

构建产出 `apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app.tar.gz` 与同名 `.sig`（updater 安装包及 minisign 签名）。发布流程沿用 Windows 约定：

1. 版本高于已发布版本；按本机 `rustc -vV` 架构选 `aarch64` 或 `x86_64`。
2. 上传前把 `Bowerbird.app.tar.gz` 重命名为 `Bowerbird_<版本>_<架构>.app.tar.gz`，连同 `.sig` 上传官网 downloads；核对下载内容与本地哈希一致。
3. 生成本平台清单（signature 填 `.sig` 文件内容，不是地址）：

   ```bash
   node macOS/update-manifest.mjs \
     apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app.tar.gz \
     <aarch64|x86_64> \
     https://bowerbird.cn/downloads/Bowerbird_<版本>_<架构>.app.tar.gz \
     darwin-<架构>.json [release-notes.txt]
   ```

4. 原子替换官网 `downloads/updates/darwin-<架构>.json`；官网 server 部署含新端点的 `website/server.mjs` 后通道生效。
5. 更新器在 Mac 上的行为：下载 `.app.tar.gz`、内置公钥验签通过后替换正在运行的 `.app` 并重启（`appUpdater.ts` 的 install 后 relaunch 路径）；素材、项目与 Keychain 登录状态保留，没有 Windows 的清登录钩子。

边界：updater 签名只保证更新包完整性，与 Developer ID 签名/公证无关；当前 DMG 仍为未签名本地测试包，公开分发前仍需完成签名公证。老版本 Mac 安装包没有更新入口，需先手动安装一次带更新入口的版本。官网服务端改动需另行部署后通道才实际可用；本轮只完成本机配置与验证，未上传任何产物。

## 2026-09-18 首个 Mac 更新包（26.9.18 aarch64，本机构建待上传）

按上节流程完成首个 darwin 更新包：签名 release 构建（`--bundles app,dmg`）通过，二进制为 arm64、内嵌 Mac 公钥（Windows 公钥为 0）。标准 Tauri DMG 阶段本机首次直接通过，`hdiutil verify` 校验有效，挂载检查含 `Applications -> /Applications` 快捷方式、`.background` 背景与图标布局。产物在 `macOS/dist/`（不入 Git）：

- 更新器安装包：`Bowerbird_26.9.18_aarch64.app.tar.gz`，**85,891,464 bytes**，SHA-256 `e7d51d75be739a3ff121a51694350b2b807056c33439b1e2bf23a7da9f7c3d91`；同名 `.sig` 与 `.sha256` 附带。
- 手动安装 DMG：`Bowerbird_26.9.18_aarch64-updater-installer.dmg`，**86,425,997 bytes**，SHA-256 `1504d411b2f3fe48a85c3e74057bf6696f57d64d04773a2166b0b84b13f35f3d`；未签名/未公证，仅本地测试。
- 更新清单：`darwin-aarch64.json`（version 26.9.18，signature 为 `.sig` 内容，URL 指向 `https://bowerbird.cn/downloads/Bowerbird_26.9.18_aarch64.app.tar.gz`）。

**后续（同日）：** 上述产物经用户 R2 中转由 Windows 侧核验后已正式发布：`darwin-aarch64` 清单上线（实际下载走 R2，官网留镜像），入口/清单/包与双端公钥验签通过，官网现役目录 `20260918-mac-updater-published`。本节「尚未上传/未部署」的表述自此作废；发布证据、复测命令与验收边界统一见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)。仍未完成：x86_64（Intel）通道、Developer ID 签名/公证、旧版 → 新版实机替换重启验收。

## 2026-09-18 同步 dev 26.9.18

`mac` 合入远端 dev `a7d5dae`（26.9.18 更新器发布与桌面改进归档）。新增内容：Windows 应用内更新与官网更新通道源码（`AppUpdateCard`、`appUpdater`、`tauri.conf.json` updater 公钥/端点、`tauri-plugin-updater/process`、官网 `desktop-update` 接口与 `update-manifest.mjs`，版本升至 26.9.18）、本地分类 NVIDIA CUDA GPU 加速与重复标签逐项重判、下载错误带系统代理提示，以及文档索引整理（CLAUDE.md 收敛为指向 AGENTS.md 的入口）。

冲突融合：本地分类 runtime 在 mac 跨平台 RuntimePack（macOS 13.3+ Intel / Apple Silicon、`sw_vers` 版本门控、`/usr/bin/tar` 解压、可执行位校验）之上并入 dev 的 CUDA 路径——`extract_runtime` 统一为「归档名 + 目标目录 + server 路径 + 取消」签名，`Server::start` 先试 GPU 再回退 CPU 并回报实际后端；mac 上 `nvidia_available`/`gpu_installed` 自然为 false，保持 CPU 推理。分类面板同时显示 GPU 加速状态与 macOS 支持范围文案。保留 WKWebView 原生取图、系统标题栏、Finder 路径探测、微信 `RunEvent::Opened` 回流、`tauri.macos.conf.json` 与 DMG 固定交付规范。

修一个本机既有缺口：`explorer_smoke` example 通过 `#[path]` 直接编译 `source_browser_network.rs` 且不引用库 crate，cargo 不向 example 传递 build.rs 的 `-l static=bowerbird_browser_capture`，原生 arm64 全量 `cargo test` 因此链接失败（此前记录来自 Intel 环境产物）。在 macOS extern 块补 `#[link(name = "bowerbird_browser_capture", kind = "static")]`，任何编译该模块的目标都自带链接指令；example 及全套测试恢复链接。

本机（Apple Silicon、rustc 1.97.1）验证：Rust 全量 **368 passed / 0 failed / 5 ignored**（无过滤，首次在此机器跑通含 examples 的全套）；画板/生成契约 **125/125**、引导 **14/14**；`local-classification-ui`、`app-updater-ui`、`composer-disabled-tooltip-ui`、`onboarding-pack-ui`、`onboarding-ui` 五组 Chrome 合成 IPC 回归、TypeScript `tsc --noEmit` 与 Vite production build 全部通过，保留既有 Rust 警告与大 chunk 提示。文档同批更新：PROJECT.md 新增同步里程碑并按「只保留 3 条」将旧条目移入进展归档，LOCAL-CLASSIFICATION/ONBOARDING 融合双平台记录。

本轮仅本地合并与测试：未打包 DMG、未运行真实模型下载/GPU 推理（Mac 无 CUDA 路径）、未操作真实账号或素材库、未推送分支或部署服务。Mac 更新通道在同日另行配置（见上节）；官网服务端与清单未部署前，Mac 检查更新仍表现为无更新或失败，不代表自动更新已可用。

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
