# Bowerbird macOS 开发与打包

Apple Silicon 与 Intel 按各自架构开发运行和构建 DMG。公开通道、版本和回滚见 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)，签名公证及真机回执见 [发布验收](RELEASE-READINESS.md)。

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

**微信/邮箱登录回流（2026-10-07 修复，需重启开发进程）：** Cargo runner 现在将已签名程序、同字节的稳定凭据辅助程序和资源放入 `target/debug/Bowerbird Dev.app`，注册包内 `bowerbird://` 协议后，直接 `exec` 包内程序；保留 Cargo 的进程管理、启动参数、账号/素材库标识。此前运行裸 `target/debug/bowerbird-desktop`，浏览器把回调交给 `/Applications/Bowerbird.app`；安装版可能在 single-instance 检查时退出，尚未收到 macOS 随后投递的 URL，开发版因而一直未登录且没有错误。已有 `RunEvent::Opened` 处理本身不够，运行进程还必须有可识别的应用包身份。

更新后先在原开发终端停止并重新运行上述命令，再从应用重新发起扫码；旧页面绑定的是重启前的登录请求，不能复用。无需重装正式版或部署网页/云服务。辅助程序首次改从包内路径访问旧钥匙串条目时，系统可能要求一次授权；其字节与 CDHash 仍跨普通业务重编译保持一致。测试 `bash macOS/test-dev-signing.sh` 使用临时程序并禁用协议注册（`BOWERBIRD_DEV_REGISTER_URLS=0` 仅用于隔离测试），覆盖两次重编译、Tauri 同款内嵌 plist 与包身份、资源、参数、签名和 helper 稳定性；`bash macOS/test-dev-keychain.sh` 禁止交互、仅使用随机假凭据条目。真实浏览器回流及扫码入账状态仍需用户重启后验收。

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

本地未签名 DMG 仅用于开发验证。若从其他机器下载或传输后触发 Gatekeeper，可在 Finder 中按住 Control 点击/右键应用并选择“打开”完成本地测试。

正式渠道的 Developer ID 签名、公证、staple 和干净机器验收见下文。

## 回传验证结果

若构建或运行失败，请记录并回传：

- macOS 版本与芯片；
- `node --version`、`pnpm --version`、`rustc -vV`；
- 失败命令和完整 stderr；
- 是从 `pnpm tauri dev` 运行，还是 Finder 双击 `.app`；
- Codex / Dreamina / ffmpeg 是否安装及 `which` 输出。

## 钥匙串反复授权

应用通过 Cargo 配置的 `run-signed.sh` 签名启动，debug 登录使用独立的稳定 `bowerbird-dev-keychain` helper。首次迁移既有条目时可能需选择一次「始终允许」。辅助程序更新、签名身份或钥匙串策略变化后可能需要重新授权。用 `bash macOS/test-dev-keychain.sh` 和 `bash macOS/test-dev-signing.sh` 执行隔离验证。开发调试请通过 `pnpm tauri dev` 或 `cargo run`，直接运行 Cargo 产物会绕过 runner。

## 正式渠道签名与公证

双架构待办及每批验收回执见 [macOS 全量发布验收](RELEASE-READINESS.md)。

