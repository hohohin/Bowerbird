# macOS 全量发布验收

此页由 Mac 发布团队持续维护。每个候选按 Apple Silicon 和 Intel 分别留证，记录候选提交、版本、测试环境、结果和证据位置。发布命令、参数及回滚流程统一见 [macOS 发布说明](README.md) 和 [桌面自动更新](../dev-doc/DESKTOP-UPDATES.md)。

## 当前基线

2026-11-21 从官网公开更新清单复核，Apple Silicon 为 **26.10.801**，Intel 为 **26.10.1501**。11 月 24 日以 ARM 公开归档中的工具实测，ARM 26.10.801 为 **0033**。Intel 26.10.1501 的源码记录为 **0034**。本轮 ARM 候选迁移终点为 **0062**。当前 Mac 公开包缺正式 Developer ID 签名及公证验收。提交新 Cloud 对话需要客户端支持 `dsh-vps-v2`，已有原单仍可按原身份查询。[Apple Silicon 清单](https://bowerbird.cn/api/desktop-update/darwin-aarch64) · [Intel 清单](https://bowerbird.cn/api/desktop-update/darwin-x86_64)

| 验收条件 | Apple Silicon | Intel | 测试方法与回执 |
|---|---|---|---|
| 冻结、构建和架构 | 待验 | 待验 | 用同一经核准的候选提交和版本，在对应 Mac 构建生产包。核对 DMG 和更新归档中的 app 版本、架构、候选提交与 SQLite 迁移终点，保留两种产物的 SHA-256。 |
| 正式签名、公证与启动 | 待验 | 待验 | 使用同一团队的 Developer ID Application、Hardened Runtime 和 Apple 公证流程。复验更新归档内 app 与 DMG 内 app 的签名、Gatekeeper 结果及公证票据，DMG 另验装订。保留 `codesign`、`spctl`、`stapler` 与 `notarytool` 回执。 |
| 全新安装 | 待验 | 待验 | 在干净账户从候选 DMG 拖到 Applications，首次通过 Gatekeeper 正常启动。确认无异常安全提示，使用专用账户登录，再退出并重开确认会话。 |
| 旧版应用内升级 | 26.10.801 → 候选，待验 | 26.10.1501 → 候选，待验 | 在独立测试账户和素材库中先运行该架构公开旧版。保留已连接目录、项目画板、历史任务及登录态基线，经测试通道从应用内检查更新、安装并重启。按架构记录 SQLite 到候选终点的实际版本、数据读写及钥匙串是否异常弹窗。失败时保留旧库和诊断。 |
| 原生功能与客户端兼容 | 待验 | 待验 | 在候选包检查 WKWebView 下的图片与音视频预览、截图、Plate 文档编辑与导出、探索页的点击和拖图、跨应用外拖及断开目录后恢复。用专用账号验证 DSH · Cloud 新对话和原单查询，分别记录真实授权、消息与恢复结果。 |
| TOS 权限与更新分发 | 待验 | 待验 | 由发布身份读取现役 TOS 桶版本状态。上次只读查询返回 403，使用已有授权身份或申请该查询的最小权限。批准后逐架构校验上传对象哈希、CDN 回读、原 updater 公钥、公网更新清单与回滚目标。 |

2026-11-20 在 Windows 重跑 Mac 双架构发布脚本夹具和 6 项 TOS SDK 模拟传输用例，全部通过。正式签名、公证、TOS 现役权限和两架构验收以发布团队的现场回执为准。

## 候选回执

### 2026-11-24 · Apple Silicon 26.11.2403 本地签名测试候选

本轮交付给另一终端独立验收和发布。基于 Mac `8ecc58bc` 合并 `dev@0d044e83017f`（包含 `7ce371ee0`）。Tauri、Cargo 和 Cargo.lock 的桌面版本均为 26.11.2403。Mac updater 配置沿用两父提交相同的 Git blob `48f53882`。Intel 按本轮范围跳过。

| 检查项 | ARM 回执与限制 |
|---|---|
| 编译环境 | macOS 27.2.1 (26B131)，arm64；rustc 1.97.1，commit `8bab26f4f68e0e26f0bb7960be334d5b520ea452`（2026-07-14），host `aarch64-apple-darwin`，LLVM 22.1.6。pnpm 11.10.0，Node 22.22.1。 |
| 静态检查与全量测试 | 锁定依赖安装、根级 lint、桌面 Vite 生产构建及 ARM cargo check 通过。最终源码 cargo test 为 **1427 passed / 0 failed / 55 ignored**。本机为媒体用例显式指定已有 FFmpeg、FFprobe。完整输出见 [Rust 回执](dist/verification/26.11.2403-aarch64/arm-rust-frozen-rerun.log)。 |
| Cloud 配置 | 候选使用构建机已有的 Supabase 公开 URL 和 publishable key，两者均已与官网公开配置逐值核对。未取得与服务端匹配的 `BOWERBIRD_ENTITLEMENT_PUBKEY`，本包离线权益宽限验签关闭。 |
| 升级迁移 | 26.10.801 原归档 SHA-256 `25f070734bb27ea22cf445372f97f6ae9dac4c04f68a174f28a2489cd89140c4`。用包内工具建立 0033 合成库，复制后经候选 Rust 迁移入口连续运行两次至 0062。目录、素材、项目、画板、节点、成员和历史任务一致，完整性正常、无外键违规。旧库仍为 0033。连接根表在 0048 引入。真实脱敏旧库及登录用户的应用内升级待实机验收。 |
| 视频与音频 | 系统 WKWebView 完成 30 轮媒体卡挂载和 5 轮播放器开合；真实 H.264 旋转封面、元数据、坏视频回退通过。指定本机 FFmpeg 后五种格式另存、覆盖、选区音标、时长和项目归属通过。 |
| 文档、截图与扩展 | Chromium 隔离用例验证截图工具条、Retina 像素和快捷键冲突恢复；Plate 导出 5 页 A4，验证文本、字体及图像。扩展 0.5.2 单测 35/35。正式浏览器扩展直入真实画板、WKWebView 中的文档编辑、系统截屏与桌面授权另行验收。 |
| 钥匙串、对话与更新 | 本机开发签名辅助程序用随机测试条目跨重编译读取、轮换与删除通过。对话逻辑 67/67；更新 UI 夹具覆盖下载、验签、安装重启及失败重试。专用账号的 DSH · Cloud v2 新对话／中断恢复／历史原单、旧正式客户端登录态和干净账户升级尚缺现场回执。 |
| 前端基线差异 | 画板逻辑套件 141/150。9 个失败断言在同一 dev 来源复现：2 个查找旧卡片渲染源码，4 个框选夹具缺 useStore，2 个撤销夹具缺 workflowInteractive，1 个仍引用旧点击流程变量。截图、PDF、更新、资产菜单与草稿选择专项通过。 |
| 探索与画板 | 系统 WKWebView 和正式遮罩、拖图脚本在本地页面接到 3 次受信点击，遮罩孔将 1 次点击交给底层。页面滚动后仍可点击。Chromium 夹具的图片、视频拖动与选区通过。画板接收音频覆盖完成事件后，同一卡片从 12 秒刷新为 4 秒。真实登录站点跨 WebView 拖放及完整应用中的点击问题待验。 |
| 文件系统 | 修复登记原件的系统路径别名匹配，复用既有 Mac 系统别名展开函数。本机复现的“字节数、修改时间相同的原件更新未刷新语义索引”已通过原回归。 |
| HEIC 广色域与 HDR 输入 | 使用 8-bit Display P3、10-bit BT.2100 PQ 合成色条，修复 Mac 预览偏色，JPEG 缩略图转换为 sRGB。与 Apple SDR 输出比较，两张全图六块色条的最大线性 BT.2020 通道误差均为 0.000，JPEG 分别为 0.00431 和 0.00732。7 项 HEIC 专项通过。本次测量覆盖 SDR 预览，屏幕 HDR 亮度未验。 |
| 外拖与断开重连 | Rust 外拖会话、取消、拖影与目录离线／重接／升级后索引保留夹具通过。拖到 Finder 的实际跨进程交付、真实外盘拔插待验。 |

本机回执保存在 [ARM 验收目录](dist/verification/26.11.2403-aarch64/)，含原始 Rust 工具链、迁移比对、媒体测试和界面测试记录。

#### 安装包与更新归档

冻结源码为 `ac3d2e6a38fa64d90028202ac7f77227aa8d1165`。最终 DMG 使用 `Bowerbird Local Code Signing`，通过 `codesign --verify --deep --strict`，无 Apple 公证。挂载镜像实读窗口 660×400、图标 (180,190)/(480,190)、背景和 /Applications 链接。归档内 85 个文件与挂载 app 字节一致，包内扩展为 0.5.2，更新包通过原 Mac updater 公钥验签。用挂载镜像的迁移工具再次在旧包合成库副本上迁移、重跑，最终 0062、完整性及外键检查通过。[镜像回执](dist/verification/26.11.2403-aarch64/signed-dmg.json)

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `Bowerbird_26.11.2403_aarch64-updater-installer.dmg` | 112,948,689 | `2204a07cb8f79317997bd0d9da1274278b14b8bd604caa032335c5e205e208a6` |
| `Bowerbird_26.11.2403_aarch64.app.tar.gz` | 112,623,138 | `a3d3c340767d40347b9baea72e65858f57073402106a8a94c409220c40c4d93e` |

R2 独立前缀为 `mac_package/testing/26.11.2403-aarch64-a3d3c340767d/`。7 个对象以禁止覆盖的条件写入，随后从公网完整下载并逐件核对长度、SHA-256，回读的归档及签名通过原公钥验签。[DMG](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/testing/26.11.2403-aarch64-a3d3c340767d/Bowerbird_26.11.2403_aarch64-updater-installer.dmg) · [测试清单](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/testing/26.11.2403-aarch64-a3d3c340767d/darwin-aarch64-26.11.2403.json) · [SHA256SUMS](https://pub-5e4c00c218cd4682b622cbab5e58563e.r2.dev/mac_package/testing/26.11.2403-aarch64-a3d3c340767d/SHA256SUMS) · [逐件回执](dist/verification/26.11.2403-aarch64/r2-readback.json)

官网由另一终端发布。本轮 15:43:58（北京时间）只读复核时，ARM 为 26.10.801，Intel 为 26.10.1501，Windows 为 26.11.2402；两条 Mac 路由 GET/HEAD 均返回 307 与 no-store。现役旧包均经 CDN 分发。[公网基线](dist/verification/26.11.2403-aarch64/public-channels.json)