`macOS/release.sh` 默认用于正式渠道。签名机设置 `APPLE_SIGNING_IDENTITY` 为本团队的 Developer ID Application 身份，并配置 Tauri 支持的 Apple 公证凭据，使构建出的 app 已装订公证票据。`BOWERBIRD_NOTARY_PROFILE` 指定本机 `notarytool` 已保存的钥匙串配置，用于 DMG 的公证与装订。正式流程对实际更新归档和挂载镜像中的 app 核对签名、Hardened Runtime、版本、架构和 Gatekeeper，再处理 DMG。跳过构建复用制品时也执行这些检查。操作参考 [Tauri 签名文档](https://v2.tauri.app/distribute/sign/macos/)。

本地开发仍可使用 `run-signed.sh`。测试分发脚本可设置 `BOWERBIRD_MAC_CHANNEL=local COS_SKIP_UPLOAD=1`，输出位于 `macOS/dist/local`。正式放行需分别保留两种架构的干净机安装、旧版升级和登录恢复记录，见 [发布验收](RELEASE-READINESS.md)。

使用 `installer/package-dmg.sh` 重新封装镜像后，将结果放到本版本的 Tauri DMG 输出位置，运行 `COS_SKIP_BUILD=1 COS_SKIP_UPLOAD=1 bash macOS/release.sh` 验证该镜像、更新归档、Apple 签名及公证票据。正式脚本打印专属的 `macOS/dist/release-<版本>-<架构>.<随机后缀>/`，保留本批已签名装订的 DMG、更新归档和 SHA256SUMS。一个工作区同时只允许一次发布构建。若进程被强制终止，先确认该工作区没有构建或挂载镜像，再移除遗留的空目录 `macOS/dist/.release-build.lock`。

## 一键发布到现役火山 TOS 和 CDN

`macOS/release.sh` 把发布串成一条命令（协议见 [DESKTOP-UPDATES.md](../dev-doc/DESKTOP-UPDATES.md)）：

```bash
bash macOS/release.sh <release-notes.txt>            # 完整：护栏→签名构建→归档校验→版本清单→上传→公网核对
BOWERBIRD_MAC_CHANNEL=local COS_SKIP_BUILD=1 COS_SKIP_UPLOAD=1 bash macOS/release.sh   # 本地测试渠道，复用产物
```

脚本在构建前及上传前读取指定架构的官网清单。网络故障、清单错误、同版及降版都停止。首次启用全新通道须单独确认初始权威基线，两个现役 Mac 通道均已有基线。正式构建通过公证后冻结六个文件。上传按版本命名，逐件使用 TOS 服务端禁止覆盖的 PUT，并从源站读回完整字节核对 SHA-256。已有同名文件仅可在哈希相同的情况下复用。最后一个对象为 `darwin-<arch>-<version>.json`，随后从 CDN 完整读取更新归档与 DMG，比对两份 SHA-256。官网切换前另行完成签名与实机验收。

一次性准备：

1. 在发布用 Python 虚拟环境执行 `python3 -m pip install tos==2.9.3`。桶必须从未开启版本控制。发布凭据需要读取桶版本状态、读取对象及发布对象的权限。开启或暂停版本控制、或无法判定时，脚本都会在第一件上传前停止。见火山引擎 [PutObject](https://docs.volcengine.com/docs/torch-object-storage/put-object) 和 [GetBucketVersioning](https://docs.volcengine.com/docs/torch-object-storage/get-bucket-versioning)。
2. 沿用根目录私有 `.env.tos` 或发布机环境中的 TOS_ACCESS_KEY_ID、TOS_SECRET_ACCESS_KEY、TOS_BUCKET、TOS_REGION、TOS_ENDPOINT。CDN 默认 `https://cdn.bowerbird.cn`。
3. 更新器私钥沿用 `macOS/.signing/updater.key`。

上传中断时，保留原冻结目录，使用同一 TOS 配置执行 `python3 macOS/upload_immutable.py upload <arch> <version> <冻结目录>`。它会重验线上版本、本地文件和已存在对象，再补齐缺件。渠道由官网发布侧核验后原子切换。离线 SDK 演练命令为 `python3 macOS/test_upload_immutable.py`。

## 视频封面隔离验证（2026-10-02）

当前封面取帧与缓存契约见 `PROJECT.md`「Mac 视频预览释放阻塞牵连整个界面」。Mac helper 由 `build.rs` 编译并静态链接，主程序 `--video-thumbnail-worker` 在任何应用初始化之前处理，无需额外 sidecar 或 FFmpeg。以下均使用合成素材/独立 WebKit 资料，不打开正式素材库：

```sh
# 仓库根；输出文件必须尚不存在
swift macOS/video-poster-fixture.swift '/tmp/bowerbird poster fixture.mov'
cd apps/desktop/src-tauri
cargo run --offline --example video_poster_smoke -- '/tmp/bowerbird poster fixture.mov' '/tmp/bowerbird poster fixture.jpg'
cargo test --offline --lib video_
cd ..
node scripts/media-previews-ui.test.mjs --native
```

合成短视频校验真实 H.264 解码、旋转后的尺寸与像素、坏文件回退；原生 UI 校验静态封面实际加载、去重/串行/过期结果、30 轮项目与素材列表挂载卸载和 5 轮主动播放器打开关闭。宿主会短暂显示隔离测试窗口，结束后恢复原应用焦点。无激活窗口可能延迟 IntersectionObserver/懒加载，系统将页面标记为隐藏时也会降速计时器；宿主保留每秒只读自动化查询、最多等待 150 秒，每 15 秒输出轮次，不要仅凭 90 秒超时判定媒体死锁。未覆盖真实项目长时间运行或播放后系统解码器释放。
